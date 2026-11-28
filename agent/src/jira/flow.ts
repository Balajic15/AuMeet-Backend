import { ObjectId, type Db } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { StructuredCall } from '../gemini.js';
import { renderScreen, type ScreenState } from '../screen/vision.js';
import { formatUtterances, type Utterance } from '../transcript.js';
import { fence, UNTRUSTED_RULES } from '../untrusted.js';
import type { InternalPost } from './server.js';

/*
 * Conversational Jira issues. A participant asks ("create a Jira bug for this"); from then on every line goes through
 * a focused model step that sees the conversation, the shared screen, the current draft and the issues this meeting
 * already has, and decides the next move: fill the draft from what was said, ask for what is still missing (never what
 * was already answered), handle evidence (screenshot / recording / none / later / uploaded files), show the preview,
 * and create the issue only after an explicit approval. The draft lives in `issue_drafts` (shown live in the meeting
 * panel); the server creates it in Jira exactly once.
 */

const S = z.string();
export const IssueFields = z.object({
  summary: S.describe('Short, specific title ("Login button does nothing on staging (TypeError in login.js)")'),
  description: S.describe('What this is about, in a few sentences'),
  priority: S.describe('highest/high/medium/low/lowest as said or clearly implied, else ""'),
  severity: S.describe('For bugs: critical/major/minor/trivial as said or implied, else ""'),
  component: S.describe('Affected component/area if named, else ""'),
  environment: S.describe('For bugs: where it happens (URL, app version, browser, device, staging/prod), else ""'),
  assignee: S.describe('Person to assign, if someone was named, else ""'),
  labels: z.array(S),
  acceptanceCriteria: z.array(S).describe('For stories/tasks: testable conditions'),
  stepsToReproduce: z.array(S).describe('For bugs: numbered steps'),
  expected: S.describe('For bugs: what should happen'),
  actual: S.describe('For bugs: what actually happens'),
  userRole: S.describe('For stories: who ("a returning customer")'),
  goal: S.describe('For stories: what they want to do'),
  benefit: S.describe('For stories: why it matters (business value)'),
});
export type IssueFields = z.infer<typeof IssueFields>;

export const IssueFlowOutput = z.object({
  action: z
    .enum(['none', 'start', 'update', 'capture_screenshot', 'start_recording', 'stop_recording', 'no_attachment', 'attach_later', 'show_preview', 'create', 'create_anyway', 'cancel'])
    .describe('The next move (see the rules)'),
  issueType: z.enum(['bug', 'story', 'task', '']).describe('For start (or when the type changes); "" otherwise'),
  fields: IssueFields.describe('Every field: the value learned or changed in this turn, or "" / [] when unchanged or unknown. acceptanceCriteria and stepsToReproduce are lists – one item per condition / step'),
  missing: z.array(S).describe('Mandatory information still missing after this turn, in plain words'),
  evidenceDecision: z
    .enum(['', 'none', 'later'])
    .describe('Set whenever the latest line decides attachments: "none" (no attachment needed) or "later" (will attach later); "" otherwise'),
  say: S.describe('What the assistant says now: at most one or two short questions, a confirmation, or a short preview. "" for none'),
});
export type IssueFlowOutput = z.infer<typeof IssueFlowOutput>;

