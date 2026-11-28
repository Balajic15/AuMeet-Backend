/**
 * Several people on one device (a conference-room laptop): Deepgram diarization tells voices
 * apart; this names them. Voices start as "Room laptop (voice 2)" and take a real name as soon
 * as someone introduces themselves ("I'm Priya", "this is Ravi", "my name is Mei").
 */

// Intro words in any case; the name itself must be capitalised (speech-to-text capitalises names).
const INTRO = /\b(?:[Ii] am|[Ii]'m|[Ii]m|[Tt]his is|[Mm]y name is|[Ii]t's|[Ii]t is)\s+([A-Z][a-zA-Z'-]{1,30})(?:\s+([A-Z][a-zA-Z'-]{1,30}))?\b/;
/** Words that look like names after "I'm"/"it's" but aren't. */
const NOT_NAMES = new Set([
  'Sorry', 'Sure', 'Fine', 'Good', 'Great', 'Okay', 'Ok', 'Here', 'Back', 'Done', 'Ready', 'Not', 'Just', 'Also',
  'Going', 'Happy', 'Glad', 'Late', 'Busy', 'Muted', 'Talking', 'Speaking', 'Still', 'The', 'That', 'This', 'It',
  'AuMeet', 'Maaya', 'Maya', 'Thinking', 'Working', 'Trying', 'Looking', 'Saying', 'Agreeing', 'Wondering',
]);

/** "I'm Priya" → "Priya"; null when the sentence isn't a self-introduction. */
export function selfIntroduction(text: string): string | null {
  const m = text.match(INTRO);
  if (!m) return null;
  const first = m[1]!;
  if (NOT_NAMES.has(first)) return null;
  const last = m[2] && !NOT_NAMES.has(m[2]) ? m[2] : null;
  return last ? `${first} ${last}` : first;
}

export class SharedDeviceVoices {
  /** identity → (Deepgram speaker id → display name) */
  private readonly names = new Map<string, Map<string, string>>();

  /**
   * Display name for an utterance. Without a speaker id (device not shared) it's simply the
   * participant's name.
   */
  label(identity: string, deviceName: string, speakerId: string | null, text: string): string {
    if (speakerId === null) return deviceName;
    let voices = this.names.get(identity);
    if (!voices) {
      voices = new Map();
      this.names.set(identity, voices);
    }
    const intro = selfIntroduction(text);
    if (intro) voices.set(speakerId, intro);
    return voices.get(speakerId) ?? `${deviceName} (voice ${Number(speakerId) + 1 || speakerId})`;
  }

  forget(identity: string): void {
    this.names.delete(identity);
  }
}
