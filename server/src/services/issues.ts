import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { EgressClient, EncodedFileOutput, EncodedFileType, S3Upload } from 'livekit-server-sdk';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { IntegrationError } from '../integrations/errors.js';
import { attachToJira, createJiraIssue, similarJiraIssues, type IssueFields, type IssueType } from '../integrations/jiraIssues.js';
import { MeetingInsightModel } from '../models/Insights.js';
import { IssueAttachmentModel, IssueDraftModel, MAX_ATTACHMENT_BYTES, type IssueDraft } from '../models/IssueDraft.js';
import { RecordingModel } from '../models/Recording.js';
import { recordingConfigured, refreshRecording } from './recording.js';
import { audit } from './audit.js';

/*
 * Turning an approved draft into a Jira issue – exactly once:
 *   1. who may approve: the person who asked for it, or the meeting's host
 *   2. the essentials must be there (summary; for a bug what actually happens)
 *   3. likely duplicates (same meeting, or open issues in the Jira project) are reported back instead of creating,
 *      until the participants confirm it is a new issue
 *   4. the draft is claimed (status "creating") so two approvals can never create two issues
 *   5. attachments that are ready are uploaded; a screen recording still processing is noted
 *   6. the issue key is stored on the draft and in the meeting notes (memory)
 */

export class IssueFlowError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

export type DraftDoc = IssueDraft & { _id: { toString(): string }; createdAt?: Date };

export function publicDraft(d: DraftDoc) {
  return {
    id: String(d._id),
    meetingCode: d.meetingCode,
    sessionId: d.sessionId,
    type: d.type,
    status: d.status,
    fields: d.fields ?? {},
    missing: d.missing ?? [],
    evidence: {
      decision: d.evidence?.decision ?? 'undecided',
      attachments: (d.evidence?.attachments ?? []).map((a) => ({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, status: a.status })),
    },
    requestedBy: d.requestedBy?.name ?? null,
    duplicateOf: d.duplicateOf?.key ? d.duplicateOf : null,
    jira: d.jira?.key ? d.jira : null,
    error: d.error ?? null,
  };
}

/** The essentials Jira needs; the AI asks for the rest conversationally. */
export function essentialsMissing(type: IssueType, f: IssueFields): string[] {
  const missing: string[] = [];
  if (!f.summary?.trim()) missing.push('summary');
  if (type === 'bug' && !f.actual?.trim() && !f.description?.trim()) missing.push('what actually happens');
  if (type === 'story' && !f.goal?.trim() && !f.description?.trim()) missing.push('what the user wants to do');
  return missing;
}

