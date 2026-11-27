import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { ConnectionState, createLocalAudioTrack, createLocalVideoTrack, type LocalAudioTrack, type LocalVideoTrack } from 'livekit-client';
import { AuthService, apiErrorMessage } from '../core/auth.service';
import { MeetingsService, meetingLink, type LobbyMeeting, type MeetingSettings } from '../core/meetings.service';
import { Icon } from '../shared/icon';
import { Modal } from '../shared/modal';
import { ToastService } from '../shared/toast';
import { UserMenu } from '../shared/user-menu';
import { ParticipantTile } from './participant-tile';
import { REACTIONS, RoomService, readDevicePrefs, saveDevicePrefs, type ParticipantView } from './room.service';
import { Captions } from './captions';
import { ReactionOverlay, ReactionPicker } from './reactions';
import { SettingsDialog } from './settings-dialog';
import { SidePanel, type PanelTab } from './side-panel';
import { VideoTrackView } from './video-track';

type Phase = 'loading' | 'notfound' | 'error' | 'lobby' | 'joining' | 'room' | 'after';

const GUEST_NAME_KEY = 'aumeet_guest_name';
const DEVICE_PREFS_KEY = 'aumeet_devices';
const CAPTIONS_KEY = 'aumeet_captions';

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function readPrefs(): { mic: boolean; cam: boolean } {
  try {
    return { mic: true, cam: true, ...JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY) ?? '{}') };
  } catch {
    return { mic: true, cam: true };
  }
}

@Component({
  selector: 'app-meeting-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [RoomService],
  imports: [
    Icon, Modal, UserMenu, RouterLink, ParticipantTile, SidePanel, VideoTrackView,
    Captions, ReactionOverlay, ReactionPicker, SettingsDialog,
  ],
  host: { '(document:keydown)': 'onKey($event)', '(document:click)': 'onDocClick($event)' },
  templateUrl: './meeting-page.html',
  styleUrl: './meeting-page.scss',
})
export class MeetingPage implements OnDestroy {
  /** Route param, bound via withComponentInputBinding. */
  readonly code = input.required<string>();

