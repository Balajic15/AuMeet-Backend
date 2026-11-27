import JSZip from 'jszip';
import mammoth from 'mammoth';
import { extractText as extractPdfText } from 'unpdf';
import type { AiClient } from '../ai/gemini.js';
import { MemoryChunkModel } from '../models/MemoryChunk.js';
import { badRequest } from '../utils/httpError.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MEETING = 10;
/** Text kept per document (~50 pages of prose). */
export const MAX_TEXT_CHARS = 200_000;

const CHUNK = 1500;
const OVERLAP = 200;

type Kind = 'pdf' | 'docx' | 'pptx' | 'text';

const BY_EXT: Record<string, Kind> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  csv: 'text',
};

export function kindOf(filename: string): Kind | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return BY_EXT[ext] ?? null;
}

export const ACCEPTED_EXTENSIONS = Object.keys(BY_EXT).map((e) => `.${e}`);

/** Collapse whitespace but keep paragraph breaks. */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Slide text from a .pptx: every <a:t> run, slide by slide. */
async function pptxText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
  const parts: string[] = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name)!.async('string');
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]!));
    if (runs.length) parts.push(`Slide ${i + 1}: ${runs.join(' ')}`);
  }
  return { text: parts.join('\n\n'), pages: slides.length };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Plain text from an uploaded file. Throws 400 for unsupported or unreadable files. */
export async function extractDocumentText(
  buf: Buffer,
  filename: string,
): Promise<{ text: string; pages: number | null; truncated: boolean }> {
  const kind = kindOf(filename);
  if (!kind) throw badRequest(`Unsupported file type. Use ${ACCEPTED_EXTENSIONS.join(', ')}`);

  let raw: string;
  let pages: number | null = null;
  try {
    if (kind === 'pdf') {
      const r = await extractPdfText(new Uint8Array(buf), { mergePages: true });
      raw = r.text;
      pages = r.totalPages;
    } else if (kind === 'docx') {
      raw = (await mammoth.extractRawText({ buffer: buf })).value;
    } else if (kind === 'pptx') {
      const r = await pptxText(buf);
      raw = r.text;
      pages = r.pages;
    } else {
      raw = buf.toString('utf8');
    }
  } catch {
    throw badRequest(`Couldn't read "${filename}". Is the file damaged or password-protected?`);
  }

  const text = cleanText(raw);
  if (!text) throw badRequest(`"${filename}" has no readable text (scanned images aren't supported yet).`);
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), pages, truncated: true }
    : { text, pages, truncated: false };
}

/** Overlapping chunks, preferring to cut at paragraph/sentence boundaries. */
export function chunkText(text: string, size = CHUNK, overlap = OVERLAP): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const window = text.slice(start, end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '));
      if (cut > size * 0.5) end = start + cut + 1;
    }
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

/** Embed a document's chunks so the AI can search it (replaces any previous index). */
export async function indexDocument(
  ai: AiClient,
  doc: { id: string; meetingCode: string; filename: string; text: string },
): Promise<number> {
  const pieces = chunkText(doc.text);
  const vectors = await ai.embed(
    pieces.map((p) => `From the document "${doc.filename}":\n${p}`),
    'document',
  );
  await MemoryChunkModel.deleteMany({ kind: 'document', ref: doc.id });
  await MemoryChunkModel.insertMany(
    pieces.map((p, i) => ({
      meetingCode: doc.meetingCode,
      sessionId: `doc:${doc.id}`,
      title: doc.filename,
      kind: 'document',
      ref: doc.id,
      text: `From the document "${doc.filename}":\n${p}`,
      embedding: vectors[i],
    })),
  );
  return pieces.length;
}
