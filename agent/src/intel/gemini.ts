import type { StructuredCall } from '../gemini.js';
import { AnalystOutput, type ModelOutput } from './schema.js';

/** Produces the next set of notes. Injected so tests can run without the API. */
export type AnalyzeFn = (system: string, prompt: string) => Promise<ModelOutput>;

export function geminiAnalyzer(call: StructuredCall): AnalyzeFn {
  // Low temperature: notes should be stable between runs.
  return (system, prompt) => call(AnalystOutput, { system, prompt, temperature: 0.1 }) as Promise<ModelOutput>;
}
