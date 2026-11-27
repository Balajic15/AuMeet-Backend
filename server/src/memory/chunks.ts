import type { Recap, SessionDoc, TranscriptRow } from './types.js';

export interface ChunkDraft {
  kind: 'recap' | 'decision' | 'task' | 'transcript';
  ref: string;
  text: string;
}

const WINDOW = 12; // transcript lines per chunk
const OVERLAP = 2;
const MAX_CHARS = 2000;

export function dateLabel(d: Date | undefined): string {
  return d ? d.toISOString().slice(0, 10) : 'unknown date';
}

/**
 * Turns one finished session into self-contained, searchable texts. Each chunk names the
 * meeting and date so a match makes sense on its own ("…decided in Sprint planning on …").
 */
export function buildChunks(session: SessionDoc, lines: TranscriptRow[], recap: Recap | null): ChunkDraft[] {
  const title = session.title || 'Untitled meeting';
  const when = dateLabel(session.startedAt);
  const where = `"${title}" (${when})`;
  const out: ChunkDraft[] = [];

  if (recap) {
    out.push({
      kind: 'recap',
      ref: 'recap',
      text: [
        `Meeting ${where}: ${recap.headline}`,
        recap.overview,
        recap.highlights.length ? `Highlights: ${recap.highlights.join('; ')}` : '',
        recap.nextSteps.length ? `Next steps: ${recap.nextSteps.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  } else if (session.insights?.summary) {
    out.push({ kind: 'recap', ref: 'recap', text: `Meeting ${where}: ${session.insights.summary}` });
  }

  for (const d of session.insights?.decisions ?? []) {
    const bits = [`Decision in ${where} — ${d.status.toUpperCase()}: ${d.statement}.`];
    if (d.options?.length) bits.push(`Options: ${d.options.join(' vs ')}.`);
    if (d.proposedBy?.length) bits.push(`Proposed by ${d.proposedBy.join(', ')}.`);
    if (d.supporters?.length) bits.push(`Supported by ${d.supporters.join(', ')}.`);
    if (d.objectors?.length) bits.push(`Objections from ${d.objectors.join(', ')}.`);
    if (d.confirmationNeeded) bits.push(`Still needs confirmation: ${d.confirmationNeeded}`);
    out.push({ kind: 'decision', ref: d.id, text: bits.join(' ') });
  }

  for (const a of session.insights?.actionItems ?? []) {
    const bits = [`Task from ${where}: ${a.task}.`, `Owner: ${a.owner ?? 'unassigned'}.`];
    if (a.deadline || a.dueDate) bits.push(`Due: ${a.dueDate ?? a.deadline}.`);
    bits.push(`Status: ${a.status}.`);
    out.push({ kind: 'task', ref: a.id, text: bits.join(' ') });
  }

  const spoken = lines.filter((l) => l.text?.trim());
  for (let i = 0; i < spoken.length; i += WINDOW - OVERLAP) {
    const win = spoken.slice(i, i + WINDOW);
    if (win.length === 0) break;
    let body = win.map((l) => `${l.isAgent ? 'AuMeet AI' : l.speakerName}: ${l.text}`).join('\n');
    if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS);
    out.push({ kind: 'transcript', ref: String(win[0]!.seq), text: `From ${where}:\n${body}` });
    if (i + WINDOW >= spoken.length) break;
  }

  return out;
}
