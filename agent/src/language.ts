import { getBaseLanguage, toLanguageName } from '@livekit/agents';

/**
 * Languages Cartesia Sonic speaks well. Anything else falls back to English for the
 * *voice* (the AI is still told which language the person used).
 */
const VOICE_LANGUAGES = new Set([
  'en', 'fr', 'de', 'es', 'pt', 'zh', 'ja', 'hi', 'it', 'ko', 'nl', 'pl', 'ru', 'sv', 'tr',
]);

/** `en-US` → `en`; empty/unknown → `en`. */
export function baseLanguage(lang: string | null | undefined): string {
  if (!lang) return 'en';
  try {
    return getBaseLanguage(lang).toLowerCase() || 'en';
  } catch {
    return lang.split(/[-_]/)[0]!.toLowerCase() || 'en';
  }
}

export function voiceLanguage(lang: string | null | undefined): string {
  const base = baseLanguage(lang);
  return VOICE_LANGUAGES.has(base) ? base : 'en';
}

export function languageName(lang: string | null | undefined): string {
  const base = baseLanguage(lang);
  try {
    return toLanguageName(base) ?? base;
  } catch {
    return base;
  }
}
