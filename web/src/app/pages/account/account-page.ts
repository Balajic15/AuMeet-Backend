import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService, apiErrorMessage } from '../../core/auth.service';
import { Icon } from '../../shared/icon';
import { Modal } from '../../shared/modal';
import { ToastService } from '../../shared/toast';
import { UserMenu } from '../../shared/user-menu';

@Component({
  selector: 'app-account-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, Icon, Modal, UserMenu],
  template: `
    <header class="topbar">
      <a routerLink="/"><img src="aumeet-logo.png" alt="AuMeet" class="wordmark" /></a>
      <app-user-menu />
    </header>

    @if (auth.user(); as u) {
      <main class="wrap">
        <a routerLink="/" class="back"><app-icon name="arrow-left" [size]="16" /> All meetings</a>
        <h1>Account</h1>

        <!-- Profile -->
        <section class="card">
          <h2>Profile</h2>
          <form (ngSubmit)="saveName()" novalidate>
            <div class="field">
              <label for="name">Name</label>
              <input id="name" class="input" type="text" maxlength="80" autocomplete="name" [formControl]="name"
                     [class.invalid]="name.touched && name.invalid" />
            </div>
            <div class="field">
              <label for="email">Email</label>
              <input id="email" class="input" type="email" [value]="u.email" disabled />
            </div>
            @if (u.providers.google || u.providers.github) {
              <p class="hint">Linked sign-in: {{ linked(u.providers) }}</p>
            }
            <div class="actions">
              <button class="btn btn-primary" type="submit" [disabled]="busy() === 'name' || name.value.trim() === u.name">
                @if (busy() === 'name') { <span class="spinner"></span> } Save
              </button>
            </div>
          </form>
        </section>

        <!-- Password -->
        <section class="card">
          <h2>{{ u.hasPassword ? 'Change password' : 'Set a password' }}</h2>
          @if (!u.hasPassword) {
            <p class="hint">You sign in with {{ linked(u.providers) }}. Add a password to also sign in with your email.</p>
          }
          @if (pwError()) { <div class="alert">{{ pwError() }}</div> }
          <form (ngSubmit)="changePassword()" novalidate>
            @if (u.hasPassword) {
              <div class="field">
                <label for="cur">Current password</label>
                <input id="cur" class="input" type="password" autocomplete="current-password" [formControl]="currentPassword" />
              </div>
            }
            <div class="field">
              <label for="new">New password</label>
              <input id="new" class="input" type="password" autocomplete="new-password" placeholder="At least 8 characters"
                     [formControl]="newPassword" [class.invalid]="newPassword.touched && newPassword.invalid" />
              @if (newPassword.touched && newPassword.invalid) {
                <span class="field-error">Password must be at least 8 characters</span>
              }
            </div>
            <p class="hint">Saving signs you out on your other devices.</p>
            <div class="actions">
              <button class="btn btn-primary" type="submit" [disabled]="busy() === 'pw'">
                @if (busy() === 'pw') { <span class="spinner"></span> } {{ u.hasPassword ? 'Change password' : 'Set password' }}
              </button>
            </div>
          </form>
        </section>

        <!-- Sessions -->
        <section class="card">
          <h2>Sessions</h2>
          <p class="hint">Lost a device or signed in somewhere public? Sign out of AuMeet on every device, including this one.</p>
          <div class="actions">
            <button class="btn btn-outline" type="button" (click)="auth.logout(true)">Sign out everywhere</button>
          </div>
        </section>

        <!-- Danger zone -->
        <section class="card danger">
          <h2>Delete account</h2>
          <p class="hint">
            Permanently deletes your account and every meeting you host, including their transcripts, notes and recaps.
            In other people's meetings your name is replaced with “Former member”.
          </p>
          <div class="actions">
            <button class="btn btn-danger" type="button" (click)="openDelete()">Delete my account</button>
          </div>
        </section>
      </main>

      @if (deleting()) {
        <app-modal heading="Delete your account?" (closed)="deleting.set(false)">
          @if (delError()) { <div class="alert">{{ delError() }}</div> }
          <p class="dlg-text">This can't be undone. Type <strong>{{ u.email }}</strong> to confirm.</p>
          <form (ngSubmit)="confirmDelete()" novalidate>
            <div class="field">
              <input class="input" type="email" autocomplete="off" [placeholder]="u.email" [formControl]="confirmEmail" />
            </div>
            @if (u.hasPassword) {
              <div class="field">
                <label for="delpw">Password</label>
                <input id="delpw" class="input" type="password" autocomplete="current-password" [formControl]="deletePassword" />
              </div>
            }
            <div class="dlg-actions">
              <button type="button" class="btn btn-outline" (click)="deleting.set(false)">Cancel</button>
              <button type="submit" class="btn btn-danger"
                      [disabled]="busy() === 'del' || confirmEmail.value.trim().toLowerCase() !== u.email">
                @if (busy() === 'del') { <span class="spinner"></span> } Delete forever
              </button>
            </div>
          </form>
        </app-modal>
      }
    }
  `,
  styles: `
    :host { display: block; min-height: 100dvh; }
    .topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 32px; border-bottom: 1px solid #1c1c1c; }
    .wordmark { height: 46px; width: auto; display: block; margin-left: -12px; }
    .wrap { max-width: 640px; margin: 0 auto; padding: 28px 20px 80px; }
    .back { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 14px; }
    h1 { margin: 20px 0 24px; font-size: 30px; font-weight: 600; }
    .card { padding: 28px; margin-bottom: 16px; background: var(--surface); border: 1px solid #222; }
    .card.danger { border-color: rgba(255, 107, 107, 0.35); }
    h2 { margin: 0 0 18px; font-size: 18px; font-weight: 600; }
    .input:disabled { color: var(--text-muted); }
    .hint { margin: -6px 0 18px; color: var(--text-muted); font-size: 14px; line-height: 1.5; }
    .actions { display: flex; justify-content: flex-end; }
    .actions .btn { width: auto; min-width: 150px; height: 44px; font-size: 15px; }
    .dlg-text { margin: 0 0 16px; color: var(--text-muted); line-height: 1.55; strong { color: var(--text); } }
    .dlg-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 12px;
      .btn { width: auto; min-width: 120px; height: 44px; font-size: 15px; } }
    @media (max-width: 520px) { .card { padding: 20px; } .topbar { padding: 10px 16px; } }
  `,
})
export class AccountPage {
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly busy = signal<'name' | 'pw' | 'del' | null>(null);
  protected readonly pwError = signal<string | null>(null);
  protected readonly delError = signal<string | null>(null);
  protected readonly deleting = signal(false);

