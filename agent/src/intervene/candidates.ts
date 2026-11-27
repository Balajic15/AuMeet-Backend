import type { Insights } from '../intel/schema.js';
import type { Utterance } from '../transcript.js';

export type CandidateKind =
  | 'confirm_decision'
  | 'assign_owner'
  | 'summarize_dispute'
  | 'off_track'
  | 'over_time'
  | 'time_running_out'
  | 'carryover'
  | 'contradiction'
  | 'open_meeting'
  | 'agenda_next'
  | 'wrap_up';

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
  /** Shorter gap after the AI last spoke than the default cooldown (facilitation, follow-ups). */
  minGapMs?: number;
  /** More tries than the default when the judge says "not now". */
  maxAttempts?: number;
  /** Longer than one or two sentences (opening, wrap-up): spoken as a generated reply from the goal. */
  longForm?: boolean;
}

export interface CandidateContext {
  /** Host turned on facilitator mode: open, announce transitions, wrap up. */
  facilitator?: boolean;
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
  context: CandidateContext = {},
): Candidate[] {
  const out: Candidate[] = [];
  const facilitator = !!context.facilitator;
  const humanLines = transcript.filter((u) => !u.isAgent);
  const started = humanLines[0]?.at ?? null;
  const elapsed = started === null ? 0 : now - started;
  const planned = insights.agenda.reduce((sum, a) => sum + (a.minutes ?? 0), 0);
  const c = insights.carryover;
  const carryoverText = c
    ? [
        ...c.tasks.map((t) => `${t.owner ?? 'nobody'} had "${t.task}"${t.dueDate ? ` due ${t.dueDate}${t.overdue ? ' (overdue)' : ''}` : ''}`),
        ...c.decisions.map((d) => `"${d.statement}" was left undecided`),
      ].join('; ')
    : '';

  // ---- facilitator: opening ----
  // Early in the meeting only (someone switching the mode on mid-meeting gets no opening).
  if (facilitator && !alreadyRaised.has('open') && humanLines.length < 15 && elapsed < 5 * 60_000) {
    const agendaText = insights.agenda
      .map((a) => `${a.title}${a.minutes ? ` (${a.minutes} min)` : ''}`)
      .join(', ');
    out.push({
      key: 'open',
      kind: 'open_meeting',
      priority: 50,
      minGapMs: 0,
      maxAttempts: 4,
      longForm: true,
      goal:
        'Open the meeting as its facilitator in at most three short spoken sentences: ' +
        (insights.goal ? `the goal is "${insights.goal.text}"; ` : '') +
        (agendaText ? `the agenda is ${agendaText}${planned ? ` – ${planned} minutes in total` : ''}; ` : '') +
        (carryoverText ? `open from last time: ${carryoverText}; ` : '') +
        'then invite the group to start with the first item.',
      suggestion: insights.goal ? `Welcome! Today we want to ${insights.goal.text.replace(/[.!]$/, '').toLowerCase()}. Shall we start?` : 'Welcome! Shall we get started?',
    });
  }

  // ---- continuity: follow up on last meeting (the opening covers it in facilitator mode) ----
  if (c && carryoverText && !facilitator && !alreadyRaised.has('carryover') && humanLines.length >= 1 && elapsed < 10 * 60_000) {
    out.push({
      key: 'carryover',
      kind: 'carryover',
      priority: 45,
      minGapMs: 20_000,
      maxAttempts: 3,
      goal: `Follow up on what was left open at the previous meeting ("${c.fromTitle}", ${c.fromDate}): ${carryoverText}. Ask briefly for the status, naming the owners.`,
      suggestion: `Before we dive in – from last time, ${carryoverText}. Any updates?`,
    });
  }

  // ---- contradictions with earlier agreed decisions ----
  for (const d of insights.decisions) {
    if (!d.contradicts || d.status === 'rejected') continue;
    const key = `contradiction:${d.id}`;
    if (alreadyRaised.has(key)) continue;
    out.push({
      key,
      kind: 'contradiction',
      priority: 32,
      minGapMs: 30_000,
      goal: `The group is now heading towards "${d.statement}", but on ${d.contradicts.date} ("${d.contradicts.title}") it agreed "${d.contradicts.statement}". Point this out neutrally and ask whether they are deliberately changing that decision.`,
      suggestion: `Just flagging: on ${d.contradicts.date} we agreed to ${d.contradicts.statement.replace(/[.!]$/, '').toLowerCase()}. Are we changing that?`,
    });
  }
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

  // ---- facilitator: agenda transitions and wrap-up ----
  if (facilitator) {
    const done = insights.agenda.filter((a) => a.status === 'done' && a.doneAt).sort((a, b) => Date.parse(b.doneAt!) - Date.parse(a.doneAt!))[0];
    const inProgress = insights.agenda.some((a) => a.status === 'in_progress');
    const next = insights.agenda.find((a) => a.status === 'not_started');
    if (done && next && !inProgress && !alreadyRaised.has(`next:${done.id}`)) {
      out.push({
        key: `next:${done.id}`,
        kind: 'agenda_next',
        priority: 27,
        minGapMs: 20_000,
        maxAttempts: 3,
        goal: `The agenda item "${done.title}" is finished${done.note ? ` (${done.note})` : ''}. As facilitator, close it in a few words and move the group on to the next item, "${next.title}"${next.minutes ? ` (${next.minutes} minutes)` : ''}.`,
        suggestion: `That covers ${done.title}. Next up: ${next.title}${next.minutes ? `, ${next.minutes} minutes` : ''}.`,
      });
    }
    if (planned >= 4 && started !== null && elapsed >= (planned - 2) * 60_000 && !alreadyRaised.has('wrapup')) {
      out.push({
        key: 'wrapup',
        kind: 'wrap_up',
        priority: 48,
        minGapMs: 15_000,
        maxAttempts: 4,
        longForm: true,
        goal:
          'The planned time is almost over. As facilitator, give a spoken wrap-up of about thirty seconds from the CURRENT MEETING NOTES: ' +
          'what was agreed (and what is still undecided), each open task with its owner and due date, and what remains open. ' +
          'End by asking whether anything is missing. No lists or markdown – natural sentences.',
        suggestion: 'We are nearly out of time – let me quickly recap what we agreed and who is doing what.',
      });
    }
  }

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
