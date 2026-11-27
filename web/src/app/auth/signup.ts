import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthShell } from './auth-shell';
import { SocialButtons } from './social-buttons';
import { AuthService, apiErrorMessage } from '../core/auth.service';
import { safeReturnUrl } from '../core/return-url';

@Component({
  selector: 'app-signup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, SocialButtons, ReactiveFormsModule, RouterLink],
  template: `
    <app-auth-shell heading="Create your AuMeet account">
      @if (error()) {
        <div class="alert" role="alert">{{ error() }}</div>
      }

      <app-social-buttons [returnUrl]="returnUrl" (error)="error.set($event)" />

      <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <div class="field">
          <label for="name">Name</label>
          <input id="name" class="input" type="text" autocomplete="name" placeholder="Your full name"
                 formControlName="name" [class.invalid]="invalid('name')" />
          @if (invalid('name')) {
            <span class="field-error">Enter your name</span>
          }
        </div>

        <div class="field">
          <label for="email">Email</label>
          <input id="email" class="input" type="email" autocomplete="email" placeholder="Your email address"
                 formControlName="email" [class.invalid]="invalid('email')" />
          @if (invalid('email')) {
            <span class="field-error">Enter a valid email address</span>
          }
        </div>

        <div class="field">
          <label for="password">Password</label>
          <div class="password-wrap">
            <input id="password" class="input" [type]="showPassword() ? 'text' : 'password'"
                   autocomplete="new-password" placeholder="At least 8 characters"
                   formControlName="password" [class.invalid]="invalid('password')" />
            <button type="button" class="reveal" (click)="showPassword.set(!showPassword())"
                    [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'">
              {{ showPassword() ? 'Hide' : 'Show' }}
            </button>
          </div>
          @if (invalid('password')) {
            <span class="field-error">Password must be at least 8 characters</span>
          }
        </div>

        <button class="btn btn-primary submit" type="submit" [disabled]="loading()">
          @if (loading()) { <span class="spinner"></span> }
          Create account
        </button>
      </form>

      <p class="footer">
        Already have an account?
        <a routerLink="/login" [queryParams]="{ returnUrl: returnUrl !== '/' ? returnUrl : null }">Sign in</a>
      </p>
    </app-auth-shell>
  `,
  styleUrl: './auth-forms.scss',
})
export class Signup {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
  protected readonly loading = signal(false);
  protected readonly showPassword = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(80)] }),
    email: new FormControl(this.route.snapshot.queryParamMap.get('email') ?? '', {
      nonNullable: true,
      validators: [Validators.required, Validators.email],
    }),
    password: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(8), Validators.maxLength(128)],
    }),
  });

  protected invalid(name: 'name' | 'email' | 'password'): boolean {
    const c = this.form.controls[name];
    return c.touched && c.invalid;
  }

  protected async submit(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    const { name, email, password } = this.form.getRawValue();
    try {
      await this.auth.register(name.trim(), email.trim(), password);
      await this.router.navigateByUrl(this.returnUrl);
    } catch (err) {
      this.error.set(apiErrorMessage(err));
    } finally {
      this.loading.set(false);
    }
  }
}
