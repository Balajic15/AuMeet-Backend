import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Icon } from '../shared/icon';
import { talkLabel } from '../core/ai.service';
import { initials } from '../shared/user-menu';
import { ToastService } from '../shared/toast';
import { RoomService, type ParticipantView } from './room.service';
import type { Meeting, MeetingSettings } from '../core/meetings.service';
import { InsightsView } from '../shared/insights-view';
import { isEmptyInsights } from '../core/insights';

export type PanelTab = 'chat' | 'people' | 'insights';

@Component({
  selector: 'app-side-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, FormsModule, InsightsView],
  template: `
    <header>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" [class.active]="tab() === 'chat'" (click)="tabChange.emit('chat')">Chat</button>
        <button type="button" role="tab" [class.active]="tab() === 'people'" (click)="tabChange.emit('people')">
          People <span class="count">{{ room.participants().length }}</span>
        </button>
        <button type="button" role="tab" [class.active]="tab() === 'insights'" (click)="tabChange.emit('insights')">
          Insights
        </button>
      </div>
      <button type="button" class="icon-btn" aria-label="Close panel" (click)="closed.emit()">
        <app-icon name="x" />
      </button>
    </header>

    @if (tab() === 'insights') {
      <div class="insights">
        @if (room.insights(); as ins) {
          @if (isEmpty(ins)) {
            <p class="hint">Nothing noted yet. Decisions, tasks and open questions appear here as the meeting goes.</p>
          } @else {
            <app-insights-view [insights]="ins" [compact]="true" [live]="true" (copilotFeedback)="room.copilotFeedback($event.key, $event.kind, $event.action)" />
          }
        } @else if (room.hasAgent()) {
          <p class="hint">{{ room.agentName() }} is listening. Decisions, tasks and open questions will appear here as the conversation develops.</p>
        } @else if (meeting()?.settings?.aiEnabled) {
          <div class="hint">
            <p class="hint-p">The AI participant hasn't joined yet.</p>
            <button type="button" class="btn btn-primary small invite" [disabled]="invitingAi()" (click)="inviteAi.emit()">
              @if (invitingAi()) { <span class="spinner"></span> Inviting… } @else { <app-icon name="sparkles" [size]="16" /> Invite AI }
            </button>
          </div>
        } @else {
          <p class="hint">The AI participant is turned off for this meeting.@if (isHost()) { Turn it on under People → Host controls. }</p>
        }
      </div>
    } @else if (tab() === 'chat') {
      <div class="messages" #list>
        @if (room.messages().length === 0) {
          <p class="hint">
            Messages are visible to everyone in the meeting.
            @if (room.hasAgent()) {
              The AI participant reads them too and includes them in the meeting notes. Start a message with &#64;ai to ask it something.
            }
          </p>
        }
        @for (m of room.messages(); track m.id; let i = $index) {
          @let prev = room.messages()[i - 1];
          <div class="msg" [class.mine]="m.isLocal">
            @if (!prev || prev.from !== m.from || m.at - prev.at > 120000) {
              <div class="msg-head">
                <span class="who">{{ m.isLocal ? 'You' : m.fromName }}</span>
                <span class="time">{{ time(m.at) }}</span>
              </div>
            }
            <div class="text">{{ m.text }}</div>
          </div>
        }
      </div>
      <form class="composer" (ngSubmit)="send()">
        <input class="input" name="draft" [ngModel]="draft()" (ngModelChange)="draft.set($event)" placeholder="Send a message" autocomplete="off"
               aria-label="Message" maxlength="2000" />
        <button type="submit" class="icon-btn send" aria-label="Send" [disabled]="!draft().trim() || sending()">
          <app-icon name="send" [size]="18" />
        </button>
      </form>
    } @else {
      @if (isHost() && meeting(); as m) {
        <div class="host-box">
          <p class="host-title">Host controls</p>
          <label class="switch">
            <input type="checkbox" [checked]="m.settings.locked" [disabled]="saving()"
                   (change)="setting.emit({ locked: $any($event.target).checked })" />
            <app-icon name="lock" [size]="16" /> Lock meeting (no one new can join)
          </label>
          <label class="switch">
            <input type="checkbox" [checked]="m.settings.waitingRoom" [disabled]="saving()"
                   (change)="setting.emit({ waitingRoom: $any($event.target).checked })" />
            <app-icon name="users" [size]="16" /> Waiting room (you admit people)
          </label>
          <label class="switch">
            <input type="checkbox" [checked]="m.settings.aiEnabled" [disabled]="saving()"
                   (change)="setting.emit({ aiEnabled: $any($event.target).checked })" />
            <app-icon name="sparkles" [size]="16" /> AI participant in this meeting
          </label>
          <label class="switch sub">
            <input type="checkbox" [checked]="m.settings.aiProactive" [disabled]="saving() || !m.settings.aiEnabled"
                   (change)="setting.emit({ aiProactive: $any($event.target).checked })" />
            AI can speak up on its own
          </label>
          <label class="switch sub">
            <input type="checkbox" [checked]="m.settings.aiReplyMode === 'any'" [disabled]="saving() || !m.settings.aiEnabled"
                   (change)="setting.emit({ aiReplyMode: $any($event.target).checked ? 'any' : 'named' })" />
            AI also answers questions asked to the room
          </label>
          @if (talkativeness() !== null && m.settings.aiEnabled && m.settings.aiProactive) {
            <label class="slider sub">
              <span>Speaks up: <strong>{{ talkLabel(talkLiveValue() ?? talkativeness()!) }}</strong></span>
              <input type="range" min="0" max="1" step="0.05" [value]="talkativeness()" [disabled]="saving()"
                     (input)="talkLiveValue.set(+$any($event.target).value)"
                     (change)="talk.emit(+$any($event.target).value); talkLiveValue.set(null)" />
            </label>
          }
          <label class="switch sub">
            <input type="checkbox" [checked]="m.settings.aiFacilitator" [disabled]="saving() || !m.settings.aiEnabled"
                   (change)="setting.emit({ aiFacilitator: $any($event.target).checked })" />
            AI facilitates (agenda, time, wrap-up)
          </label>
          @if (m.settings.aiEnabled && !room.hasAgent()) {
            <button type="button" class="btn btn-outline small invite-host" [disabled]="invitingAi()" (click)="inviteAi.emit()">
              <app-icon name="sparkles" [size]="16" /> {{ invitingAi() ? 'Inviting AI…' : 'Invite AI now' }}
            </button>
          }
          @if (recordingAvailable()) {
            <button type="button" class="btn small rec-btn" [class.btn-danger]="recording()" [class.btn-outline]="!recording()"
                    [disabled]="recordingBusy()" (click)="record.emit()">
              <span class="rec-dot"></span> {{ recording() ? 'Stop recording' : 'Start recording' }}
            </button>
          }
        </div>
      }
      <ul class="people">
        @for (p of room.participants(); track p.identity) {
          <li>
            @if (p.handRaised) { <span class="hand" title="Hand raised">✋</span> }
            @if (p.isAgent) {
              <span class="pav ai"><span></span><span></span><span></span></span>
            } @else {
              <span class="pav">{{ initials(p.name) }}</span>
            }
            <span class="pname">
              {{ p.name }}{{ p.isLocal ? ' (You)' : '' }}
              <span class="prole">{{ p.isAgent ? 'AI participant' : p.role === 'host' ? 'Meeting host' : p.role === 'guest' ? 'Guest' : '' }}</span>
            </span>
            @if (!p.isAgent && !p.transcribed) {
              <app-icon name="eye-off" [size]="16" class="muted-text" title="Not transcribed by the AI" />
            }
            @if (!p.isAgent) {
              <app-icon [name]="p.micOn ? 'mic' : 'mic-off'" [size]="16" [class.off]="!p.micOn" [class.talking]="p.isSpeaking" />
            }
            @if (isHost() && !p.isLocal) {
              <div class="p-actions">
                @if (p.micOn && !p.isAgent) {
                  <button type="button" class="icon-btn" title="Mute" [attr.aria-label]="'Mute ' + p.name"
                          (click)="mute.emit(p.identity)">
                    <app-icon name="mic-off" [size]="16" />
                  </button>
                }
                <button type="button" class="icon-btn danger" [title]="p.isAgent ? 'Remove the AI' : 'Remove from meeting'"
                        [attr.aria-label]="'Remove ' + p.name" (click)="remove.emit(p)">
                  <app-icon name="user-x" [size]="16" />
                </button>
              </div>
            }
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .slider { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 6px 26px; font-size: 14px;
      input { width: 100%; accent-color: var(--accent, #3df2b1); } }
    :host { display: flex; flex-direction: column; min-height: 0; background: var(--surface); border-left: 1px solid #222; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 12px; border-bottom: 1px solid var(--border); }
    .tabs { display: flex; }
    .tabs button {
      display: inline-flex; align-items: center; gap: 8px; padding: 16px 10px 14px; margin-bottom: -1px;
      background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-muted);
      font-size: 15px; font-weight: 500; cursor: pointer;
      &.active { color: var(--text); border-bottom-color: var(--brand); }
    }
    .count { padding: 1px 7px; border-radius: 99px; background: #2a2a2a; font-size: 12px; }

    .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 4px; }
    .hint { margin: 0; padding: 12px; background: var(--surface-sunken); color: var(--text-muted); font-size: 13px; line-height: 1.5; }
    .msg { max-width: 100%; }
    .msg-head { display: flex; gap: 8px; align-items: baseline; margin-top: 12px; margin-bottom: 4px; }
    .who { font-weight: 600; font-size: 14px; }
    .time { color: var(--text-muted); font-size: 12px; }
    .text { font-size: 14.5px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; color: #d8d8d8; }
    .msg.mine .who { color: var(--brand); }

    .composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); }
    .composer .input { height: 44px; font-size: 15px; }
    .send { width: 44px; height: 44px; color: var(--brand); &:disabled { color: var(--text-placeholder); cursor: default; } }

    .insights { flex: 1; overflow-y: auto; padding: 16px; }
    .people { list-style: none; margin: 0; padding: 8px 0; overflow-y: auto; }
    .people li { display: flex; align-items: center; gap: 12px; padding: 10px 16px; }
    .pav {
      flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center;
      background: #2c2c2c; font-size: 13px; font-weight: 600;
    }
    .pav.ai {
      display: flex; align-items: center; justify-content: center; gap: 3px; background: var(--brand);
      span { width: 3px; height: 9px; border-radius: 9px; background: var(--brand-ink); }
      span:nth-child(2) { height: 15px; }
    }
    .pname { flex: 1; min-width: 0; font-size: 14.5px; display: flex; flex-direction: column; }
    .prole { color: var(--text-muted); font-size: 12.5px; }
    .off { color: var(--danger); }
    .talking { color: var(--brand); }
    .muted-text { color: var(--text-muted); }
    .hand { font-size: 16px; }
    .p-actions { display: flex; gap: 2px; margin-left: 2px; }
    .p-actions .icon-btn { width: 30px; height: 30px; }
    .icon-btn.danger:hover { color: var(--danger); }
    .host-box { margin: 12px 12px 4px; padding: 12px 14px; background: var(--surface-sunken); border: 1px solid #262626; }
    .host-title { margin: 0 0 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .switch { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 14px; cursor: pointer;
      input { width: 16px; height: 16px; margin: 0; accent-color: var(--brand); } }
    .switch.sub { margin-left: 24px; color: var(--text-muted); font-size: 13.5px; }
    .rec-btn { width: 100%; margin-top: 10px; gap: 8px; }
    .invite-host { width: 100%; margin-top: 10px; gap: 8px; }
    .invite { margin-top: 10px; gap: 8px; }
    .hint-p { margin: 0; }
    .rec-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
    .btn-danger .rec-dot { background: #000; }
  `,
})
export class SidePanel {
  protected readonly room = inject(RoomService);
  private readonly toast = inject(ToastService);

