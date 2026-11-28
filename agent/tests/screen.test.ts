import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { changeScore, downscale, encodePng, thumbnail, type Rgba } from '../src/screen/image.js';
import { renderScreen, ScreenIntel, type VisionOutput } from '../src/screen/vision.js';
import { normalize } from '../src/intel/normalize.js';
import { renderNotes } from '../src/intel/render.js';
import { emptyInsights } from '../src/intel/schema.js';

function solid(w: number, h: number, rgb: [number, number, number], box?: { x: number; y: number; w: number; h: number; rgb: [number, number, number] }): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBox = box && x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      const c = inBox ? box!.rgb : rgb;
      data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

describe('screen images', () => {
  it('downscales to a bounded size and encodes a valid PNG', () => {
    const img = solid(1920, 1080, [240, 240, 240], { x: 0, y: 1000, w: 1920, h: 80, rgb: [20, 20, 20] });
    const small = downscale(img, 1280);
    expect([small.width, small.height]).toEqual([1280, 720]);
    const png = encodePng(small);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(1280); // IHDR width
    // IDAT inflates back to rows of (filter byte + RGBA).
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((1280 * 4 + 1) * 720);
  });

  it('a new error banner counts as a change; small noise does not', () => {
    const base = solid(1280, 720, [240, 240, 240]);
    const noisy = solid(1280, 720, [245, 245, 245]);
    const banner = solid(1280, 720, [240, 240, 240], { x: 0, y: 600, w: 1280, h: 120, rgb: [200, 30, 30] });
    expect(changeScore(thumbnail(base), thumbnail(noisy))).toBe(0);
    expect(changeScore(thumbnail(base), thumbnail(banner))).toBeGreaterThan(0.1);
  });
});

const obs = (summary: string): VisionOutput => ({
  app: 'Chrome – login', summary, visibleErrors: ["TypeError: Cannot read properties of undefined (reading 'submit')"], keyText: ['https://staging.acme.com/login'],
  focus: 'Log in button', issue: { suspected: true, description: 'Login does nothing', actual: 'nothing happens', expected: 'dashboard', steps: ['Click Log in'] },
  relevantToDiscussion: true,
});

describe('screen understanding', () => {
  it('respects the interval and the cap, but answers a request quickly', async () => {
    let t = 0;
    const calls: Array<{ task?: string; images?: unknown[] }> = [];
    const updates: number[] = [];
    const intel = new ScreenIntel({
      call: (async (_s: unknown, o: { task?: string; images?: unknown[] }) => (calls.push(o), obs('Login page'))) as never,
      policy: () => ({ enabled: true, minIntervalSeconds: 20, maxPerTenMinutes: 2, changeThreshold: 0.08, maxSide: 640 }),
      transcript: () => [],
      onUpdate: (s) => updates.push(s.observations.length),
      now: () => t,
    });
    const img = solid(1280, 720, [255, 255, 255]);
    expect(await intel.analyse(img, 'Ravi', 'change')).toMatchObject({ id: 'v1', sharer: 'Ravi', reason: 'change' });
    expect(calls[0]).toMatchObject({ task: 'vision' });
    expect(calls[0]!.images).toHaveLength(1);
    t = 5_000;
    expect(await intel.analyse(img, 'Ravi', 'change')).toBeNull(); // within 20 s
    expect(await intel.analyse(img, 'Ravi', 'request')).not.toBeNull(); // a request is answered
    t = 30_000;
    expect(await intel.analyse(img, 'Ravi', 'change')).toBeNull(); // cap of 2 per 10 min reached (change + request)
    t = 11 * 60_000;
    expect(await intel.analyse(img, 'Ravi', 'change')).not.toBeNull();
    // Switched off: nothing.
    const off = new ScreenIntel({ call: (async () => obs('x')) as never, policy: () => ({ enabled: false, minIntervalSeconds: 1, maxPerTenMinutes: 9, changeThreshold: 0.1, maxSide: 640 }), transcript: () => [], onUpdate: () => {} });
    expect(await off.analyse(img, 'Ravi', 'request')).toBeNull();
  });

  it('puts what was on screen into the notes', () => {
    const state = { sharing: 'Ravi', observations: [{ ...obs('Ravi shows the login page'), id: 'v1', at: '2026-11-28T10:42:00.000Z', sharer: 'Ravi', reason: 'change' as const }] };
    const text = renderScreen(state);
    expect(text).toContain('Ravi is sharing their screen now.');
    expect(text).toContain("Errors: TypeError: Cannot read properties of undefined (reading 'submit')");
    expect(text).toContain('Focus: Log in button');
    const notes = renderNotes({ ...normalize(emptyInsights(), { summary: '', topics: [], decisions: [], actionItems: [], openQuestions: [] }, { validLines: new Set(), people: [], analyzedThrough: 0, now: new Date() }), screen: state });
    expect(notes).toContain('Shared screen (what the AI saw):');
  });
});