  protected readonly name = new FormControl(this.auth.user()?.name ?? '', {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(80)],
  });
  protected readonly currentPassword = new FormControl('', { nonNullable: true });
  protected readonly newPassword = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(8), Validators.maxLength(128)],
  });
  protected readonly confirmEmail = new FormControl('', { nonNullable: true });
  protected readonly deletePassword = new FormControl('', { nonNullable: true });

  protected linked(p: { google: boolean; github: boolean }): string {
    return [p.google && 'Google', p.github && 'GitHub'].filter(Boolean).join(' and ') || 'a linked account';
  }

  protected async saveName(): Promise<void> {
    this.name.markAsTouched();
    if (this.name.invalid) return;
    this.busy.set('name');
    try {
      await this.auth.updateProfile(this.name.value.trim());
      this.toast.show('Profile saved');
    } catch (err) {
      this.toast.error(apiErrorMessage(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected async changePassword(): Promise<void> {
    this.newPassword.markAsTouched();
    if (this.newPassword.invalid) return;
    this.busy.set('pw');
    this.pwError.set(null);
    try {
      const hadPassword = this.auth.user()?.hasPassword;
      await this.auth.changePassword(this.currentPassword.value || undefined, this.newPassword.value);
      this.currentPassword.reset();
      this.newPassword.reset();
      this.toast.show(hadPassword ? 'Password changed. Other devices were signed out.' : 'Password set');
    } catch (err) {
      this.pwError.set(apiErrorMessage(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected openDelete(): void {
    this.confirmEmail.reset();
    this.deletePassword.reset();
    this.delError.set(null);
    this.deleting.set(true);
  }

  protected async confirmDelete(): Promise<void> {
    this.busy.set('del');
    this.delError.set(null);
    try {
      await this.auth.deleteAccount(this.confirmEmail.value.trim(), this.deletePassword.value || undefined);
      this.toast.show('Your account was deleted');
    } catch (err) {
      this.delError.set(apiErrorMessage(err));
    } finally {
      this.busy.set(null);
    }
  }
}
