import { customAlphabet } from 'nanoid';

const letters = customAlphabet('abcdefghijklmnopqrstuvwxyz', 10);

/** Google-Meet style code: `abc-defg-hij` (~47 bits of entropy). */
export function generateMeetingCode(): string {
  const s = letters();
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
}

export const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
