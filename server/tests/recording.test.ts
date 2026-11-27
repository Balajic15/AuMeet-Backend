import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tokenFrom } from './session.js';

const fakes = vi.hoisted(() => ({
  setRoomSettings: vi.fn(async () => {}),
  started: 0,
}));

vi.mock('../src/services/livekit.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/livekit.js')>()),
  setRoomSettings: fakes.setRoomSettings,
}));

vi.mock('../src/services/recording.js', async (orig) => {
  const real = await orig<typeof import('../src/services/recording.js')>();
  const { RecordingModel } = await import('../src/models/Recording.js');
  return {
    ...real,
    recordingConfigured: () => true,
    startRecording: vi.fn(async (meetingCode: string, startedBy: string) =>
      RecordingModel.create({ meetingCode, startedBy, egressId: `EG_${++fakes.started}`, fileKey: `recordings/${meetingCode}/x.mp4` }),
    ),
    stopRecording: vi.fn(async () => {}),
    refreshRecording: vi.fn(async () => {}),
    downloadUrl: vi.fn(async (_rec: unknown, filename: string) => `https://bucket.example/signed?f=${filename}`),
  };
});

const { createApp } = await import('../src/app.js');
const { applyEgressInfo } = await import('../src/services/recording.js');
const app = createApp();
let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await mongoose.connection.syncIndexes();
  fakes.setRoomSettings.mockClear();
});

async function user(email: string) {
  const res = await request(app).post('/api/auth/register').send({ email, name: email.split('@')[0], password: 'password123' });
  return { id: res.body.user.id as string, auth: { Authorization: `Bearer ${tokenFrom(res)}` } };
}

describe('recording', () => {
  it('host starts and stops; everyone is told via room state; members download when complete', async () => {
    const host = await user('h@test.dev');
    const member = await user('m@test.dev');
    const outsider = await user('o@test.dev');
    const { code } = (await request(app).post('/api/meetings').set(host.auth).send({ title: 'Design review' })).body.meeting;
    await request(app).post(`/api/meetings/${code}/join`).set(member.auth);

    expect((await request(app).get(`/api/meetings/${code}`)).body.meeting.recordingAvailable).toBe(true);
    expect((await request(app).post(`/api/meetings/${code}/recording/start`).set(member.auth)).status).toBe(403);

    const start = await request(app).post(`/api/meetings/${code}/recording/start`).set(host.auth);
    expect(start.status).toBe(201);
    expect(fakes.setRoomSettings).toHaveBeenLastCalledWith(code, expect.objectContaining({ aiProactive: true, recording: true }));
    expect((await request(app).post(`/api/meetings/${code}/recording/start`).set(host.auth)).status).toBe(409);

    expect((await request(app).post(`/api/meetings/${code}/recording/stop`).set(host.auth)).status).toBe(200);
    // REC badge goes off immediately, even though the file is still being finalised.
    expect(fakes.setRoomSettings).toHaveBeenLastCalledWith(code, expect.objectContaining({ aiProactive: true, recording: false }));

    // LiveKit reports the file is done (webhook or polling).
    await applyEgressInfo({ egressId: 'EG_1', status: 3, fileResults: [{ duration: 125_000_000_000n, size: 4_200_000n }] } as never);

    const list = await request(app).get(`/api/meetings/${code}/recordings`).set(member.auth);
    expect(list.body.recordings).toMatchObject([{ status: 'complete', durationSec: 125, sizeBytes: 4_200_000 }]);

    const id = list.body.recordings[0].id;
    const dl = await request(app).get(`/api/meetings/${code}/recordings/${id}/download`).set(member.auth);
    expect(dl.status).toBe(302);
    expect(dl.headers.location).toMatch(/^https:\/\/bucket\.example\/signed\?f=Design-review-\d{4}-\d{2}-\d{2}\.mp4$/);

    expect((await request(app).get(`/api/meetings/${code}/recordings`).set(outsider.auth)).status).toBe(403);
    expect((await request(app).get(`/api/meetings/${code}/recordings/${id}/download`).set(outsider.auth)).status).toBe(403);
  });

  it('marks failed recordings and never offers them for download', async () => {
    const host = await user('h@test.dev');
    const { code } = (await request(app).post('/api/meetings').set(host.auth).send({})).body.meeting;
    await request(app).post(`/api/meetings/${code}/recording/start`).set(host.auth);
    await applyEgressInfo({ egressId: `EG_${fakes.started}`, status: 4, error: 'upload failed', fileResults: [] } as never);

    const list = await request(app).get(`/api/meetings/${code}/recordings`).set(host.auth);
    expect(list.body.recordings[0].status).toBe('failed');
    expect((await request(app).get(`/api/meetings/${code}/recordings/${list.body.recordings[0].id}/download`).set(host.auth)).status).toBe(404);
  });
});
