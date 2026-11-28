import type {
  ActionItem,
  AgendaProgress,
  Assumption,
  Copilot,
  Decision,
  EarlierItemRef,
  GoalProgress,
  Insights,
  KeyPoint,
  ModelOutput,
  OpenQuestion,
  PastDecisionRef,
  Risk,
  Topic,
} from './schema.js';
import type { AgendaPlan } from '../prep.js';

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
  /** Host's preparation; progress is only tracked against these. */
  goal?: string;
  agendaPlan?: AgendaPlan[];
  /** Agreed decisions from earlier meetings, referenced by the model as P1, P2, … */
  pastDecisions?: PastDecisionRef[];
  /** Open tasks / risks from earlier meetings, referenced by the model as E1, E2, … */
  earlierItems?: EarlierItemRef[];
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
  const past = new Map((ctx.pastDecisions ?? []).map((p) => [p.ref.toUpperCase(), p]));
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
      // Once spotted, a conflict stays visible (the model may stop repeating it on later runs).
      contradicts: past.get((d.contradicts ?? '').trim().toUpperCase()) ?? old?.contradicts ?? null,
      evidence: evidence([...(old?.evidence ?? []), ...d.evidence]),
      firstSeenAt: old?.firstSeenAt ?? now,
      updatedAt: now,
      settledAt: d.status === 'agreed' || d.status === 'rejected' ? old?.settledAt ?? now : null,
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

  // ---- key points ----
  const prevPoints = new Map((prev.keyPoints ?? []).map((k) => [k.id, k]));
  const pointId = nextIdFactory('k', prevPoints.keys());
  const keyPoints: KeyPoint[] = [];
  for (const k of out.keyPoints ?? []) {
    const point = clean(k.point);
    if (!point) continue;
    const old = prevPoints.get(k.id);
    const id = old ? k.id : pointId();
    prevPoints.delete(id);
    keyPoints.push({ id, point, importance: k.importance, evidence: evidence([...(old?.evidence ?? []), ...k.evidence]) });
  }
  keyPoints.push(...prevPoints.values());

  // ---- assumptions ----
  const prevAssumptions = new Map((prev.assumptions ?? []).map((a) => [a.id, a]));
  const assumptionId = nextIdFactory('s', prevAssumptions.keys());
  const assumptions: Assumption[] = [];
  for (const a of out.assumptions ?? []) {
    const statement = clean(a.statement);
    if (!statement) continue;
    const old = prevAssumptions.get(a.id);
    const id = old ? a.id : assumptionId();
    prevAssumptions.delete(id);
    assumptions.push({ id, statement, madeBy: clean(a.madeBy), status: a.status, evidence: evidence([...(old?.evidence ?? []), ...a.evidence]) });
  }
  assumptions.push(...prevAssumptions.values());

  // ---- risks & conflicts ----
  const earlier = new Map((ctx.earlierItems ?? []).map((e) => [e.ref.toUpperCase(), e]));
  const knownIds = new Set([...decisions.map((d) => d.id), ...actionItems.map((a) => a.id), ...openQuestions.map((q) => q.id)]);
  const prevRisks = new Map((prev.risks ?? []).map((r) => [r.id, r]));
  const riskId = nextIdFactory('r', prevRisks.keys());
  const risks: Risk[] = [];
  for (const r of out.risks ?? []) {
    const description = clean(r.description);
    if (!description) continue;
    const old = prevRisks.get(r.id);
    const id = old ? r.id : riskId();
    prevRisks.delete(id);
    risks.push({
      id,
      kind: r.kind,
      description,
      involves: uniq(r.involves),
      relatedItems: uniq(r.relatedItems).filter((x) => knownIds.has(x)),
      earlier: earlier.get((r.earlierRef ?? '').trim().toUpperCase()) ?? old?.earlier ?? null,
      severity: r.severity,
      suggestedQuestion: r.status === 'resolved' ? null : clean(r.suggestedQuestion),
      status: r.status,
      evidence: evidence([...(old?.evidence ?? []), ...r.evidence]),
      firstSeenAt: old?.firstSeenAt ?? now,
      updatedAt: now,
    });
  }
  risks.push(...prevRisks.values());

  return {
    summary: clean(out.summary) ?? prev.summary,
    keyPoints,
    assumptions,
    risks,
    copilot: mergeCopilot(prev.copilot ?? null, out, now),
    topics,
    decisions,
    actionItems,
    openQuestions,
    goal: mergeGoal(prev.goal, out, ctx),
    agenda: mergeAgenda(prev.agenda, out, ctx),
    carryover: prev.carryover ?? null,
    analyzedThrough: Math.max(prev.analyzedThrough, ctx.analyzedThrough),
    updatedAt: now,
  };
}

/** The copilot is a live view: each run replaces it (an empty run keeps the last one). */
function mergeCopilot(prev: Copilot | null, out: ModelOutput, now: string): Copilot | null {
  const c = out.copilot;
  if (!c) return prev;
  const list = (xs: string[]) => uniq(xs).slice(0, 5);
  return {
    currentFocus: clean(c.currentFocus) ?? '',
    offTopic: !!c.offTopic,
    offTopicNote: c.offTopic ? clean(c.offTopicNote) ?? '' : '',
    missingInfo: list(c.missingInfo),
    suggestedQuestions: list(c.suggestedQuestions).slice(0, 3),
    discussNext: clean(c.discussNext) ?? '',
    agendaAdvice: clean(c.agendaAdvice) ?? '',
    updatedAt: now,
  };
}

/** Goal progress: keeps `since` while the status is unchanged so "off track for 6 minutes" works. */
function mergeGoal(prev: GoalProgress | null, out: ModelOutput, ctx: NormalizeContext): GoalProgress | null {
  const text = (ctx.goal ?? '').trim();
  if (!text) return null;
  const now = ctx.now.toISOString();
  const status = out.progress?.goalStatus && out.progress.goalStatus !== 'no_goal' ? out.progress.goalStatus : prev?.status ?? 'on_track';
  const reason = clean(out.progress?.goalReason) ?? (status === prev?.status ? prev.reason : '');
  return {
    text,
    status,
    reason: reason ?? '',
    since: prev && prev.status === status && prev.text === text ? prev.since : now,
  };
}

/** Agenda progress, keyed by the host's agenda ids; unknown ids from the model are ignored. */
function mergeAgenda(prev: AgendaProgress[], out: ModelOutput, ctx: NormalizeContext): AgendaProgress[] {
  const plan = ctx.agendaPlan ?? [];
  const now = ctx.now.toISOString();
  const before = new Map(prev.map((a) => [a.id, a]));
  const reported = new Map((out.progress?.agenda ?? []).map((a) => [a.id, a]));
  return plan.map((item) => {
    const old = before.get(item.id);
    const r = reported.get(item.id);
    let status = r?.status ?? old?.status ?? 'not_started';
    // Never move a finished item backwards on a noisy run.
    if ((old?.status === 'done' || old?.status === 'skipped') && status === 'not_started') status = old.status;
    const startedAt = old?.startedAt ?? (status !== 'not_started' && status !== 'skipped' ? now : null);
    const doneAt = status === 'done' ? old?.doneAt ?? now : null;
    return {
      id: item.id,
      title: item.title,
      minutes: item.minutes,
      status,
      note: clean(r?.note) ?? old?.note ?? '',
      startedAt,
      doneAt,
    };
  });
}
