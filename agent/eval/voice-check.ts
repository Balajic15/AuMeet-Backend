/**
 * Smoke test for spoken/chat replies: streams answers through the SAME setup the agent uses (google.LLM per model
 * + FallbackAdapter with the configured attempt deadline, the real meeting instructions and seed behaviour), and
 * checks they sound like a person: use the name, short, no assistant clichés.
 *   npx tsx eval/voice-check.ts
 */
import { readFileSync } from 'node:fs';
import { initializeLogger, llm } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { ThinkingLevel } from '@google/genai';
import { resolveBehaviour } from '../src/behaviour.js';
import { config } from '../src/config.js';
import { parseModels } from '../src/gemini.js';
import { geminiKeysFromEnv } from '../src/ai/pool.js';
import { meetingInstructions, notesSection, replyInstruction } from '../src/prompts.js';

initializeLogger({ pretty: false, level: 'warn' });
const cfg = config();
const SEED = JSON.parse(readFileSync(new URL('../../server/src/config/ai-behaviour.seed.json', import.meta.url), 'utf8'));
const behaviour = resolveBehaviour(SEED)!;
const models = parseModels(cfg.GEMINI_MODEL, cfg.GEMINI_FALLBACK_MODELS);
const one = (model: string) =>
  new google.LLM({
    apiKey: geminiKeysFromEnv(process.env)[0]!,
    model,
    temperature: 0.4,
    ...(cfg.GEMINI_THINKING !== 'off' ? { thinkingConfig: { thinkingLevel: cfg.GEMINI_THINKING === 'low' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL } } : {}),
  });
const brain = new llm.FallbackAdapter({ llms: models.map(one), attemptTimeout: Math.max(10, cfg.VOICE_LLM_TIMEOUT_SECONDS), maxRetryPerLLM: 0 });

const CLICHES = /as an ai|language model|how (may|can) i assist|certainly!|great question|i'm here to help you with/i;
let failed = 0;

async function say(lines: string[], speaker: string, language = 'English', mustNot?: RegExp) {
  const chat = llm.ChatContext.empty();
  chat.addMessage({ role: 'system', content: `${meetingInstructions({ meetingCode: 'x', title: 'Weekly sync' }, behaviour)}\n\n${notesSection('')}` });
  for (const l of lines) chat.addMessage({ role: 'user', content: l });
  chat.addMessage({ role: 'system', content: replyInstruction(speaker, language, 'they addressed you by name') });
  const t = Date.now();
  let out = '';
  for await (const c of brain.chat({ chatCtx: chat })) out += c.delta?.content ?? '';
  out = out.trim();
  const words = out.split(/\s+/).filter(Boolean).length;
  const ok =
    !!out && !CLICHES.test(out) && !/instruction/i.test(out) && words <= 45 &&
    out.toLowerCase().includes(speaker.toLowerCase().split(' ')[0]!.toLowerCase()) && !(mustNot && mustNot.test(out));
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} (${Date.now() - t} ms, ${words} words) ${lines.at(-1)}\n     → ${out || '(empty)'}`);
}

await say(['Balaji: Hi Maaya'], 'Balaji');
await say(['Balaji: Hi Maaya, how are you doing today?'], 'Balaji');
await say(['Priya: Hey Maaya, kya haal hai? Aaj ka plan kya hai?'], 'Priya', 'Hindi');
// Nothing was discussed yet: it must not invent open items.
await say(['Ravi: This launch is stressing me out.', 'Ravi: Maaya, can you just tell me what is still open?'], 'Ravi', 'English', /release|QA|testing|deadline|budget|date/i);
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
