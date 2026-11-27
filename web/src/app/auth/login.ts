import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
  Injector,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthShell } from './auth-shell';
import { SocialButtons } from './social-buttons';
import { AuthService, apiErrorMessage } from '../core/auth.service';
import { safeReturnUrl } from '../core/return-url';

/**
 * Email-first sign in: step 1 asks for the email (as in the design),
 * step 2 asks for the password.
 */
@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, SocialButtons, ReactiveFormsModule, RouterLink],
  template: `
    <app-auth-shell>
      @if (error()) {
        <div class="alert" role="alert">{{ error() }}</div>
      }

      @if (step() === 'email') {
        <app-social-buttons [returnUrl]="returnUrl" (error)="error.set($event)" />

        <form (ngSubmit)="continueWithEmail()" novalidate>
          <div class="field">
            <label for="email">Email</label>
            <input
              #emailInput
              id="email"
              class="input"
              type="email"
              autocomplete="email"
              placeholder="Your email address"
              [formControl]="email"
              [class.invalid]="showEmailError()"
            />
            @if (showEmailError()) {
              <span class="field-error">Enter a valid email address</span>
            }
          </div>
          <button class="btn btn-primary submit" type="submit">Sign in with email</button>
        </form>
      } @else {
        <form (ngSubmit)="signIn()" novalidate>
          <div class="who">
            <span class="who-email">{{ email.value }}</span>
            <button type="button" class="link-btn" (click)="backToEmail()">Change</button>
          </div>

          <div class="field">
            <label for="password">Password</label>
            <div class="password-wrap">
              <input
                #passwordInput
                id="password"
                class="input"
                [type]="showPassword() ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="Your password"
                [formControl]="password"
                [class.invalid]="password.touched && password.invalid"
              />
              <button type="button" class="reveal" (click)="showPassword.set(!showPassword())"
                      [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'">
                {{ showPassword() ? 'Hide' : 'Show' }}
              </button>
            </div>
            @if (password.touched && password.invalid) {
              <span class="field-error">Enter your password</span>
            }
            <a class="forgot" routerLink="/forgot-password" [queryParams]="{ email: email.value }">Forgot password?</a>
          </div>

          <button class="btn btn-primary submit" type="submit" [disabled]="loading()">
            @if (loading()) { <span class="spinner"></span> }
            Sign in
          </button>
        </form>
      }

      <p class="footer">
        Don't have an account?
        <a routerLink="/signup" [queryParams]="signupParams()">Sign up</a>
      </p>
    </app-auth-shell>
  `,
  styleUrl: './auth-forms.scss',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute);

  protected readonly returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));

  protected readonly step = signal<'email' | 'password'>('email');
  protected readonly loading = signal(false);
  protected readonly showPassword = signal(false);
  protected readonly error = signal<string | null>(this.route.snapshot.queryParamMap.get('error'));

  protected readonly email = new FormControl(this.route.snapshot.queryParamMap.get('email') ?? '', {
    nonNullable: true,
    validators: [Validators.required, Validators.email],
  });
  protected readonly password = new FormControl('', { nonNullable: true, validators: [Validators.required] });

  private readonly emailInput = viewChild<ElementRef<HTMLInputElement>>('emailInput');
  private readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('passwordInput');

  constructor() {
    afterNextRender(() => this.emailInput()?.nativeElement.focus());
  }

  protected showEmailError(): boolean {
    return this.email.touched && this.email.invalid;
  }

  protected signupParams() {
    return { returnUrl: this.returnUrl !== '/' ? this.returnUrl : null, email: this.email.valid ? this.email.value : null };
  }

  protected continueWithEmail(): void {
    this.email.markAsTouched();
    if (this.email.invalid) return;
    this.error.set(null);
    this.step.set('password');
    this.focusLater(() => this.passwordInput());
  }

  protected backToEmail(): void {
    this.step.set('email');
    this.password.reset();
    this.error.set(null);
    this.focusLater(() => this.emailInput());
  }

  protected async signIn(): Promise<void> {
    this.password.markAsTouched();
    if (this.password.invalid || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      await this.auth.login(this.email.value.trim(), this.password.value);
      await this.router.navigateByUrl(this.returnUrl);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
      this.password.reset();
      this.focusLater(() => this.passwordInput());
    } finally {
      this.loading.set(false);
    }
  }

  private focusLater(el: () => ElementRef<HTMLInputElement> | undefined): void {
    afterNextRender(() => el()?.nativeElement.focus(), { injector: this.injector });
  }
}
