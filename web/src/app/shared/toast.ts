import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;

  show(text: string, kind: Toast['kind'] = 'info', ms = 3000): void {
    const id = this.nextId++;
    this.toasts.update((t) => [...t, { id, text, kind }]);
    setTimeout(() => this.toasts.update((t) => t.filter((x) => x.id !== id)), ms);
  }

  error(text: string): void {
    this.show(text, 'error', 5000);
  }
}

/** Mounted once in the root component. */
@Component({
  selector: 'app-toasts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" aria-live="polite">
      @for (t of toasts.toasts(); track t.id) {
        <div class="toast" [class.error]="t.kind === 'error'">{{ t.text }}</div>
      }
    </div>
  `,
  styles: `
    .stack {
      position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%);
      z-index: 200; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none;
    }
    .toast {
      padding: 12px 18px; background: #f2f2f2; color: #000; font-size: 15px; border-radius: var(--radius);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); animation: rise 0.18s ease-out;
    }
    .toast.error { background: var(--danger); color: #000; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
  `,
})
export class Toasts {
  protected readonly toasts = inject(ToastService);
}
