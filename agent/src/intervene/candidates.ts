import type { Insights } from '../intel/schema.js';
import type { Utterance } from '../transcript.js';

export type CandidateKind =
  | 'confirm_decision'
  | 'assign_owner'
  | 'summarize_dispute'
  | 'off_track'
  | 'over_time'
  | 'time_running_out';

export interface Candidate {
  /** Stable key so the same issue is raised at most once. */
  key: string;
  kind: CandidateKind;
  /** Higher goes first. */
  priority: number;
  /** What the AI wants to achieve, for the judge. */
  goal: string;
  /** A ready-made line to fall back on / steer the phrasing. */
  suggestion: string;
}

export interface CandidateTiming {
  /** A disputed decision must have been around this long before asking (people may still be resolving it). */
  confirmAfterMs: number;
  /** An unowned task must have been around this long before asking who takes it. */
  ownerAfterMs: number;
  /** A dispute this old, with this many human lines since, suggests the discussion is going in circles. */
  circlingAfterMs: number;
  circlingMinLines: number;
  /** Off the goal for this long before nudging; nudge again at most this often. */
  offTrackAfterMs: number;
  offTrackRepeatMs: number;
  /** Nudge once an agenda item runs this far past its time box. */
  overTimeGraceMs: number;
  /** "Time running out" once this share of the planned agenda time is used. */
  timeLeftShare: number;
}

export const DEFAULT_TIMING: CandidateTiming = {
  confirmAfterMs: 15_000,
  ownerAfterMs: 45_000,
  circlingAfterMs: 4 * 60_000,
  circlingMinLines: 15,
  offTrackAfterMs: 3 * 60_000,
  offTrackRepeatMs: 10 * 60_000,
  overTimeGraceMs: 2 * 60_000,
  timeLeftShare: 0.85,
};

/**
 * Rule-based shortlist of things worth raising. Cheap and predictable; the model then
 * judges whether *now* is a good moment and how to say it.
 */
export function findCandidates(
  insights: Insights,
  transcript: readonly Utterance[],
  now: number,
  alreadyRaised: ReadonlySet<string>,
  timing: CandidateTiming = DEFAULT_TIMING,
): Candidate[] {
  const out: Candidate[] = [];
  const age = (iso: string) => now - Date.parse(iso);
  const humanLinesSince = (iso: string) => {
    const t = Date.parse(iso);
    return transcript.filter((u) => !u.isAgent && u.at >= t).length;
  };

  for (const d of insights.decisions) {
    if (d.status !== 'disputed' && d.status !== 'proposed') continue;

    if (d.confirmationNeeded && age(d.firstSeenAt) >= timing.confirmAfterMs) {
      const key = `confirm:${d.id}`;
      if (!alreadyRaised.has(key)) {
        out.push({
          key,
          kind: 'confirm_decision',
          priority: d.status === 'disputed' ? 30 : 20,
          goal:
            `The decision "${d.statement}" is ${d.status === 'disputed' ? 'disputed' : 'only proposed'}` +
            (d.options.length ? ` (options: ${d.options.join(' vs ')})` : '') +
            ' and was never explicitly confirmed. Ask the group to confirm.',
          suggestion: d.confirmationNeeded,
        });
      }
    }

    if (
      d.status === 'disputed' &&
      age(d.firstSeenAt) >= timing.circlingAfterMs &&
      humanLinesSince(d.firstSeenAt) >= timing.circlingMinLines
    ) {
      const key = `circling:${d.id}`;
      if (!alreadyRaised.has(key)) {
        out.push({
          key,
          kind: 'summarize_dispute',
          priority: 10,
          goal:
            `The group has been going back and forth on "${d.statement}" for several minutes without resolving it. ` +
            'Briefly summarise each side in one sentence each and suggest how to settle it (e.g. decide now or take it offline).',
          suggestion: `It sounds like we're still split on ${d.statement.toLowerCase()}. Want me to summarise both sides?`,
        });
      }
    }
  }

  for (const a of insights.actionItems) {
    if (a.status !== 'open' || a.owner || age(a.firstSeenAt) < timing.ownerAfterMs) continue;
    const key = `owner:${a.id}`;
    if (alreadyRaised.has(key)) continue;
    out.push({
      key,
      kind: 'assign_owner',
      priority: 15,
      goal: `The task "${a.task}" came up but nobody has taken ownership. Ask who will own it.`,
      suggestion: `Quick check: who's taking "${a.task}"?`,
    });
  }

  // ---- keeping the meeting on track (only with a goal / agenda) ----
  const g = insights.goal;
  if (g && (g.status === 'off_track' || g.status === 'drifting') && age(g.since) >= timing.offTrackAfterMs) {
    // Re-raise at most every offTrackRepeatMs (the bucket changes the key).
    const key = `offtrack:${Math.floor(now / timing.offTrackRepeatMs)}`;
    if (!alreadyRaised.has(key)) {
      const next = insights.agenda.find((a) => a.status === 'not_started' || a.status === 'in_progress');
      out.push({
        key,
        kind: 'off_track',
        priority: g.status === 'off_track' ? 25 : 12,
        goal:
          `The meeting goal is "${g.text}", but the discussion has been ${g.status.replace('_', ' ')} for ${Math.round(age(g.since) / 60_000)} minutes (${g.reason || 'not related to the goal'}). Gently steer back to the goal${next ? `, e.g. the agenda item "${next.title}"` : ''}.`,
        suggestion: `Quick check: we set out to ${g.text.replace(/[.!]$/, '').toLowerCase()}. Shall we get back to that${next ? ` – next up is ${next.title}` : ''}?`,
      });
    }
  }

  for (const a of insights.agenda) {
    if (a.status !== 'in_progress' || !a.minutes || !a.startedAt) continue;
    if (age(a.startedAt) < a.minutes * 60_000 + timing.overTimeGraceMs) continue;
    const key = `overtime:${a.id}`;
    if (alreadyRaised.has(key)) continue;
    out.push({
      key,
      kind: 'over_time',
      priority: 22,
      goal: `The agenda item "${a.title}" was planned for ${a.minutes} minutes and has taken about ${Math.round(age(a.startedAt) / 60_000)}. Point this out and ask whether to wrap it up or continue.`,
      suggestion: `We're a bit over time on ${a.title}. Should we wrap it up and move on, or keep going?`,
    });
  }

  const planned = insights.agenda.reduce((sum, a) => sum + (a.minutes ?? 0), 0);
  const firstLine = transcript.find((u) => !u.isAgent);
  const pendingItems = insights.agenda.filter((a) => a.status === 'not_started');
  if (planned > 0 && firstLine && pendingItems.length && !alreadyRaised.has('timeleft')) {
    const used = now - firstLine.at;
    if (used >= planned * 60_000 * timing.timeLeftShare) {
      const left = Math.max(0, Math.round(planned - used / 60_000));
      out.push({
        key: 'timeleft',
        kind: 'time_running_out',
        priority: 24,
        goal: `About ${left} minutes of the planned ${planned} are left, and these agenda items haven't started: ${pendingItems.map((a) => a.title).join(', ')}. Tell the group and ask how they want to use the remaining time.`,
        suggestion: `Heads-up: about ${left} minutes left and we haven't covered ${pendingItems.map((a) => a.title).join(' or ')} yet. How do you want to use the time?`,
      });
    }
  }

  return out.sort((x, y) => y.priority - x.priority);
}