export const ISSUE_FLOW_SYSTEM = `You help a team turn a live meeting conversation into a complete Jira issue. You see the conversation, what
is on the shared screen, the current draft (if any) and the issues this meeting already has. Decide the next move.

Moves:
- "none": the latest line has nothing to do with a Jira issue (or no draft is open and nobody asked for one).
- "start": someone asks for a ticket (bug, user story or task). Fill every field you can from the conversation AND
  the screen (an error on screen is the actual result; the URL is the environment; what they did is the steps).
- "update": new or corrected information for the open draft (also "change the priority to high", "assign it to Ravi").
- Ask for what is mandatory and still missing with "update" and a question in say – reuse everything already said
  or visible, never ask for something that was answered. Mandatory: bug → summary, steps to reproduce, expected and
  actual result, environment, severity; story → user role, goal, business value, acceptance criteria;
  task → summary and what "done" means. Ask one (at most two related) questions at a time.
- Evidence, once the essentials are known and before the preview (unless already decided): ask whether to attach
  a screenshot, a screen recording or a file. Then:
  "capture_screenshot" when someone asks for a screenshot ("take a screenshot", "capture this") – best at the moment
  the issue is visible; "start_recording" / "stop_recording" for "record this" / "stop recording";
  "no_attachment" for "leave it, no attachment"; "attach_later" for "I'll attach it later".
  Files someone uploads in the panel are attached already – just acknowledge them.
- "show_preview": essentials complete and evidence decided → read back a SHORT summary (type, title, key points,
  attachments) and ask for approval.
- "create": ONLY when the latest line explicitly approves creating it ("yes, create it", "go ahead"), from the person
  who asked or the host. "create_anyway" when they confirm it is not a duplicate of an issue you pointed out.
- "cancel": they no longer want it.
Record everything the latest line tells you in fields in the SAME turn (e.g. "done means X and Y" →
acceptanceCriteria ["X", "Y"]; "for returning customers" → userRole; "so we stop losing sales" → benefit), even while
you also ask the next question or show the preview. Set evidenceDecision whenever attachments are decided.
Never invent facts. Don't create a second draft for the same problem: if an open draft or an existing issue of this
meeting covers it, update that draft or point to the existing issue in say. Speak naturally and briefly, in the
language of the conversation.

${UNTRUSTED_RULES}`;

export interface DraftView {
  id: string;
  type: 'bug' | 'story' | 'task';
  status: 'drafting' | 'ready' | 'creating' | 'created' | 'cancelled' | 'failed';
  fields: Partial<IssueFields>;
  missing: string[];
  evidence: { decision: string; attachments: Array<{ id: string; kind: string; name: string; status: string }> };
  requestedBy: string | null;
  jira: { key: string; url: string } | null;
  error: string | null;
  duplicateOf?: { key: string; url: string; summary: string } | null;
}

export interface Speaker {
  identity: string;
  name: string;
  userId: string | null;
}

interface DeskOptions {
  db: Db;
  call: StructuredCall;
  meetingCode: string;
  sessionId: string;
  hostId: () => string | null;
  transcript: () => readonly Utterance[];
  screen: () => ScreenState | null;
  internal: InternalPost;
  /** The newest frame of a screen the AI may see, as PNG, or null. */
  screenshot: () => Promise<{ name: string; data: Buffer } | null>;
  /** The screen-share track that may be recorded, or null. */
  screenTrack: () => { sid: string; sharer: string } | null;
  onChange: (drafts: DraftView[]) => void;
}