  protected readonly auth = inject(AuthService);
  protected readonly rs = inject(RoomService);
  private readonly meetings = inject(MeetingsService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly title = inject(Title);

  protected readonly phase = signal<Phase>('loading');
  protected readonly meeting = signal<LobbyMeeting | null>(null);
  protected readonly errorText = signal<string | null>(null);

  // lobby state
  protected readonly micOn = signal(readPrefs().mic);
  protected readonly camOn = signal(readPrefs().cam);
  protected readonly previewVideo = signal<LocalVideoTrack | null>(null);
  private previewAudio: LocalAudioTrack | null = null;
  protected readonly camError = signal<string | null>(null);
  protected readonly micError = signal<string | null>(null);
  protected readonly guestName = signal(readGuestName());
  protected readonly joinError = signal<string | null>(null);
  /** Lobby privacy choice: let the AI transcribe me. */
  protected readonly transcribeMe = signal(true);
  protected readonly lobbyMics = signal<MediaDeviceInfo[]>([]);
  protected readonly lobbyCams = signal<MediaDeviceInfo[]>([]);
  protected readonly devicePrefs = signal(readDevicePrefs());

  // room state
  protected readonly panel = signal<PanelTab | null>(null);
  protected readonly leaveDialog = signal(false);
  protected readonly ending = signal(false);
  protected readonly now = signal(Date.now());
  protected readonly captionsOn = signal(readFlag(CAPTIONS_KEY, false));
  protected readonly settingsOpen = signal(false);
  protected readonly reactOpen = signal(false);
  protected readonly removing = signal<ParticipantView | null>(null);
  protected readonly savingSettings = signal(false);
  private clock?: ReturnType<typeof setInterval>;

  protected readonly isGuest = computed(() => !this.auth.isAuthenticated());
  protected readonly isHost = computed(() => !!this.meeting()?.isHost);
  protected readonly needsSignIn = computed(() => this.isGuest() && this.meeting()?.settings.allowGuests === false);
  protected readonly displayName = computed(() => this.auth.user()?.name ?? (this.guestName().trim() || 'You'));
  protected readonly reconnecting = computed(() => this.rs.connection() === ConnectionState.Reconnecting);
  protected readonly tiles = computed(() => this.rs.participants());
  /** Decisions the AI flagged as unresolved – highlighted on the Insights button. */
  protected readonly needsConfirmation = computed(
    () => this.rs.insights()?.decisions.filter((d) => d.status === 'disputed').length ?? 0,
  );

  /** Grid columns for the current participant count. */
  protected readonly cols = computed(() => {
    const n = this.tiles().length;
    return n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  });

  private readonly audioHost = viewChild<ElementRef<HTMLElement>>('audioHost');
  private readonly guestInput = viewChild<ElementRef<HTMLInputElement>>('guestInput');

  constructor() {
    effect(() => {
      const el = this.audioHost()?.nativeElement;
      if (el) this.rs.setAudioHost(el);
    });
    // Load (or reload) whenever the code in the URL changes.
    effect(() => {
      const code = this.code();
      untracked(() => void this.load(code));
    });
    // Room ended from the server side (host ended / removed / network lost).
    effect(() => {
      if (this.rs.endReason() && this.phase() === 'room') {
        this.phase.set('after');
        this.panel.set(null);
        clearInterval(this.clock);
      }
    });
    effect(() => this.rs.setChatOpen(this.panel() === 'chat'));
    effect(() => {
      if (this.rs.mutedByHost() > 0) untracked(() => this.toast.show('The host muted your microphone'));
    });
  }

  ngOnDestroy(): void {
    this.stopPreview();
    clearInterval(this.clock);
  }

  // ---------- loading & lobby ----------

  private async load(code: string): Promise<void> {
    this.phase.set('loading');
    try {
      const m = await this.meetings.get(code);
      this.meeting.set(m);
      this.title.setTitle(`${m.title} · AuMeet`);
      if (m.status === 'ended') {
        this.phase.set('after');
        this.rs.endReason.set('ended');
        return;
      }
      this.phase.set('lobby');
      await this.startPreview();
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 404) this.phase.set('notfound');
      else {
        this.errorText.set(apiErrorMessage(err, 'Could not load this meeting.'));
        this.phase.set('error');
      }
    }
  }

  private async startPreview(): Promise<void> {
    if (this.camOn()) await this.enablePreviewCam();
    if (this.micOn()) await this.enablePreviewMic();
    // Labels are only visible once permission was granted, so list devices after the preview starts.
    const [mics, cams] = await Promise.all([this.rs.listDevices('audioinput'), this.rs.listDevices('videoinput')]);
    this.lobbyMics.set(mics);
    this.lobbyCams.set(cams);
  }

  protected async pickLobbyDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void> {
    const prefs = { ...readDevicePrefs(), [kind]: deviceId };
    saveDevicePrefs(prefs);
    this.devicePrefs.set(prefs);
    if (kind === 'videoinput' && this.camOn()) {
      this.previewVideo()?.stop();
      this.previewVideo.set(null);
      await this.enablePreviewCam();
    } else if (kind === 'audioinput' && this.micOn()) {
      this.previewAudio?.stop();
      this.previewAudio = null;
      await this.enablePreviewMic();
    }
  }

  private async enablePreviewCam(): Promise<void> {
    try {
      this.camError.set(null);
      const deviceId = this.devicePrefs().videoinput;
      const t = await createLocalVideoTrack({ resolution: { width: 1280, height: 720 }, ...(deviceId ? { deviceId } : {}) });
      if (this.phase() !== 'lobby' || !this.camOn()) return t.stop();
      this.previewVideo.set(t);
    } catch (e) {
      this.camOn.set(false);
      this.camError.set(deviceError(e, 'camera'));
    }
  }

