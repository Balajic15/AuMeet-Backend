import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { REACTIONS, type FloatingReaction } from './room.service';

/** Emoji floating up the stage when someone reacts. */
@Component({
  selector: 'app-reaction-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (r of items(); track r.id) {
      <div class="float" [style.left.%]="r.x * 100">
        <span class="emoji">{{ r.emoji }}</span>
        <span class="name">{{ r.name }}</span>
      </div>
    }
  `,
  styles: `
    :host { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 7; }
    .float {
      position: absolute; bottom: 40px; display: flex; flex-direction: column; align-items: center;
      animation: rise 4s ease-out forwards;
    }
    .emoji { font-size: 40px; }
    .name { margin-top: 2px; padding: 1px 6px; background: rgba(0, 0, 0, 0.7); font-size: 12px; }
    @keyframes rise {
      0% { transform: translateY(0) scale(0.6); opacity: 0; }
      10% { transform: translateY(-20px) scale(1); opacity: 1; }
      80% { opacity: 1; }
      100% { transform: translateY(-60vh); opacity: 0; }
    }
    @media (prefers-reduced-motion: reduce) { .float { animation: fade 4s forwards; } @keyframes fade { 80% { opacity: 1; } 100% { opacity: 0; } } }
  `,
})
export class ReactionOverlay {
  readonly items = input.required<FloatingReaction[]>();
}

/** Small emoji picker used by the control bar. */
@Component({
  selector: 'app-reaction-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picker" role="menu" aria-label="Send a reaction">
      @for (e of emojis; track e) {
        <button type="button" role="menuitem" (click)="picked.emit(e)" [attr.aria-label]="'React ' + e">{{ e }}</button>
      }
    </div>
  `,
  styles: `
    .picker {
      display: flex; gap: 2px; padding: 6px; background: var(--surface); border: 1px solid var(--border);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
    }
    button { width: 44px; height: 44px; font-size: 24px; background: none; border: none; cursor: pointer; border-radius: 6px; }
    button:hover { background: #2a2a2a; transform: scale(1.1); }
  `,
})
export class ReactionPicker {
  protected readonly emojis = REACTIONS;
  readonly picked = output<(typeof REACTIONS)[number]>();
}
