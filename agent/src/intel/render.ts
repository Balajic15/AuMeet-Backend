import type { Insights } from './schema.js';

const names = (xs: string[]) => xs.join(', ');

/** Compact plain-text notes added to the voice assistant's instructions. */
export function renderNotes(i: Insights): string {
  const lines: string[] = [];
  if (i.summary) lines.push(`Summary so far: ${i.summary}`);
  if (i.goal) lines.push(`Goal progress: ${i.goal.status.replace('_', ' ')}${i.goal.reason ? ` – ${i.goal.reason}` : ''}`);
  if (i.agenda.length) {
    lines.push('Agenda progress:');
    for (const a of i.agenda) lines.push(`- ${a.title}: ${a.status.replace('_', ' ')}${a.note ? ` (${a.note})` : ''}`);
  }

  const decisions = i.decisions.filter((d) => d.status !== 'rejected' && d.status !== 'superseded');
  if (decisions.length) {
    lines.push('Decisions:');
    for (const d of decisions) {
      let s = `- [${d.status.toUpperCase()}${d.finality && d.finality !== 'final' ? `, ${d.finality.toUpperCase()}` : ''}] ${d.statement}`;
      if (d.condition) s += ` (only if ${d.condition})`;
      if (d.reversed) s += ' – changed during this meeting';
      if (d.status === 'disputed' && d.options.length) s += ` (options: ${names(d.options)})`;
      if (d.supporters.length) s += `; supported by ${names(d.supporters)}`;
      if (d.objectors.length) s += `; objections from ${names(d.objectors)}`;
      if (d.contradicts) s += ` – CONFLICTS with the decision of ${d.contradicts.date}: "${d.contradicts.statement}"`;
      lines.push(s);
    }
  }

  const open = i.actionItems.filter((a) => a.status === 'open');
  if (open.length) {
    lines.push('Open tasks:');
    for (const a of open) {
      lines.push(`- ${a.task} — ${a.owner ?? 'no owner yet'}${a.deadline ? `, ${a.deadline}` : ''}${a.commitment === 'tentative' ? ' (tentative)' : ''}`);
    }
  }

  const qs = i.openQuestions.filter((q) => q.status === 'open');
  if (qs.length) {
    lines.push('Unanswered questions:');
    for (const q of qs) lines.push(`- ${q.question}${q.askedBy ? ` (asked by ${q.askedBy})` : ''}`);
  }

  const changes = i.statementChanges ?? [];
  if (changes.length) {
    lines.push('Changed positions and corrections:');
    for (const c of changes) lines.push(`- ${c.person} ${c.kind === 'corrected' ? 'corrected' : 'changed position on'} ${c.topic || 'a point'}: "${c.before}" → "${c.after}"`);
  }

  const risks = (i.risks ?? []).filter((r) => r.status === 'open');
  if (risks.length) {
    lines.push('Risks and conflicts (open):');
    for (const r of risks) {
      let s = `- [${r.kind.toUpperCase()}, ${r.severity}] ${r.description}`;
      if (r.earlier) s += ` – repeats/depends on "${r.earlier.text}" from ${r.earlier.date}`;
      if (r.suggestedQuestion) s += ` (to clarify: ${r.suggestedQuestion})`;
      lines.push(s);
    }
  }

  const assumed = (i.assumptions ?? []).filter((a) => a.status === 'unverified');
  if (assumed.length) {
    lines.push('Unverified assumptions:');
    for (const a of assumed) lines.push(`- ${a.statement}${a.madeBy ? ` (${a.madeBy})` : ''}`);
  }

  const points = (i.keyPoints ?? []).filter((k) => k.importance === 'high');
  if (points.length) {
    lines.push('Key points:');
    for (const k of points) lines.push(`- ${k.point}`);
  }

  const c = i.copilot;
  if (c) {
    const parts: string[] = [];
    if (c.currentFocus) parts.push(`Now discussing: ${c.currentFocus}${c.offTopic ? ` (OFF TOPIC${c.offTopicNote ? `: ${c.offTopicNote}` : ''})` : ''}`);
    if (c.missingInfo.length) parts.push(`Missing information: ${c.missingInfo.join('; ')}`);
    if (c.discussNext) parts.push(`Suggested next: ${c.discussNext}`);
    if (c.agendaAdvice) parts.push(`Agenda advice: ${c.agendaAdvice}`);
    if (parts.length) lines.push('Copilot view:', ...parts.map((x) => `- ${x}`));
  }

  return lines.join('\n');
}
