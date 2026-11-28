/**
 * Real-model check of screen understanding: a screenshot (PNG) plus what was said → what the AI sees.
 *   npx tsx eval/vision-check.ts path/to/screen.png "Ravi: This login button is not responding."
 */
import { readFileSync } from 'node:fs';
import { initializeLogger } from '@livekit/agents';
import { geminiKeysFromEnv } from '../src/ai/pool.js';
import { config } from '../src/config.js';
import { geminiStructured, parseModels } from '../src/gemini.js';
import { formatUtterances } from '../src/transcript.js';
import { fence } from '../src/untrusted.js';
import { VISION_SYSTEM, VisionOutput } from '../src/screen/vision.js';

initializeLogger({ pretty: false, level: 'warn' });
const cfg = config();
const [file, ...said] = process.argv.slice(2);
const call = geminiStructured({ apiKeys: geminiKeysFromEnv(process.env), models: parseModels(cfg.GEMINI_MODEL, cfg.GEMINI_FALLBACK_MODELS), thinking: cfg.GEMINI_THINKING, env: process.env });
const lines = said.map((l, i) => {
  const [who, ...rest] = l.split(':');
  return { id: i + 1, speakerId: who!, speakerName: who!.trim(), userId: null, isAgent: false, channel: 'voice' as const, text: rest.join(':').trim(), language: '', at: Date.now() };
});
const t = Date.now();
const out = await call(VisionOutput, {
  system: VISION_SYSTEM,
  task: 'vision',
  images: [{ mimeType: 'image/png', data: readFileSync(file!).toString('base64') }],
  prompt: [`${lines[0]?.speakerName ?? 'Someone'} is sharing their screen.`, fence('RECENT CONVERSATION (UTC)', formatUtterances(lines, 'UTC')), 'Describe the attached screenshot.'].join('\n\n'),
});
console.log(`${Date.now() - t} ms`);
console.log(JSON.stringify(out, null, 1));
const ok = out.visibleErrors.some((e) => /TypeError/.test(e)) && /log ?in/i.test(out.focus + out.issue.description) && out.issue.suspected;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
