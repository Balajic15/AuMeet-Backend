import type { Insights } from './schema.js';

const names = (xs: string[]) => xs.join(', ');

/** Compact plain-text notes added to the voice assistant's instructions. */
export function renderNotes(i: Insights): string {
  const lines: string[] = [];
  if (i.summary) lines.push(`Summary so far: ${i.summary}`);

  const decisions = i.decisions.filter((d) => d.status !== 'rejected');
  if (decisions.length) {
    lines.push('Decisions:');
    for (const d of decisions) {
      let s = `- [${d.status.toUpperCase()}] ${d.statement}`;
      if (d.status === 'disputed' && d.options.length) s += ` (options: ${names(d.options)})`;
      if (d.supporters.length) s += `; supported by ${names(d.supporters)}`;
      if (d.objectors.length) s += `; objections from ${names(d.objectors)}`;
      lines.push(s);
    }
  }

  const open = i.actionItems.filter((a) => a.status === 'open');
  if (open.length) {
    lines.push('Open tasks:');
    for (const a of open) {
      lines.push(`- ${a.task} — ${a.owner ?? 'no owner yet'}${a.deadline ? `, ${a.deadline}` : ''}`);
    }
  }

  const qs = i.openQuestions.filter((q) => q.status === 'open');
  if (qs.length) {
    lines.push('Unanswered questions:');
    for (const q of qs) lines.push(`- ${q.question}${q.askedBy ? ` (asked by ${q.askedBy})` : ''}`);
  }

  return lines.join('\n');
}