  private async enablePreviewMic(): Promise<void> {
    try {
      this.micError.set(null);
      const deviceId = this.devicePrefs().audioinput;
      const t = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, ...(deviceId ? { deviceId } : {}) });
      if (this.phase() !== 'lobby' || !this.micOn()) return t.stop();
      this.previewAudio = t;
    } catch (e) {
      this.micOn.set(false);
      this.micError.set(deviceError(e, 'microphone'));
    }
  }

  private stopPreview(): void {
    this.previewVideo()?.stop();
    this.previewVideo.set(null);
    this.previewAudio?.stop();
    this.previewAudio = null;
  }

  protected async lobbyToggleCam(): Promise<void> {
    const on = !this.camOn();
    this.camOn.set(on);
    this.savePrefs();
    if (on) await this.enablePreviewCam();
    else {
      this.previewVideo()?.stop();
      this.previewVideo.set(null);
    }
  }

  protected async lobbyToggleMic(): Promise<void> {
    const on = !this.micOn();
    this.micOn.set(on);
    this.savePrefs();
    if (on) await this.enablePreviewMic();
    else {
      this.previewAudio?.stop();
      this.previewAudio = null;
    }
  }

  protected async join(): Promise<void> {
    const m = this.meeting();
    if (!m || this.phase() === 'joining') return;
    if (this.isGuest()) {
      const name = this.guestName().trim();
      if (!name) {
        this.joinError.set('Enter your name so others know who you are.');
        this.guestInput()?.nativeElement.focus();
        return;
      }
      try {
        localStorage.setItem(GUEST_NAME_KEY, name);
      } catch {
        /* ignore */
      }
    }

    this.joinError.set(null);
    this.phase.set('joining');
    try {
      const res = await this.meetings.join(m.code, {
        name: this.isGuest() ? this.guestName().trim() : undefined,
        transcribe: m.settings.aiEnabled ? this.transcribeMe() : undefined,
      });
      // Hand the devices over to LiveKit (it opens its own tracks with the same permissions).
      this.stopPreview();
      await this.rs.connect(res.livekit.url, res.livekit.token, { mic: this.micOn(), cam: this.camOn() });
      this.phase.set('room');
      this.now.set(Date.now());
      this.clock = setInterval(() => this.now.set(Date.now()), 15_000);
    } catch (err) {
      this.phase.set('lobby');
      void this.startPreview();
      this.joinError.set(
        err instanceof HttpErrorResponse
          ? apiErrorMessage(err, 'Could not join the meeting.')
          : 'Could not connect to the meeting server. Check your connection and try again.',
      );
      if (err instanceof HttpErrorResponse && err.status === 410) {
        this.phase.set('after');
        this.rs.endReason.set('ended');
      }
    }
  }

  // ---------- in-room controls ----------

  protected async toggleMic(): Promise<void> {
    try {
      await this.rs.toggleMic();
    } catch (e) {
      this.toast.error(deviceError(e, 'microphone'));
    }
  }

  protected async toggleCam(): Promise<void> {
    try {
      await this.rs.toggleCam();
    } catch (e) {
      this.toast.error(deviceError(e, 'camera'));
    }
  }

  protected async toggleScreen(): Promise<void> {
    const other = this.rs.screenShare();
    if (other && !other.isLocal) {
      this.toast.show(`${other.name} is already presenting`);
      return;
    }
    try {
      await this.rs.toggleScreen();
    } catch (e) {
      // NotAllowedError = user closed the picker; nothing to report.
      if ((e as Error)?.name !== 'NotAllowedError') this.toast.error('Screen sharing is not available in this browser.');
    }
  }

  protected async toggleHand(): Promise<void> {
    try {
      await this.rs.toggleHand();
    } catch {
      this.toast.error('Could not raise your hand right now.');
    }
  }

  protected async react(emoji: (typeof REACTIONS)[number]): Promise<void> {
    this.reactOpen.set(false);
    try {
      await this.rs.react(emoji);
    } catch {
      /* reactions are best-effort */
    }
  }

  protected setCaptions(on: boolean): void {
    this.captionsOn.set(on);
    try {
      localStorage.setItem(CAPTIONS_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  /** Host: lock / AI on-off / proactive, applied live by the server. */
  protected async changeSetting(settings: Partial<MeetingSettings>): Promise<void> {
    const m = this.meeting();
    if (!m) return;
    this.savingSettings.set(true);
    try {
      const updated = await this.meetings.update(m.code, { settings });
      this.meeting.set({ ...m, settings: updated.settings });
      if (settings.locked !== undefined) this.toast.show(settings.locked ? 'Meeting locked' : 'Meeting unlocked');
      if (settings.aiEnabled !== undefined) this.toast.show(settings.aiEnabled ? 'Inviting the AI participant…' : 'AI participant removed');
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not change that setting.'));
    } finally {
      this.savingSettings.set(false);
    }
  }

  protected async muteParticipant(identity: string): Promise<void> {
    try {
      await this.meetings.muteParticipant(this.code(), identity);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not mute them.'));
    }
  }

  protected async confirmRemove(): Promise<void> {
    const p = this.removing();
    if (!p) return;
    this.removing.set(null);
    try {
      if (p.isAgent) await this.changeSetting({ aiEnabled: false });
      else await this.meetings.removeParticipant(this.code(), p.identity);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not remove them.'));
    }
  }

  protected onDocClick(e: MouseEvent): void {
    if (this.reactOpen() && !(e.target as HTMLElement).closest('.react-wrap')) this.reactOpen.set(false);
  }

  protected togglePanel(tab: PanelTab): void {
    this.panel.set(this.panel() === tab ? null : tab);
  }

  protected onLeaveClick(): void {
    if (this.isHost()) this.leaveDialog.set(true);
    else void this.leave();
  }

  protected async leave(): Promise<void> {
    this.leaveDialog.set(false);
    await this.rs.leave();
  }

  protected async endForAll(): Promise<void> {
    const m = this.meeting();
    if (!m || this.ending()) return;
    this.ending.set(true);
    try {
      await this.meetings.end(m.code);
      await this.rs.leave();
      this.rs.endReason.set('ended');
      this.leaveDialog.set(false);
    } catch (err) {
      this.toast.error(apiErrorMessage(err, 'Could not end the meeting.'));
    } finally {
      this.ending.set(false);
    }
  }

  protected async rejoin(): Promise<void> {
    this.rs.endReason.set(null);
    this.rs.messages.set([]);
    await this.load(this.code());
  }

  protected async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(meetingLink(this.code()));
      this.toast.show('Meeting link copied');
    } catch {
      this.toast.error('Could not copy the link.');
    }
  }

  protected clockText(): string {
    return new Date(this.now()).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** Ctrl/Cmd+D mic, Ctrl/Cmd+E camera – same as Google Meet. */
  protected onKey(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'd' && k !== 'e') return;
    if (this.phase() === 'room') {
      e.preventDefault();
      void (k === 'd' ? this.toggleMic() : this.toggleCam());
    } else if (this.phase() === 'lobby') {
      e.preventDefault();
      void (k === 'd' ? this.lobbyToggleMic() : this.lobbyToggleCam());
    }
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify({ mic: this.micOn(), cam: this.camOn() }));
    } catch {
      /* ignore */
    }
  }

  protected goHome(): void {
    void this.router.navigateByUrl(this.auth.isAuthenticated() ? '/' : '/login');
  }
}

function readGuestName(): string {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function deviceError(e: unknown, device: 'camera' | 'microphone'): string {
  const name = (e as Error)?.name;
  if (name === 'NotAllowedError') return `Allow ${device} access in your browser's address bar to use it.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${device} found.`;
  if (name === 'NotReadableError') return `Your ${device} is being used by another app.`;
  return `Could not start your ${device}.`;
}
