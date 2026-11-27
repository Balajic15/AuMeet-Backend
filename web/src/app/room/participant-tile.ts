import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Icon } from '../shared/icon';
import { initials } from '../shared/user-menu';
import { VideoTrackView } from './video-track';
import type { ParticipantView } from './room.service';

@Component({
  selector: 'app-participant-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, VideoTrackView],
  host: { '[class.speaking]': 'p().isSpeaking', '[class.agent]': 'p().isAgent' },
  template: `
    @if (p().camera; as cam) {
      <app-video-track [track]="cam" [mirror]="p().isLocal" />
    } @else if (p().isAgent) {
      <div class="center">
        <div class="ai-orb" [class.talking]="p().isSpeaking">
          <span></span><span></span><span></span>
        </div>
      </div>
    } @else {
      <div class="center">
        <div class="avatar" [style.background]="color()">{{ initials() }}</div>
      </div>
    }

    @if (p().handRaised) {
      <div class="hand" title="Hand raised" aria-label="Hand raised">✋</div>
    }

    <div class="label">
      @if (p().sharedDevice) {
        <app-icon name="users" [size]="14" class="private-icon" title="Several people on this device" />
      }
      @if (!p().transcribed && !p().isAgent) {
        <app-icon name="eye-off" [size]="14" class="private-icon" title="Not transcribed by the AI" />
      }
      @if (!p().micOn && !p().isAgent) {
        <app-icon name="mic-off" [size]="14" class="muted-icon" />
      }
      <span class="name">{{ p().name }}{{ p().isLocal ? ' (You)' : '' }}</span>
      @if (p().isAgent) { <span class="tag ai">AI</span> }
      @if (p().role === 'host') { <span class="tag">Host</span> }
    </div>
  `,
  styles: `
    :host {
      position: relative; display: block; overflow: hidden; min-height: 0;
      background: #161616; border: 1px solid #262626;
      transition: box-shadow 0.15s, border-color 0.15s;
    }
    :host(.speaking) { border-color: var(--brand); box-shadow: inset 0 0 0 2px var(--brand); }
    .center { position: absolute; inset: 0; display: grid; place-items: center; }
    .avatar {
      width: clamp(56px, 22%, 112px); aspect-ratio: 1; border-radius: 50%;
      display: grid; place-items: center; color: #0d1117; font-weight: 600;
      font-size: clamp(18px, 3vw, 36px);
    }
    .label {
      position: absolute; left: 10px; bottom: 10px; max-width: calc(100% - 20px);
      display: flex; align-items: center; gap: 6px; padding: 4px 8px;
      background: rgba(0, 0, 0, 0.6); font-size: 13px;
    }
    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted-icon { color: var(--danger); }
    .private-icon { color: var(--text-muted); }
    .hand {
      position: absolute; top: 10px; left: 10px; z-index: 2; padding: 4px 8px; font-size: 20px;
      background: #ffb020; border-radius: 4px; animation: wave 1s ease-in-out 2;
    }
    @keyframes wave { 50% { transform: rotate(-12deg); } }
    .tag { flex: none; padding: 0 5px; border: 1px solid #555; font-size: 10.5px; line-height: 16px; }
    .tag.ai { border-color: var(--brand); color: var(--brand); }

    /* AI participant: the logo's green circle with three bars that move when it talks */
    .ai-orb {
      width: clamp(64px, 24%, 120px); aspect-ratio: 1; border-radius: 50%; background: var(--brand);
      display: flex; align-items: center; justify-content: center; gap: 9%;
      box-shadow: 0 0 0 0 rgba(61, 242, 177, 0.35);
      span { width: 9%; border-radius: 99px; background: var(--brand-ink); height: 28%; }
      span:nth-child(2) { height: 50%; }
    }
    .ai-orb.talking {
      animation: halo 1.4s ease-out infinite;
      span { animation: bar 0.9s ease-in-out infinite; }
      span:nth-child(2) { animation-delay: -0.3s; }
      span:nth-child(3) { animation-delay: -0.6s; }
    }
    @keyframes bar { 0%, 100% { height: 22%; } 50% { height: 56%; } }
    @keyframes halo { to { box-shadow: 0 0 0 18px rgba(61, 242, 177, 0); } }
  `,
})
export class ParticipantTile {
  readonly p = input.required<ParticipantView>();

  protected readonly initials = computed(() => initials(this.p().name));
  /** Stable pastel per identity so people are easy to tell apart. */
  protected readonly color = computed(() => {
    let h = 0;
    for (const c of this.p().identity) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 60% 72%)`;
  });
}
