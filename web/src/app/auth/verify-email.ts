import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthShell } from './auth-shell';
import { AuthService, apiErrorMessage } from '../core/auth.service';

/** Landing page for the link in the "Confirm your email" message. */
@Component({
  selector: 'app-verify-email',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShell, RouterLink],
  template: `
    <app-auth-shell heading="Confirm your email">
      @switch (state()) {
        @case ('working') {
          <div class="wait"><span class="spinner"></span> Confirming…</div>
        }
        @case ('done') {
          <div class="success" role="status">Thanks! <strong>{{ email() }}</strong> is confirmed.</div>
          <a class="btn btn-primary" [routerLink]="auth.isAuthenticated() ? '/' : '/login'">
            {{ auth.isAuthenticated() ? 'Go to your meetings' : 'Sign in' }}
          </a>
        }
        @case ('error') {
          <div class="alert" role="alert">{{ error() }}</div>
          <a class="btn btn-outline" [routerLink]="auth.isAuthenticated() ? '/' : '/login'">Continue</a>
        }
      }
    </app-auth-shell>
  `,
  styleUrl: './auth-forms.scss',
  styles: `.wait { display: flex; align-items: center; justify-content: center; gap: 12px; color: var(--text-muted); }`,
})
export class VerifyEmail implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly token = inject(ActivatedRoute).snapshot.queryParamMap.get('token');

  protected readonly state = signal<'working' | 'done' | 'error'>('working');
  protected readonly email = signal('');
  protected readonly error = signal('');

  async ngOnInit(): Promise<void> {
    // Keep the one-time token out of the address bar and history.
    history.replaceState(null, '', '/verify-email');
    if (!this.token) {
      this.error.set('This link is incomplete. Send a new one from your dashboard.');
      this.state.set('error');
      return;
    }
    try {
      const res = await firstValueFrom(this.http.post<{ email: string }>('/api/auth/email/verify', { token: this.token }));
      this.email.set(res.email);
      this.state.set('done');
      if (this.auth.isAuthenticated()) await this.auth.refreshUser();
    } catch (err) {
      this.error.set(apiErrorMessage(err));
      this.state.set('error');
    }
  }
}
