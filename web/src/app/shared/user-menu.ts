import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { Icon } from './icon';

export function initials(name: string | undefined | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}

/** Avatar button in the top bar with name, email and sign-out. */
@Component({
  selector: 'app-user-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  host: { '(document:click)': 'onDocClick($event)', '(document:keydown.escape)': 'open.set(false)' },
  template: `
    @if (auth.user(); as u) {
      <button type="button" class="avatar" (click)="open.set(!open())" [attr.aria-expanded]="open()"
              aria-haspopup="menu" [attr.aria-label]="'Account: ' + u.name">
        @if (u.avatarUrl) {
          <img [src]="u.avatarUrl" alt="" referrerpolicy="no-referrer" />
        } @else {
          {{ initials() }}
        }
      </button>
      @if (open()) {
        <div class="menu" role="menu">
          <div class="who">
            <div class="name">{{ u.name }}</div>
            <div class="email">{{ u.email }}</div>
          </div>
          <a role="menuitem" class="item" routerLink="/account" (click)="open.set(false)">
            <app-icon name="settings" [size]="18" /> Account settings
          </a>
          <button type="button" role="menuitem" class="item" (click)="auth.logout()">
            <app-icon name="logout" [size]="18" /> Sign out
          </button>
        </div>
      }
    }
  `,
  styles: `
    :host { position: relative; display: inline-flex; }
    .avatar {
      width: 38px; height: 38px; border-radius: 50%; border: none; padding: 0; overflow: hidden; cursor: pointer;
      background: var(--brand); color: var(--brand-ink); font-weight: 600; font-size: 14px;
      img { width: 100%; height: 100%; object-fit: cover; display: block; }
    }
    .menu {
      position: absolute; right: 0; top: calc(100% + 8px); z-index: 50; min-width: 240px;
      background: var(--surface); border: 1px solid var(--border); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
    }
    .who { padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .name { font-weight: 600; }
    .email { color: var(--text-muted); font-size: 14px; margin-top: 2px; word-break: break-all; }
    .item {
      display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 16px;
      background: none; border: none; text-align: left; cursor: pointer; font-size: 15px; color: var(--text);
      &:hover { text-decoration: none; }
      &:hover { background: rgba(255, 255, 255, 0.05); }
    }
  `,
})
export class UserMenu {
  protected readonly auth = inject(AuthService);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly open = signal(false);
  protected readonly initials = computed(() => initials(this.auth.user()?.name));

  protected onDocClick(e: MouseEvent): void {
    if (this.open() && !(this.host.nativeElement as HTMLElement).contains(e.target as Node)) this.open.set(false);
  }
}
