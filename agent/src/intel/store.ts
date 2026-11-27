import type { Collection, Db } from 'mongodb';
import type { Person } from './normalize.js';
import type { Insights } from './schema.js';

/**
 * `meeting_insights`: one document per meeting session (a meeting link can be used for
 * several sessions). The server reads these for the insights page and dashboard.
 */
export class InsightsStore {
  private readonly col: Collection;
  private ready: Promise<unknown>;

  constructor(
    db: Db,
    private readonly meetingCode: string,
    private readonly sessionId: string,
    private readonly title: string,
  ) {
    this.col = db.collection('meeting_insights');
    this.ready = Promise.all([
      this.col.createIndex({ meetingCode: 1, startedAt: -1 }),
      this.col.createIndex({ sessionId: 1 }, { unique: true }),
      this.col.createIndex({ 'insights.actionItems.ownerUserId': 1 }),
    ]);
  }

  async save(insights: Insights, people: Person[], opts: { ended?: boolean } = {}): Promise<void> {
    await this.ready;
    const now = new Date();
    await this.col.updateOne(
      { sessionId: this.sessionId },
      {
        $set: {
          meetingCode: this.meetingCode,
          title: this.title,
          insights,
          participants: people,
          // Account ids of everyone who spoke – used for access checks and "my tasks".
          participantUserIds: [...new Set(people.map((p) => p.userId).filter(Boolean))],
          updatedAt: now,
          ...(opts.ended ? { endedAt: now } : {}),
        },
        $setOnInsert: { startedAt: now },
      },
      { upsert: true },
    );
  }
}
