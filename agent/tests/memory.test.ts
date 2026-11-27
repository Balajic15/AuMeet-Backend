import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { earlierSessionsBrief } from '../src/memory.js';

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('t');
  await db.collection('meeting_insights').insertMany([
    {
      sessionId: 'week1', meetingCode: 'abc-defg-hij', startedAt: new Date('2026-11-12T10:00:00Z'),
      recap: { overview: 'Kicked off the project.' },
      insights: {
        decisions: [
          { statement: 'Ship weekly', status: 'agreed' },
          { statement: 'Which database to use', status: 'disputed', confirmationNeeded: 'Confirm the database?' },
        ],
        actionItems: [
          { task: 'Draft schema', owner: 'Asha', deadline: 'by Friday', status: 'open' },
          { task: 'Book room', owner: 'Ben', deadline: null, status: 'done' },
        ],
      },
    },
    { sessionId: 'week2', meetingCode: 'abc-defg-hij', startedAt: new Date('2026-11-19T10:00:00Z'), insights: { summary: 'Reviewed designs.' } },
    { sessionId: 'now', meetingCode: 'abc-defg-hij', startedAt: new Date('2026-11-26T10:00:00Z'), insights: { summary: 'current' } },
    { sessionId: 'other', meetingCode: 'zzz-zzzz-zzz', startedAt: new Date('2026-11-25T10:00:00Z'), insights: { summary: 'Secret other meeting' } },
  ]);
});
afterAll(async () => {
  await client.close();
  await mongo.stop();
});

describe('earlierSessionsBrief', () => {
  it('summarises earlier sessions of the same meeting only, oldest first, excluding the current one', async () => {
    const brief = await earlierSessionsBrief(db, 'abc-defg-hij', 'now');
    expect(brief).toContain('EARLIER SESSIONS OF THIS SAME MEETING');
    expect(brief.indexOf('2026-11-12')).toBeLessThan(brief.indexOf('2026-11-19'));
    expect(brief).toContain('Summary: Kicked off the project.');
    expect(brief).toContain('Agreed: Ship weekly');
    expect(brief).toContain('Left unresolved: Which database to use');
    expect(brief).toContain('Open tasks: Draft schema (Asha, by Friday)');
    expect(brief).not.toContain('Book room'); // done
    expect(brief).not.toContain('current');
    expect(brief).not.toContain('Secret other meeting');
  });

  it('is empty for a first session', async () => {
    expect(await earlierSessionsBrief(db, 'new-meet-ing', 'x')).toBe('');
  });
});
