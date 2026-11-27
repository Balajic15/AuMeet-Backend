import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AuthShell } from './auth-shell';
import { AuthService, apiErrorMessage } from '../core/auth.service';

@Component({
  selector: 'app-forgot-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, ReactiveFormsModule, RouterLink],
  template: `
    <app-auth-shell heading="Reset your password">
      @if (sent()) {
        <div class="success" role="status">
          If an account exists for <strong>{{ email.value }}</strong>, we've sent a link to reset the password.
          It's valid for 30 minutes.
        </div>
      } @else {
        <p class="lede">Enter your account email and we'll send you a link to choose a new password.</p>
        @if (error()) { <div class="alert" role="alert">{{ error() }}</div> }
        <form (ngSubmit)="submit()" novalidate>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" class="input" type="email" autocomplete="email" placeholder="Your email address"
                   [formControl]="email" [class.invalid]="email.touched && email.invalid" />
            @if (email.touched && email.invalid) { <span class="field-error">Enter a valid email address</span> }
          </div>
          <button class="btn btn-primary submit" type="submit" [disabled]="loading()">
            @if (loading()) { <span class="spinner"></span> } Send reset link
          </button>
        </form>
      }
      <p class="footer"><a routerLink="/login">Back to sign in</a></p>
    </app-auth-shell>
  `,
  styleUrl: './auth-forms.scss',
})
export class ForgotPassword {
  private readonly auth = inject(AuthService);
  protected readonly email = new FormControl(inject(ActivatedRoute).snapshot.queryParamMap.get('email') ?? '', {
    nonNullable: true,
    validators: [Validators.required, Validators.email],
  });
  protected readonly loading = signal(false);
  protected readonly sent = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async submit(): Promise<void> {
    this.email.markAsTouched();
    if (this.email.invalid || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.forgotPassword(this.email.value.trim());
      this.sent.set(true);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }
}