const OPEN = new Set(['drafting', 'ready', 'failed']);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export class IssueDesk {
  private drafts: DraftView[] = [];

  constructor(private readonly o: DeskOptions) {}

  get views(): DraftView[] {
    return this.drafts;
  }

  /** The draft people are working on now (newest open one). */
  get active(): DraftView | null {
    return this.drafts.find((d) => OPEN.has(d.status)) ?? null;
  }

  /** Reload this session's drafts (after the server or the panel changed one). */
  async reload(): Promise<DraftView[]> {
    const rows = await this.o.db.collection('issue_drafts').find({ sessionId: this.o.sessionId }).sort({ createdAt: -1 }).limit(20).toArray();
    this.drafts = rows.map((d) => ({
      id: String(d['_id']),
      type: d['type'],
      status: d['status'],
      fields: d['fields'] ?? {},
      missing: d['missing'] ?? [],
      evidence: {
        decision: d['evidence']?.decision ?? 'undecided',
        attachments: (d['evidence']?.attachments ?? []).map((a: Record<string, unknown>) => ({ id: String(a['id']), kind: String(a['kind']), name: String(a['name']), status: String(a['status']) })),
      },
      requestedBy: d['requestedBy']?.name ?? null,
      jira: d['jira']?.key ? { key: d['jira'].key, url: d['jira'].url } : null,
      error: d['error'] ?? null,
      duplicateOf: d['duplicateOf']?.key ? d['duplicateOf'] : null,
    }));
    this.o.onChange(this.drafts);
    return this.drafts;
  }

  private prompt(line: Utterance, request?: string): string {
    const active = this.active;
    const created = this.drafts.filter((d) => d.jira);
    return [
      active
        ? fence('OPEN DRAFT', JSON.stringify({ type: active.type, status: active.status, fields: active.fields, missing: active.missing, evidence: active.evidence }))
        : 'OPEN DRAFT: none',
      created.length ? fence('ISSUES THIS MEETING ALREADY CREATED', created.map((d) => `${d.jira!.key}: ${d.fields.summary ?? ''}`).join('\n')) : '',
      this.o.screen()?.observations.length ? fence('SHARED SCREEN (latest last)', renderScreen(this.o.screen(), 3)) : '',
      fence('CONVERSATION (UTC)', formatUtterances(this.o.transcript().slice(-30), 'UTC')),
      request ? fence('THE ASSISTANT WAS ASKED (latest)', `${line.speakerName}: ${request}`) : '',
      fence('LATEST LINE', `${line.speakerName}${line.channel === 'chat' ? ' (in chat)' : ''}: ${line.text}`),
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * One step of the workflow for a participant's line. Returns what to say ("" = nothing to say) and whether the
   * line was about the issue (if not, the normal assistant answers instead).
   */
  async handle(line: Utterance, speaker: Speaker, request?: string, addressed = false): Promise<{ acted: boolean; say: string }> {
    // No open draft: only a line addressed to the assistant (or its tool) can start one – nothing to judge otherwise.
    if (!this.active && !request && !addressed) return { acted: false, say: '' };
    const out = await this.o.call(IssueFlowOutput, { system: ISSUE_FLOW_SYSTEM, prompt: this.prompt(line, request), temperature: 0.2, task: 'jira' });
    if (out.action === 'none') return { acted: false, say: '' };
    let draft = this.active;
    if (out.action === 'start' || !draft) {
      if (out.action !== 'start' && out.action !== 'update') return { acted: false, say: '' };
      draft = await this.create(out.issueType || 'task', speaker);
    }
    const col = this.o.db.collection('issue_drafts');
    const _id = new ObjectId(draft.id);
    const set: Record<string, unknown> = { missing: out.missing.map((m) => m.trim()).filter(Boolean).slice(0, 10), updatedAt: new Date() };
    for (const [k, v] of Object.entries(out.fields ?? {})) {
      if (Array.isArray(v) ? v.some((x) => x.trim()) : typeof v === 'string' && v.trim()) set[`fields.${k}`] = Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean) : v.trim();
    }
    if (out.issueType && out.action !== 'start') set['type'] = out.issueType;
    let say = out.say.trim();

    switch (out.action) {
      case 'capture_screenshot': {
        const shot = await this.o.screenshot();
        if (!shot) {
          say = await this.phrase(line, 'A screenshot was requested, but nobody is sharing a screen the assistant is allowed to see. Ask them to share their screen and allow the assistant to see it.');
          break;
        }
        if (shot.data.length > MAX_ATTACHMENT_BYTES) {
          say = await this.phrase(line, 'The screenshot is too large to attach.');
          break;
        }
        const id = randomBytes(12).toString('hex');
        await this.o.db.collection<{ _id: string } & Record<string, unknown>>('issue_attachments').insertOne({
          _id: id, draftId: draft.id, meetingCode: this.o.meetingCode, name: shot.name, mime: 'image/png', size: shot.data.length, data: shot.data, createdAt: new Date(),
        });
        await col.updateOne({ _id }, { $push: { 'evidence.attachments': { id, kind: 'screenshot', name: shot.name, mime: 'image/png', size: shot.data.length, status: 'ready', addedBy: speaker.name, at: new Date() } } as never, $set: { 'evidence.decision': 'collected' } });
        break;
      }
      case 'start_recording': {
        const track = this.o.screenTrack();
        if (!track) {
          say = await this.phrase(line, 'A recording was requested, but nobody is sharing a screen the assistant may see. Ask them to share and allow it.');
          break;
        }
        const r = await this.o.internal(`/issues/${draft.id}/recording/start`, { trackSid: track.sid, by: speaker.name });
        say = r.status === 200 ? say || (await this.phrase(line, 'The screen recording has started; tell them to say when to stop.')) : await this.phrase(line, `The recording could not start: ${String(r.body['message'] ?? r.status)}.`);
        break;
      }
      case 'stop_recording': {
        const r = await this.o.internal(`/issues/${draft.id}/recording/stop`, {});
        say = await this.phrase(line, r.body['stopped'] ? 'The recording stopped; it will be attached once processed (usually within a minute).' : 'There was no recording running for this ticket.');
        break;
      }
      case 'no_attachment':
        set['evidence.decision'] = 'none';
        break;
      case 'attach_later':
        set['evidence.decision'] = 'later';
        break;
      case 'show_preview':
        set['status'] = 'ready';
        break;
      case 'cancel':
        set['status'] = 'cancelled';
        break;
      default:
        break;
    }
    if (out.evidenceDecision && !('evidence.decision' in set)) set['evidence.decision'] = out.evidenceDecision;
    await col.updateOne({ _id }, { $set: set });

    if (out.action === 'create' || out.action === 'create_anyway') {
      const r = await this.o.internal(`/issues/${draft.id}/create`, { approver: speaker, allowDuplicate: out.action === 'create_anyway' });
      const dupes = r.body['duplicates'] as Array<{ key: string; summary: string }> | undefined;
      const created = (r.body['draft'] as { jira?: { key: string; url: string } } | undefined)?.jira;
      if (r.status === 200 && created) say = await this.phrase(line, `The Jira issue was created: ${created.key} (${created.url}). Confirm briefly with the key.`);
      else if (r.status === 200 && dupes?.length) say = await this.phrase(line, `Before creating: this looks like an existing issue – ${dupes.map((d) => `${d.key} "${d.summary}"`).join('; ')}. Ask whether to create a new one anyway or use the existing one.`);
      else say = await this.phrase(line, `The issue was not created: ${String(r.body['message'] ?? `server answered ${r.status}`)}.`);
    }
    await this.reload();
    return { acted: true, say };
  }

  private async create(type: 'bug' | 'story' | 'task', speaker: Speaker): Promise<DraftView> {
    const res = await this.o.db.collection('issue_drafts').insertOne({
      meetingCode: this.o.meetingCode, sessionId: this.o.sessionId, hostId: this.o.hostId() ?? '', requestedBy: speaker, type, status: 'drafting',
      fields: {}, missing: [], evidence: { decision: 'undecided', attachments: [] }, createdAt: new Date(), updatedAt: new Date(),
    });
    await this.reload();
    return this.drafts.find((d) => d.id === String(res.insertedId))!;
  }

  /** Outcomes are put into words by the model too (no canned phrases). */
  private async phrase(line: Utterance, situation: string): Promise<string> {
    try {
      const out = await this.o.call(z.object({ say: S }), {
        system: 'You are the meeting assistant. Say the given situation to the participant in one or two short, natural spoken sentences, in the language of their line. Keep issue keys exactly as given.',
        prompt: `Participant (${line.speakerName}) said: "${line.text}"\nSituation: ${situation}`,
        temperature: 0.4,
        task: 'jira',
      });
      return out.say.trim();
    } catch {
      return situation;
    }
  }
}

/** For the notes: open drafts and created issues (so later talk recognises them). */
export function renderIssues(drafts: DraftView[]): string {
  const lines: string[] = [];
  for (const d of drafts) {
    if (d.jira) lines.push(`- ${d.jira.key} (${d.type}): ${d.fields.summary ?? ''} – created`);
    else if (OPEN.has(d.status)) lines.push(`- Draft ${d.type}: ${d.fields.summary ?? '(no title yet)'} – ${d.status}${d.missing.length ? `, missing ${d.missing.join(', ')}` : ''}`);
  }
  return lines.length ? `Jira issues:\n${lines.join('\n')}` : '';
}
