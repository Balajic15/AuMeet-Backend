/**
 * Decides whether an utterance is meant for the AI.
 *
 * Step 3 keeps this rule-based and predictable: the AI answers when someone says its
 * name, or when the person it just answered follows up shortly after. Step 5
 * (adaptive intervention) adds model-based judgement on top of this.
 */

// "AuMeet" is a new word, so speech-to-text often hears it as something close.
// Deepgram also gets "AuMeet" as a keyterm to bias recognition toward the right spelling.
const NAME_PATTERNS = [
  /\bau\s?-?meet\b/i,
  /\b(?:oh|o|all|aw|ow|or)\s?meet\b/i,
  /\bhey\s+meet\b/i,
];

/** Pure-ASCII names miss scripts like Devanagari; these cover what people actually say there. */
const NON_LATIN_NAMES = [/ऑमीट|औमीट|ओमीट/];

export function mentionsAgent(text: string): boolean {
  return NAME_PATTERNS.some((re) => re.test(text)) || NON_LATIN_NAMES.some((re) => re.test(text));
}

export interface FollowUpContext {
  /** When the AI last finished speaking (ms epoch), or null if it hasn't spoken. */
  lastAgentReplyAt: number | null;
  /** Identity of the person the AI last answered. */
  lastAddressedBy: string | null;
}

/** How long after the AI speaks a follow-up from the same person still counts as talking to it. */
export const FOLLOW_UP_WINDOW_MS = 10_000;

export function isAddressedToAgent(
  text: string,
  speaker: string,
  now: number,
  ctx: FollowUpContext,
): { addressed: boolean; reason: 'name' | 'follow-up' | null } {
  if (mentionsAgent(text)) return { addressed: true, reason: 'name' };

  const recent = ctx.lastAgentReplyAt !== null && now - ctx.lastAgentReplyAt <= FOLLOW_UP_WINDOW_MS;
  if (recent && ctx.lastAddressedBy === speaker && looksLikeFollowUp(text)) {
    return { addressed: true, reason: 'follow-up' };
  }
  return { addressed: false, reason: null };
}

/**
 * Spoken controls for proactive behaviour. Only checked when the AI is addressed by name,
 * e.g. "AuMeet, stay quiet for now" / "AuMeet, feel free to jump in again".
 */
export function proactivityCommand(text: string): 'quiet' | 'resume' | null {
  if (!mentionsAgent(text)) return null;
  const t = text.toLowerCase();
  if (/\b(stay|be|keep) (quiet|silent)\b|\b(stop|don'?t|do not) (interrupt|jump|chim)\w*|\bonly (speak|talk|answer) when\b|\bmute yourself\b|\bhold off\b/.test(t)) {
    return 'quiet';
  }
  if (/\b(you can|feel free to|go ahead and|please) (speak up|jump in|chime in|interrupt)\b|\bspeak up again\b|\bstart (speaking|talking) again\b/.test(t)) {
    return 'resume';
  }
  return null;
}

/** Questions or direct requests – not "okay", "thanks", or chatter aimed at someone else. */
function looksLikeFollowUp(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.split(/\s+/).length < 2) return false;
  if (/^(ok(ay)?|thanks?|thank you|cool|great|got it|sure|right|yes|no|yeah|nope)\b[.!]?$/.test(t)) return false;
  return /\?\s*$/.test(t) || /^(what|why|how|when|where|who|which|can|could|would|will|should|is|are|do|does|did|tell|explain|summari[sz]e|remind|repeat|and)\b/.test(t);
}
