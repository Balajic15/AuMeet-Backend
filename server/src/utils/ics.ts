/** Minimal RFC 5545 calendar invite (works in Google Calendar, Outlook, Apple Calendar). */

const pad = (n: number) => String(n).padStart(2, '0');

function utcStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Escape TEXT values: backslash, semicolon, comma and newlines. */
export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets must be folded (continuation lines start with a space). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildIcs(opts: {
  uid: string;
  title: string;
  start: Date;
  durationMinutes?: number;
  url: string;
  description?: string;
  organizerName?: string;
}): string {
  const end = new Date(opts.start.getTime() + (opts.durationMinutes ?? 60) * 60_000);
  const description = [opts.description, `Join: ${opts.url}`].filter(Boolean).join('\n\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AuMeet//Meetings//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.uid}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART:${utcStamp(opts.start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(opts.url)}`,
    `URL:${opts.url}`,
    ...(opts.organizerName ? [`ORGANIZER;CN=${icsEscape(opts.organizerName)}:mailto:no-reply@aumeet.local`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n');
}
