import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type MeetingStatus = 'idle' | 'live' | 'ended';

export interface MeetingSettings {
  allowGuests: boolean;
  aiEnabled: boolean;
  /** AI may speak up without being asked. */
  aiProactive: boolean;
  /** Nobody new can join (except the host). */
  locked: boolean;
}

export interface Meeting {
  id: string;
  code: string;
  title: string;
  hostId: string;
  status: MeetingStatus;
  settings: MeetingSettings;
  scheduledFor: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface LobbyMeeting extends Meeting {
  hostName: string;
  isHost: boolean;
}

export type ParticipantRole = 'host' | 'participant' | 'guest';

export interface JoinResponse {
  livekit: { url: string; token: string };
  participant: { identity: string; name: string; role: ParticipantRole };
  meeting: Meeting;
}

export interface CreateMeetingInput {
  title?: string;
  scheduledFor?: string;
  settings?: Partial<MeetingSettings>;
}

export interface UpdateMeetingInput {
  title?: string;
  scheduledFor?: string | null;
  settings?: Partial<MeetingSettings>;
}

export const MEETING_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Accepts `abc-defg-hij`, `abcdefghij`, or any link containing a code. */
export function parseMeetingCode(input: string): string | null {
  const s = input.trim().toLowerCase();
  const dashed = s.match(/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z])/);
  if (dashed) return dashed[1]!;
  if (/^[a-z]{10}$/.test(s)) return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
  return null;
}

export function meetingLink(code: string): string {
  return `${window.location.origin}/${code}`;
}

@Injectable({ providedIn: 'root' })
export class MeetingsService {
  private readonly http = inject(HttpClient);

  async list(): Promise<Meeting[]> {
    return (await firstValueFrom(this.http.get<{ meetings: Meeting[] }>('/api/meetings'))).meetings;
  }

  async create(input: CreateMeetingInput = {}): Promise<Meeting> {
    return (await firstValueFrom(this.http.post<{ meeting: Meeting }>('/api/meetings', input))).meeting;
  }

  async get(code: string): Promise<LobbyMeeting> {
    return (await firstValueFrom(this.http.get<{ meeting: LobbyMeeting }>(`/api/meetings/${code}`))).meeting;
  }

  async update(code: string, input: UpdateMeetingInput): Promise<Meeting> {
    return (await firstValueFrom(this.http.patch<{ meeting: Meeting }>(`/api/meetings/${code}`, input))).meeting;
  }

  join(code: string, opts: { name?: string; transcribe?: boolean } = {}): Promise<JoinResponse> {
    return firstValueFrom(this.http.post<JoinResponse>(`/api/meetings/${code}/join`, opts));
  }

  /** Host only. Emails a join link (and a calendar file for scheduled meetings). */
  invite(code: string, emails: string[], message?: string): Promise<{ sent: number }> {
    return firstValueFrom(this.http.post<{ sent: number }>(`/api/meetings/${code}/invite`, { emails, message }));
  }

  /** Host only. */
  muteParticipant(code: string, identity: string, source: 'microphone' | 'camera' | 'screen' = 'microphone'): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/meetings/${code}/participants/${encodeURIComponent(identity)}/mute`, { source }));
  }

  /** Host only. */
  removeParticipant(code: string, identity: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`/api/meetings/${code}/participants/${encodeURIComponent(identity)}/remove`, {}));
  }

  async end(code: string): Promise<Meeting> {
    return (await firstValueFrom(this.http.post<{ meeting: Meeting }>(`/api/meetings/${code}/end`, {}))).meeting;
  }
}
