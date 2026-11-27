import { env } from '../config/env.js';

/** Public invite link for a meeting, e.g. https://meet.example.com/abc-defg-hij */
export function meetingLinkFor(code: string): string {
  return `${env.WEB_URL.replace(/\/$/, '')}/${code}`;
}
