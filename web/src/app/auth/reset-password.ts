import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthShell } from './auth-shell';
import { AuthService, apiErrorMessage } from '../core/auth.service';

@Component({
  selector: 'app-reset-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, ReactiveFormsModule, RouterLink],
  template: `
    <app-auth-shell heading="Choose a new password">
      @if (!token) {
        <div class="alert" role="alert">This link is incomplete. Request a new reset link.</div>
        <p class="footer"><a routerLink="/forgot-password">Request a new link</a></p>
      } @else {
        @if (error()) {
          <div class="alert" role="alert">{{ error() }}</div>
        }
        <form (ngSubmit)="submit()" novalidate>
          <div class="field">
            <label for="password">New password</label>
            <div class="password-wrap">
              <input id="password" class="input" [type]="show() ? 'text' : 'password'" autocomplete="new-password"
                     placeholder="At least 8 characters" [formControl]="password"
                     [class.invalid]="password.touched && password.invalid" />
              <button type="button" class="reveal" (click)="show.set(!show())">{{ show() ? 'Hide' : 'Show' }}</button>
            </div>
            @if (password.touched && password.invalid) {
              <span class="field-error">Password must be at least 8 characters</span>
            }
          </div>
          <button class="btn btn-primary submit" type="submit" [disabled]="loading()">
            @if (loading()) { <span class="spinner"></span> } Save and sign in
          </button>
        </form>
        <p class="footer"><a routerLink="/forgot-password">Request a new link</a></p>
      }
    </app-auth-shell>
  `,
  styleUrl: './auth-forms.scss',
})
export class ResetPassword {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly token = inject(ActivatedRoute).snapshot.queryParamMap.get('token');

  protected readonly password = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(8), Validators.maxLength(128)],
  });
  protected readonly show = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Keep the one-time token out of the address bar and browser history.
    if (this.token) history.replaceState(null, '', '/reset-password');
  }

  protected async submit(): Promise<void> {
    this.password.markAsTouched();
    if (this.password.invalid || this.loading() || !this.token) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.resetPassword(this.token, this.password.value);
      await this.router.navigateByUrl('/');
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }
}
