import type { ActionItem, Decision, Insights, ModelOutput, OpenQuestion, Topic } from './schema.js';

export interface Person {
  identity: string;
  name: string;
  userId: string | null;
}

export interface NormalizeContext {
  /** Transcript line numbers that exist (evidence must point at real lines). */
  validLines: Set<number>;
  people: Person[];
  analyzedThrough: number;
  now: Date;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (s: string | undefined | null): string | null => {
  const t = (s ?? '').trim();
  return t ? t : null;
};

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

function nextIdFactory(prefix: string, existing: Iterable<string>) {
  let max = 0;
  for (const id of existing) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return () => `${prefix}${++max}`;
}

/** Match a spoken/typed name to a participant: exact, then first name, case-insensitive. */
export function matchPerson(name: string | null, people: Person[]): Person | null {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  const exact = people.find((p) => p.name.toLowerCase() === n);
  if (exact) return exact;
  const byFirst = people.filter((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
  return byFirst.length === 1 ? byFirst[0]! : null;
}

/**
 * Merge the model's view into the previous state:
 * - ids are kept when the model returns a known id, otherwise assigned (d1, t1, …)
 * - items the model forgot to return are kept unchanged – nothing disappears silently
 * - evidence must reference real transcript lines
 */
export function normalize(prev: Insights, out: ModelOutput, ctx: NormalizeContext): Insights {
  const now = ctx.now.toISOString();
  const evidence = (xs: number[]) => [...new Set(xs)].filter((n) => ctx.validLines.has(n)).sort((a, b) => a - b);

  // ---- topics ----
  const prevTopics = new Map(prev.topics.map((t) => [t.id, t]));
  const topicId = nextIdFactory('p', prevTopics.keys());
  const topics: Topic[] = [];
  for (const t of out.topics) {
    const title = clean(t.title);
    if (!title) continue;
    const id = prevTopics.has(t.id) ? t.id : topicId();
    prevTopics.delete(id);
    topics.push({ id, title, status: t.status });
  }
  topics.push(...prevTopics.values());

  // ---- decisions ----
  const prevDecisions = new Map(prev.decisions.map((d) => [d.id, d]));
  const decisionId = nextIdFactory('d', prevDecisions.keys());
  const decisions: Decision[] = [];
  for (const d of out.decisions) {
    const statement = clean(d.statement);
    if (!statement) continue;
    const old = prevDecisions.get(d.id);
    const id = old ? d.id : decisionId();
    prevDecisions.delete(id);
    decisions.push({
      id,
      topic: clean(d.topic) ?? '',
      statement,
      status: d.status,
      options: uniq(d.options),
      proposedBy: uniq(d.proposedBy),
      supporters: uniq(d.supporters),
      objectors: uniq(d.objectors),
      // Only an unsettled decision can need confirmation.
      confirmationNeeded: d.status === 'agreed' || d.status === 'rejected' ? null : clean(d.confirmationNeeded),
      evidence: evidence([...(old?.evidence ?? []), ...d.evidence]),
      firstSeenAt: old?.firstSeenAt ?? now,
      updatedAt: now,
    });
  }
  decisions.push(...prevDecisions.values());

  // ---- action items ----
  const prevActions = new Map(prev.actionItems.map((a) => [a.id, a]));
  const actionId = nextIdFactory('t', prevActions.keys());
  const actionItems: ActionItem[] = [];
  for (const a of out.actionItems) {
    const task = clean(a.task);
    if (!task) continue;
    const old = prevActions.get(a.id);
    const id = old ? a.id : actionId();
    prevActions.delete(id);
    const owner = clean(a.owner);
    const person = matchPerson(owner, ctx.people);
    const due = clean(a.dueDate);
    actionItems.push({
      id,
      task,
      owner: person?.name ?? owner,
      ownerIdentity: person?.identity ?? null,
      ownerUserId: person?.userId ?? null,
      deadline: clean(a.deadline),
      dueDate: due && DATE_RE.test(due) && !Number.isNaN(Date.parse(due)) ? due : null,
      status: a.status,
      evidence: evidence([...(old?.evidence ?? []), ...a.evidence]),
      firstSeenAt: old?.firstSeenAt ?? now,
      updatedAt: now,
    });
  }
  actionItems.push(...prevActions.values());

  // ---- open questions ----
  const prevQs = new Map(prev.openQuestions.map((q) => [q.id, q]));
  const qId = nextIdFactory('q', prevQs.keys());
  const openQuestions: OpenQuestion[] = [];
  for (const q of out.openQuestions) {
    const question = clean(q.question);
    if (!question) continue;
    const old = prevQs.get(q.id);
    const id = old ? q.id : qId();
    prevQs.delete(id);
    openQuestions.push({
      id,
      question,
      askedBy: clean(q.askedBy),
      status: q.status,
      evidence: evidence([...(old?.evidence ?? []), ...q.evidence]),
    });
  }
  openQuestions.push(...prevQs.values());

  return {
    summary: clean(out.summary) ?? prev.summary,
    topics,
    decisions,
    actionItems,
    openQuestions,
    analyzedThrough: Math.max(prev.analyzedThrough, ctx.analyzedThrough),
    updatedAt: now,
  };
}