export async function createIssueFromDraft(
  draftId: string,
  approver: { userId?: string | null; identity?: string | null; name?: string | null },
  opts: { allowDuplicate?: boolean; meetingLink?: string } = {},
): Promise<{ draft: ReturnType<typeof publicDraft>; duplicates?: Array<{ key: string; summary: string; url: string }> }> {
  const d = (await IssueDraftModel.findById(draftId).lean()) as DraftDoc | null;
  if (!d) throw new IssueFlowError('Draft not found', 404);
  if (d.status === 'created') return { draft: publicDraft(d) }; // idempotent
  if (d.status === 'cancelled') throw new IssueFlowError('This draft was cancelled', 409);
  const isHost = !!approver.userId && approver.userId === d.hostId;
  const isRequester = (!!approver.identity && approver.identity === d.requestedBy?.identity) || (!!approver.userId && approver.userId === d.requestedBy?.userId);
  if (!isHost && !isRequester) throw new IssueFlowError('Only the person who asked for this ticket or the host can approve it', 403);

  const f = (d.fields ?? {}) as IssueFields;
  const missing = essentialsMissing(d.type as IssueType, f);
  if (missing.length) throw new IssueFlowError(`Still missing: ${missing.join(', ')}`, 422, { missing });

  if (!opts.allowDuplicate) {
    const created = (await IssueDraftModel.find({ meetingCode: d.meetingCode, status: 'created', _id: { $ne: d._id } }).select({ jira: 1, fields: 1 }).lean()) as DraftDoc[];
    const words = (s?: string) => new Set((s ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const mine = words(f.summary);
    const overlap = (s?: string) => { const w = words(s); let n = 0; for (const x of w) if (mine.has(x)) n++; return mine.size ? n / mine.size : 0; };
    const inMeeting = created.filter((c) => overlap((c.fields as IssueFields)?.summary) >= 0.6).map((c) => ({ key: c.jira!.key!, summary: (c.fields as IssueFields).summary ?? '', url: c.jira!.url! }));
    const inJira = await similarJiraIssues(d.hostId, f.summary ?? '');
    const duplicates = [...inMeeting, ...inJira.filter((j) => overlap(j.summary) >= 0.5)].slice(0, 3);
    if (duplicates.length) {
      await IssueDraftModel.updateOne({ _id: d._id }, { $set: { duplicateOf: duplicates[0] } });
      return { draft: publicDraft({ ...d, duplicateOf: duplicates[0] } as DraftDoc), duplicates };
    }
  }

  // Claim: only one approval wins.
  const claimed = (await IssueDraftModel.findOneAndUpdate(
    { _id: d._id, status: { $in: ['drafting', 'ready', 'failed'] } },
    { $set: { status: 'creating', approvedBy: approver.name ?? approver.identity ?? approver.userId ?? '' }, $unset: { error: 1 } },
    { returnDocument: 'after' },
  ).lean()) as DraftDoc | null;
  if (!claimed) {
    const now = (await IssueDraftModel.findById(d._id).lean()) as DraftDoc;
    return { draft: publicDraft(now) };
  }

  const pendingRecording = (d.evidence?.attachments ?? []).some((a) => a.kind === 'recording' && a.status === 'pending');
  const evidenceNote =
    d.evidence?.decision === 'later'
      ? 'Evidence (screenshots, recordings or logs) will be attached later.'
      : pendingRecording
        ? 'A screen recording is still processing and will be attached when ready.'
        : undefined;
  let issue;
  try {
    issue = await createJiraIssue(d.hostId, d.type as IssueType, f, { meetingLink: opts.meetingLink, evidenceNote });
  } catch (err) {
    const message = err instanceof IntegrationError ? err.message : String((err as Error).message ?? err);
    await IssueDraftModel.updateOne({ _id: d._id }, { $set: { status: 'failed', error: message.slice(0, 300) } });
    throw new IssueFlowError(message, err instanceof IntegrationError && err.retryable ? 502 : 400);
  }
  await IssueDraftModel.updateOne({ _id: d._id }, { $set: { status: 'created', jira: { key: issue.key, id: issue.id, url: issue.url } } });
  await uploadReadyAttachments(String(d._id)).catch((err) => logger.warn({ err }, 'attachment upload failed'));
  // Meeting memory (kept beside the notes, which the live agent rewrites; it shows created issues from the drafts).
  await MeetingInsightModel.updateOne(
    { sessionId: d.sessionId },
    { $push: { jiraIssues: { key: issue.key, url: issue.url, summary: f.summary ?? '', type: d.type, draftId: String(d._id), createdAt: new Date().toISOString() } } },
  );
  await audit(null, 'jira.issue_created', { actorId: approver.userId ?? null, meetingCode: d.meetingCode, sessionId: d.sessionId, target: issue.key, meta: { type: d.type, dropped: issue.dropped } });
  const fresh = (await IssueDraftModel.findById(d._id).lean()) as DraftDoc;
  return { draft: publicDraft(fresh) };
}

/** Upload every ready attachment of a created issue (recordings once processed). Safe to call repeatedly. */
export async function uploadReadyAttachments(draftId: string): Promise<number> {
  const d = (await IssueDraftModel.findById(draftId).lean()) as DraftDoc | null;
  if (!d?.jira?.key) return 0;
  let n = 0;
  for (const a of d.evidence?.attachments ?? []) {
    if (a.status === 'uploaded' || a.status === 'failed') continue;
    try {
      let data: Buffer | null = null;
      if (a.kind === 'recording' && a.recordingId) {
        const rec = await RecordingModel.findById(a.recordingId);
        if (!rec) continue;
        if (rec.status === 'active') await refreshRecording(rec);
        if (rec.status !== 'complete') continue; // still processing; the worker retries
        if ((rec.sizeBytes ?? 0) > MAX_ATTACHMENT_BYTES) {
          await IssueDraftModel.updateOne({ _id: d._id, 'evidence.attachments.id': a.id }, { $set: { 'evidence.attachments.$.status': 'failed' } });
          continue;
        }
        data = await downloadFromBucket(rec.fileKey);
      } else {
        const doc = await IssueAttachmentModel.findById(a.id).lean();
        // lean() returns a BSON Binary for Buffer fields.
        const raw = doc?.data as unknown as { buffer?: Uint8Array } | Uint8Array | undefined;
        data = raw ? Buffer.from(raw instanceof Uint8Array ? raw : (raw.buffer ?? new Uint8Array())) : null;
      }
      if (!data) continue;
      await attachToJira(d.hostId, d.jira.key, { name: a.name, mime: a.mime, data });
      await IssueDraftModel.updateOne({ _id: d._id, 'evidence.attachments.id': a.id }, { $set: { 'evidence.attachments.$.status': 'uploaded' } });
      n++;
    } catch (err) {
      logger.warn({ err, draftId, attachment: a.id }, 'could not attach to Jira');
    }
  }
  return n;
}

// ---------- screen recordings for evidence ----------

let egress: EgressClient | null = null;
const egressClient = () => (egress ??= new EgressClient(env.LIVEKIT_URL.replace(/^ws/, 'http'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET));

/** Record just the shared screen (MP4 into the recording bucket) for a draft. */
export async function startScreenRecording(draftId: string, trackSid: string, startedBy: string): Promise<{ recordingId: string }> {
  if (!recordingConfigured()) throw new IssueFlowError('Screen recording is not set up on this server', 501);
  const d = (await IssueDraftModel.findById(draftId).lean()) as DraftDoc | null;
  if (!d) throw new IssueFlowError('Draft not found', 404);
  if ((d.evidence?.attachments ?? []).some((a) => a.kind === 'recording' && a.status === 'pending')) {
    throw new IssueFlowError('A recording for this ticket is already running', 409);
  }
  const fileKey = `recordings/${d.meetingCode}/issue-${draftId}-${Date.now()}.mp4`;
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: fileKey,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: env.RECORDING_S3_ACCESS_KEY!, secret: env.RECORDING_S3_SECRET!, region: env.RECORDING_S3_REGION,
        endpoint: env.RECORDING_S3_ENDPOINT ?? '', bucket: env.RECORDING_S3_BUCKET!, forcePathStyle: env.RECORDING_S3_FORCE_PATH_STYLE,
      }),
    },
  });
  const info = await egressClient().startTrackCompositeEgress(d.meetingCode, output, { videoTrackId: trackSid });
  const rec = await RecordingModel.create({ meetingCode: d.meetingCode, egressId: info.egressId, startedBy, fileKey, kind: 'screen', draftId });
  await IssueDraftModel.updateOne(
    { _id: d._id },
    { $push: { 'evidence.attachments': { id: `rec-${String(rec._id)}`, kind: 'recording', name: `screen-recording-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`, mime: 'video/mp4', status: 'pending', recordingId: String(rec._id), addedBy: startedBy } }, $set: { 'evidence.decision': 'collecting' } },
  );
  return { recordingId: String(rec._id) };
}

export async function stopScreenRecording(draftId: string): Promise<boolean> {
  const rec = await RecordingModel.findOne({ draftId, kind: 'screen', status: 'active' });
  if (!rec) return false;
  try {
    await egressClient().stopEgress(rec.egressId);
  } catch {
    /* already stopped */
  }
  await RecordingModel.updateOne({ _id: rec._id }, { $set: { stopRequestedAt: new Date() } });
  await IssueDraftModel.updateOne({ _id: draftId, 'evidence.attachments.recordingId': String(rec._id) }, { $set: { 'evidence.attachments.$.status': 'ready', 'evidence.decision': 'collected' } });
  return true;
}

let s3: S3Client | null = null;
async function downloadFromBucket(key: string): Promise<Buffer> {
  s3 ??= new S3Client({
    region: env.RECORDING_S3_REGION, endpoint: env.RECORDING_S3_ENDPOINT || undefined, forcePathStyle: env.RECORDING_S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.RECORDING_S3_ACCESS_KEY!, secretAccessKey: env.RECORDING_S3_SECRET! },
  });
  const out = await s3.send(new GetObjectCommand({ Bucket: env.RECORDING_S3_BUCKET!, Key: key }));
  return Buffer.from(await out.Body!.transformToByteArray());
}