  readonly tab = input.required<PanelTab>();
  readonly tabChange = output<PanelTab>();
  readonly closed = output<void>();

  /** Host controls (the meeting page performs the API calls). */
  readonly isHost = input(false);
  readonly meeting = input<Meeting | null>(null);
  readonly saving = input(false);
  readonly setting = output<Partial<MeetingSettings>>();
  /** How readily the AI speaks up (0–1), adjustable live. null while unknown. */
  readonly talkativeness = input<number | null>(null);
  readonly talk = output<number>();
  protected talkLabel = talkLabel;
  protected readonly talkLiveValue = signal<number | null>(null);
  readonly mute = output<string>();
  readonly remove = output<ParticipantView>();
  readonly recordingAvailable = input(false);
  readonly recording = input(false);
  readonly recordingBusy = input(false);
  readonly record = output<void>();
  readonly invitingAi = input(false);
  readonly inviteAi = output<void>();

  protected readonly draft = signal('');
  protected readonly sending = signal(false);
  protected readonly initials = initials;
  protected readonly isEmpty = isEmptyInsights;
  private readonly list = viewChild<ElementRef<HTMLElement>>('list');

  constructor() {
    // Keep the newest message in view.
    effect(() => {
      this.room.messages();
      const el = this.list()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  protected time(at: number): string {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  protected async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.sending()) return;
    this.sending.set(true);
    try {
      await this.room.sendChat(text);
      this.draft.set('');
    } catch {
      this.toast.error('Message not sent. Check your connection.');
    } finally {
      this.sending.set(false);
    }
  }
}
