/**
 * Smoke test for spoken/chat replies: streams one answer through the SAME fallback setup the agent uses
 * (google.LLM per model + FallbackAdapter with the configured attempt deadline).
 *   npx tsx eval/voice-check.ts
 */
import { initializeLogger, llm } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { ThinkingLevel } from '@google/genai';
import { config } from '../src/config.js';
import { parseModels } from '../src/gemini.js';

initializeLogger({ pretty: false, level: 'warn' });
const cfg = config();
const models = parseModels(cfg.GEMINI_MODEL, cfg.GEMINI_FALLBACK_MODELS);
const one = (model: string) =>
  new google.LLM({
    apiKey: cfg.GOOGLE_API_KEY,
    model,
    temperature: 0.4,
    ...(cfg.GEMINI_THINKING !== 'off' ? { thinkingConfig: { thinkingLevel: cfg.GEMINI_THINKING === 'low' ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL } } : {}),
  });
const brain = new llm.FallbackAdapter({ llms: models.map(one), attemptTimeout: Math.max(10, cfg.VOICE_LLM_TIMEOUT_SECONDS), maxRetryPerLLM: 0 });

const chat = llm.ChatContext.empty();
chat.addMessage({ role: 'system', content: 'You are an AI participant in a meeting. Answer in one short sentence.' });
chat.addMessage({ role: 'user', content: "Balaji: What's the plan today?" });
const t = Date.now();
let out = '';
for await (const c of brain.chat({ chatCtx: chat })) out += c.delta?.content ?? '';
console.log(out.trim() ? `OK in ${Date.now() - t} ms: ${out.trim()}` : 'FAILED: empty reply');
process.exit(out.trim() ? 0 : 1);
