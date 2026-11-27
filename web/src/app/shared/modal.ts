import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, inject, input, output } from '@angular/core';
import { Icon } from './icon';

/** Centered dark card over a dimmed backdrop. Esc / backdrop click closes. */
@Component({
  selector: 'app-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: { '(document:keydown.escape)': 'closed.emit()' },
  template: `
    <div class="backdrop" (click)="closed.emit()"></div>
    <section class="dialog" role="dialog" aria-modal="true" [attr.aria-label]="heading()" tabindex="-1">
      <header>
        <h2>{{ heading() }}</h2>
        <button type="button" class="close" aria-label="Close" (click)="closed.emit()">
          <app-icon name="x" />
        </button>
      </header>
      <ng-content />
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; }
    .backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.72); }
    .dialog {
      position: relative; width: 100%; max-width: 480px; max-height: calc(100dvh - 32px); overflow: auto;
      padding: 28px 32px 32px; background: var(--surface); border: 1px solid #2a2a2a;
      &:focus { outline: none; }
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    h2 { margin: 0; font-size: 20px; font-weight: 600; }
    .close {
      display: inline-flex; padding: 6px; background: none; border: none; color: var(--text-muted); cursor: pointer;
      &:hover { color: var(--text); }
    }
    @media (max-width: 520px) { .dialog { padding: 24px 20px; } }
  `,
})
export class Modal {
  readonly heading = input.required<string>();
  readonly closed = output<void>();

  constructor() {
    const host = inject(ElementRef<HTMLElement>);
    afterNextRender(() => {
      const el = host.nativeElement as HTMLElement;
      (el.querySelector('input, button.btn') as HTMLElement | null ?? el.querySelector('.dialog') as HTMLElement)?.focus();
    });
  }
}
