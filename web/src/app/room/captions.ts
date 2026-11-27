import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { CaptionLine } from './room.service';

/** Live captions over the bottom of the stage. */
@Component({
  selector: 'app-captions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="captions" aria-live="polite" aria-atomic="false">
      @for (c of lines(); track c.id) {
        <p class="line" [class.partial]="!c.final">
          <span class="who">{{ c.name }}</span>
          <span class="text">{{ tail(c.text) }}</span>
        </p>
      }
    </div>
  `,
  styles: `
    :host { position: absolute; left: 0; right: 0; bottom: 12px; z-index: 6; display: flex; justify-content: center; pointer-events: none; padding: 0 16px; }
    .captions { max-width: 820px; width: 100%; display: flex; flex-direction: column; gap: 4px; }
    .line {
      margin: 0; padding: 6px 12px; background: rgba(0, 0, 0, 0.78); font-size: 17px; line-height: 1.4;
      text-shadow: 0 1px 2px #000; animation: in 0.12s ease-out;
    }
    .who { color: var(--brand); font-weight: 600; margin-right: 8px; }
    .partial .text { color: #d6d6d6; }
    @keyframes in { from { opacity: 0; } }
    @media (max-width: 640px) { .line { font-size: 15px; } }
  `,
})
export class Captions {
  readonly lines = input.required<CaptionLine[]>();

  /** Long monologues: show only the latest words so captions stay readable. */
  protected tail(text: string): string {
    return text.length > 180 ? '…' + text.slice(-180) : text;
  }
}
