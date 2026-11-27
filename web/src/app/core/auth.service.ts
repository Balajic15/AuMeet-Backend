import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  /** False for accounts created with Google/GitHub until they set one. */
  hasPassword: boolean;
  emailVerified: boolean;
  providers: { google: boolean; github: boolean };
}

export type OAuthProvider = 'google' | 'github';

/** Pulls the server's `{ error }` message out of an HTTP error, with a fallback. */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server. Check your connection.';
    if (err.status === 429) return 'Too many attempts. Please wait a few minutes.';
    const msg = (err.error as { error?: string } | null)?.error;
    if (typeof msg === 'string' && msg) return msg;
  }
  return fallback;
}

/**
 * Session state. The session itself is an httpOnly cookie set by the server, so no token
 * is ever stored in (or readable from) the page – we only keep the current user.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly _user = signal<User | null>(null);
  readonly user = this._user.asReadonly();
  readonly isAuthenticated = computed(() => this._user() !== null);

  readonly providers = signal<Record<OAuthProvider, boolean>>({ google: false, github: false });

  /** Called once at startup: asks the server who we are (cookie is sent automatically). */
  async init(): Promise<void> {
    void this.loadProviders();
    try {
      await this.refreshUser();
    } catch {
      this._user.set(null);
    }
  }

  async refreshUser(): Promise<void> {
    const res = await firstValueFrom(this.http.get<{ user: User }>('/api/auth/me'));
    this._user.set(res.user);
  }

  async login(email: string, password: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<{ user: User }>('/api/auth/login', { email, password }));
    this._user.set(res.user);
  }

  async register(name: string, email: string, password: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<{ user: User }>('/api/auth/register', { name, email, password }));
    this._user.set(res.user);
  }

  async updateProfile(name: string): Promise<void> {
    const res = await firstValueFrom(this.http.patch<{ user: User }>('/api/auth/me', { name }));
    this._user.set(res.user);
  }

  async changePassword(currentPassword: string | undefined, newPassword: string): Promise<void> {
    const res = await firstValueFrom(
      this.http.post<{ user: User }>('/api/auth/password/change', { currentPassword, newPassword }),
    );
    this._user.set(res.user);
  }

  resendVerification(): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/auth/email/resend', {}));
  }

  forgotPassword(email: string): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/auth/password/forgot', { email }));
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const res = await firstValueFrom(this.http.post<{ user: User }>('/api/auth/password/reset', { token, password }));
    this._user.set(res.user);
  }

  async deleteAccount(confirmEmail: string, password?: string): Promise<void> {
    await firstValueFrom(this.http.delete('/api/auth/me', { body: { confirmEmail, password } }));
    this._user.set(null);
    void this.router.navigateByUrl('/login');
  }

  /** Full-page navigation – the browser must visit the provider, not XHR it. */
  startOAuth(provider: OAuthProvider, returnUrl = '/'): void {
    window.location.href = `/api/auth/oauth/${provider}?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  async logout(everywhere = false): Promise<void> {
    try {
      await firstValueFrom(this.http.post(everywhere ? '/api/auth/logout-all' : '/api/auth/logout', {}));
    } catch {
      /* signed out locally either way */
    }
    this._user.set(null);
    void this.router.navigateByUrl('/login');
  }

  /** Used by the interceptor when the server says the session is no longer valid. */
  handleUnauthorized(): void {
    if (!this._user()) return;
    this._user.set(null);
    void this.router.navigate(['/login'], {
      queryParams: { returnUrl: this.router.url, error: 'Your session has ended. Please sign in again.' },
    });
  }

  private async loadProviders(): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ providers: Record<OAuthProvider, boolean> }>('/api/auth/providers'),
      );
      this.providers.set(res.providers);
    } catch {
      /* leave both disabled */
    }
  }
}
