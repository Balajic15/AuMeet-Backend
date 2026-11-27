import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { EgressClient, EncodedFileOutput, EncodedFileType, S3Upload, type EgressInfo } from 'livekit-server-sdk';
import { env } from '../config/env.js';
import { RecordingModel, type RecordingDoc } from '../models/Recording.js';

/** EgressStatus values from the LiveKit protocol. */
const EGRESS = { COMPLETE: 3, FAILED: 4, ABORTED: 5, LIMIT_REACHED: 6 } as const;

export function recordingConfigured(): boolean {
  return !!(env.RECORDING_S3_BUCKET && env.RECORDING_S3_ACCESS_KEY && env.RECORDING_S3_SECRET);
}

let egress: EgressClient | null = null;
function egressClient(): EgressClient {
  egress ??= new EgressClient(env.LIVEKIT_URL.replace(/^ws/, 'http'), env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  return egress;
}

let s3: S3Client | null = null;
function s3Client(): S3Client {
  s3 ??= new S3Client({
    region: env.RECORDING_S3_REGION,
    endpoint: env.RECORDING_S3_ENDPOINT || undefined,
    forcePathStyle: env.RECORDING_S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.RECORDING_S3_ACCESS_KEY!, secretAccessKey: env.RECORDING_S3_SECRET! },
  });
  return s3;
}

/** Start a grid-layout MP4 recording of the whole room, uploaded straight to the bucket. */
export async function startRecording(meetingCode: string, startedBy: string): Promise<RecordingDoc> {
  const fileKey = `recordings/${meetingCode}/${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: fileKey,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: env.RECORDING_S3_ACCESS_KEY!,
        secret: env.RECORDING_S3_SECRET!,
        region: env.RECORDING_S3_REGION,
        endpoint: env.RECORDING_S3_ENDPOINT ?? '',
        bucket: env.RECORDING_S3_BUCKET!,
        forcePathStyle: env.RECORDING_S3_FORCE_PATH_STYLE,
      }),
    },
  });
  const info = await egressClient().startRoomCompositeEgress(meetingCode, output, { layout: 'grid' });
  return RecordingModel.create({ meetingCode, egressId: info.egressId, startedBy, fileKey });
}

export async function stopRecording(rec: RecordingDoc): Promise<void> {
  try {
    const info = await egressClient().stopEgress(rec.egressId);
    await applyEgressInfo(info);
  } catch {
    // Already finished on LiveKit's side – refresh will settle the status.
    await refreshRecording(rec);
  }
}

/** Update our record from LiveKit's view of the egress (webhook or polling). */
export async function applyEgressInfo(info: EgressInfo): Promise<void> {
  const status = Number(info.status);
  const done = status === EGRESS.COMPLETE;
  const failed = status === EGRESS.FAILED || status === EGRESS.ABORTED || status === EGRESS.LIMIT_REACHED;
  if (!done && !failed) return;
  const file = info.fileResults?.[0];
  await RecordingModel.updateOne(
    { egressId: info.egressId },
    {
      $set: {
        status: done ? 'complete' : 'failed',
        endedAt: new Date(),
        ...(file?.duration ? { durationSec: Math.round(Number(file.duration) / 1e9) } : {}),
        ...(file?.size ? { sizeBytes: Number(file.size) } : {}),
        ...(failed && info.error ? { error: info.error } : {}),
      },
    },
  );
}

/** Without a public webhook URL, ask LiveKit directly about recordings still marked active. */
export async function refreshRecording(rec: RecordingDoc): Promise<void> {
  try {
    const [info] = await egressClient().listEgress({ egressId: rec.egressId });
    if (info) await applyEgressInfo(info);
  } catch {
    /* LiveKit unreachable – keep the current status */
  }
}

/** Delete recordings (database rows and the video files in the bucket). */
export async function deleteRecordings(filter: Record<string, unknown>): Promise<number> {
  const recs = await RecordingModel.find(filter).select({ fileKey: 1 }).lean();
  if (recs.length === 0) return 0;
  if (recordingConfigured()) {
    await Promise.allSettled(
      recs.map((r) => s3Client().send(new DeleteObjectCommand({ Bucket: env.RECORDING_S3_BUCKET!, Key: r.fileKey }))),
    );
  }
  await RecordingModel.deleteMany({ _id: { $in: recs.map((r) => r._id) } });
  return recs.length;
}

/** Short-lived download link; the bucket itself stays private. */
export async function downloadUrl(rec: RecordingDoc, filename: string): Promise<string> {
  return getSignedUrl(
    s3Client(),
    new GetObjectCommand({
      Bucket: env.RECORDING_S3_BUCKET!,
      Key: rec.fileKey,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    }),
    { expiresIn: 15 * 60 },
  );
}
