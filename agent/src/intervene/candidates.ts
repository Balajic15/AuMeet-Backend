import type { Insights } from '../intel/schema.js';
import type { Utterance } from '../transcript.js';

export type CandidateKind = 'confirm_decision' | 'assign_owner' | 'summarize_dispute';

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
}

export const DEFAULT_TIMING: CandidateTiming = {
  confirmAfterMs: 15_000,
  ownerAfterMs: 45_000,
  circlingAfterMs: 4 * 60_000,
  circlingMinLines: 15,
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

  return out.sort((x, y) => y.priority - x.priority);
}
