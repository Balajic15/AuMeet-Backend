import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import JSZip from 'jszip';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';

vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  setRoomSettings: vi.fn(async () => {}),
}));

const { createApp } = await import('../src/app.js');
const { setAiForTests, normalizeVector } = await import('../src/ai/gemini.js');
const { chunkText, extractDocumentText } = await import('../src/services/documents.js');

const embedded: string[] = [];
setAiForTests({
  structured: async () => {
    throw new Error('not used');
  },
  embed: async (texts) => {
    embedded.push(...texts);
    return texts.map(() => normalizeVector([1, 0, 0]));
  },
});

const app = createApp();
let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  setAiForTests(null);
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.connection.syncIndexes();
  embedded.length = 0;
});

async function user(email: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name: email.split('@')[0], password: 'password123' });
  return { auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}

// ---- tiny real files built in memory ----
async function docx(text: string): Promise<Buffer> {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generateAsync({ type: 'nodebuffer' });
}

async function pptx(slides: string[]): Promise<Buffer> {
  const z = new JSZip();
  slides.forEach((t, i) => z.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`));
  return z.generateAsync({ type: 'nodebuffer' });
}

function pdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // content stream
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o ?? `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

describe('document text extraction', () => {
  it('reads PDF, Word, PowerPoint, text and Markdown', async () => {
    expect((await extractDocumentText(pdf('Use PostgreSQL for billing'), 'spec.pdf')).text).toContain('Use PostgreSQL for billing');
    expect((await extractDocumentText(await docx('Retention is 90 days'), 'policy.docx')).text).toBe('Retention is 90 days');
    const slides = await extractDocumentText(await pptx(['Q4 goals', 'Hire two engineers']), 'deck.pptx');
    expect(slides.text).toBe('Slide 1: Q4 goals\n\nSlide 2: Hire two engineers');
    expect(slides.pages).toBe(2);
    expect((await extractDocumentText(Buffer.from('# Notes\n\n\n\nShip it'), 'notes.md')).text).toBe('# Notes\n\nShip it');
  });

  it('rejects unsupported, unreadable and empty files', async () => {
    await expect(extractDocumentText(Buffer.from('x'), 'virus.exe')).rejects.toThrow(/Unsupported file type/);
    await expect(extractDocumentText(Buffer.from('not a zip'), 'broken.docx')).rejects.toThrow(/Couldn't read/);
    await expect(extractDocumentText(Buffer.from('   \n  '), 'blank.txt')).rejects.toThrow(/no readable text/);
  });

  it('chunks long text with overlap at sentence boundaries', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkText(text, 300, 50);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks[0]!.endsWith('.')).toBe(true);
    expect(chunks.join(' ')).toContain('Sentence number 59 is here.');
  });
});

describe('meeting prep API', () => {
  it('saves a goal and agenda on create and update, keeping agenda ids stable', async () => {
    const host = await user('h@test.dev');
    const created = await request(app).post('/api/meetings').set(host.auth).send({
      title: 'Planning',
      prep: { goal: 'Pick the database', agenda: [{ title: 'Database choice', minutes: 15 }, { title: 'Owners' }] },
    });
    const { code, prep } = created.body.meeting;
    expect(prep.goal).toBe('Pick the database');
    expect(prep.agenda).toMatchObject([{ title: 'Database choice', minutes: 15 }, { title: 'Owners', minutes: null }]);
    const firstId = prep.agenda[0].id;

    const upd = await request(app).patch(`/api/meetings/${code}`).set(host.auth).send({
      prep: { agenda: [{ id: firstId, title: 'Database choice', minutes: 20 }, { title: 'Budget', minutes: 10 }] },
      settings: { aiReplyMode: 'any' },
    });
    expect(upd.body.meeting.prep.agenda[0]).toEqual({ id: firstId, title: 'Database choice', minutes: 20 });
    expect(upd.body.meeting.prep.goal).toBe('Pick the database'); // untouched
    expect(upd.body.meeting.settings.aiReplyMode).toBe('any');
  });

  it('host uploads documents (text extracted, indexed, original discarded); others cannot', async () => {
    const host = await user('h@test.dev');
    const other = await user('o@test.dev');
    const { code } = (await request(app).post('/api/meetings').set(host.auth).send({})).body.meeting;

    const up = await request(app).post(`/api/meetings/${code}/documents`).set(host.auth)
      .attach('file', await docx('Retention is 90 days for all customer data.'), 'Data policy.docx');
    expect(up.status).toBe(201);
    expect(up.body.document).toMatchObject({ filename: 'Data policy.docx', indexed: true, truncated: false });
    expect(embedded[0]).toContain('From the document "Data policy.docx"');

    const stored = await mongoose.connection.db!.collection('meeting_documents').findOne({});
    expect(stored!.text).toBe('Retention is 90 days for all customer data.');
    expect(Object.keys(stored!)).not.toContain('buffer');
    expect(await mongoose.connection.db!.collection('memory_chunks').countDocuments({ kind: 'document' })).toBe(1);

    expect((await request(app).post(`/api/meetings/${code}/documents`).set(other.auth).attach('file', Buffer.from('hi'), 'a.txt')).status).toBe(403);
    expect((await request(app).post(`/api/meetings/${code}/documents`).set(host.auth).attach('file', Buffer.from('x'), 'a.exe')).status).toBe(400);
    expect((await request(app).post(`/api/meetings/${code}/documents`).set(host.auth).attach('file', Buffer.alloc(11 * 1024 * 1024, 97), 'big.txt')).status).toBe(413);

    const list = await request(app).get(`/api/meetings/${code}/documents`).set(host.auth);
    expect(list.body.documents).toHaveLength(1);
    expect(list.body.documents[0].text).toBeUndefined(); // list never ships the full text
    expect((await request(app).get(`/api/meetings/${code}`)).body.meeting.documents).toBe(1);

    const del = await request(app).delete(`/api/meetings/${code}/documents/${list.body.documents[0].id}`).set(host.auth);
    expect(del.status).toBe(200);
    expect(await mongoose.connection.db!.collection('memory_chunks').countDocuments({ kind: 'document' })).toBe(0);
  });
});
