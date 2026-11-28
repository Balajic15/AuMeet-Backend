import { describe, expect, it } from 'vitest';
import { baseLanguage, voiceLanguage } from '../src/language.js';
import { MeetingTranscript } from '../src/transcript.js';

describe('language', () => {
  it('normalises codes and falls back to English for the voice', () => {
    expect(baseLanguage('en-US')).toBe('en');
    expect(baseLanguage('')).toBe('en');
    expect(voiceLanguage('hi')).toBe('hi');
    expect(voiceLanguage('es-419')).toBe('es');
    expect(voiceLanguage('sw')).toBe('en');
  });
});

describe('MeetingTranscript', () => {
  it('keeps speaker attribution and formats lines for the model', () => {
    const t = new MeetingTranscript('abc-defg-hij', 'job1');
    const at = Date.UTC(2026, 10, 26, 10, 42);
    t.add({ speakerId: 'user:a', speakerName: 'Alice', userId: 'a', isAgent: false, channel: 'voice', text: "Let's use MongoDB.", language: 'en', at });
    t.add({ speakerId: 'user:b', speakerName: 'Bob', userId: 'b', isAgent: false, channel: 'chat', text: 'PostgreSQL is better', language: '', at });
    t.add({ speakerId: 'agent', speakerName: 'Maaya', userId: null, isAgent: true, channel: 'voice', text: 'Can we confirm?', language: '', at });

    expect(t.speakers()).toEqual(['Alice', 'Bob']);
    expect(t.format(10, 'UTC')).toBe(
      "[10:42] Alice: Let's use MongoDB.\n[10:42] Bob (in chat): PostgreSQL is better\n[10:42] Maaya (AI): Can we confirm?",
    );
    expect(t.all.map((u) => u.id)).toEqual([1, 2, 3]);
  });
});

describe('shared-device voices', async () => {
  const { SharedDeviceVoices, selfIntroduction } = await import('../src/voices.js');

  it.each([
    ["Hi, I'm Priya and I run design", 'Priya'],
    ['This is Ravi Kumar from sales', 'Ravi Kumar'],
    ['my name is Mei', 'Mei'],
    ["I'm sorry, can you repeat that", null],
    ["I'm not sure", null],
    ['we should ship it', null],
  ])('selfIntroduction(%j) → %j', (text, name) => expect(selfIntroduction(text)).toBe(name));

  it('labels voices on a shared device and learns names from introductions', () => {
    const v = new SharedDeviceVoices();
    expect(v.label('user:1', 'Asha', null, 'hello')).toBe('Asha'); // not a shared device
    expect(v.label('room:a', 'Room A', '0', 'Morning all')).toBe('Room A (voice 1)');
    expect(v.label('room:a', 'Room A', '1', "Hi, I'm Priya")).toBe('Priya');
    expect(v.label('room:a', 'Room A', '1', 'I think PostgreSQL is better')).toBe('Priya');
    expect(v.label('room:a', 'Room A', '0', 'Agreed')).toBe('Room A (voice 1)');
    v.forget('room:a');
    expect(v.label('room:a', 'Room A', '1', 'again')).toBe('Room A (voice 2)');
  });
});
