import { env } from '../config/env.js';

export type OAuthProvider = 'google' | 'github';

export interface OAuthProfile {
  providerId: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

interface ProviderConfig {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  scope: string;
}

const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
  },
  github: {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
  },
};

export function isProvider(p: string): p is OAuthProvider {
  return p === 'google' || p === 'github';
}

export function isEnabled(p: OAuthProvider): boolean {
  const c = PROVIDERS[p];
  return Boolean(c.clientId && c.clientSecret);
}

export function enabledProviders(): Record<OAuthProvider, boolean> {
  return { google: isEnabled('google'), github: isEnabled('github') };
}

export function callbackUrl(p: OAuthProvider): string {
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/auth/oauth/${p}/callback`;
}

export function authorizeUrl(p: OAuthProvider, state: string): string {
  const c = PROVIDERS[p];
  const params = new URLSearchParams({
    client_id: c.clientId!,
    redirect_uri: callbackUrl(p),
    response_type: 'code',
    scope: c.scope,
    state,
  });
  if (p === 'google') params.set('prompt', 'select_account');
  return `${c.authorizeUrl}?${params}`;
}

async function postForm(url: string, body: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return (await res.json()) as Record<string, unknown>;
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'AuMeet' },
  });
  if (!res.ok) throw new Error(`Profile request failed (${res.status})`);
  return (await res.json()) as T;
}

/** Exchange an authorization code for a verified profile. Throws if no verified email. */
export async function fetchProfile(p: OAuthProvider, code: string): Promise<OAuthProfile> {
  const c = PROVIDERS[p];

  if (p === 'google') {
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: c.clientId!,
      client_secret: c.clientSecret!,
      redirect_uri: callbackUrl(p),
      grant_type: 'authorization_code',
    });
    const info = await getJson<{
      sub: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    }>('https://openidconnect.googleapis.com/v1/userinfo', tok.access_token as string);
    if (!info.email || !info.email_verified) throw new Error('Google account has no verified email');
    return {
      providerId: info.sub,
      email: info.email.toLowerCase(),
      name: info.name || info.email.split('@')[0]!,
      avatarUrl: info.picture,
    };
  }

  const tok = await postForm('https://github.com/login/oauth/access_token', {
    code,
    client_id: c.clientId!,
    client_secret: c.clientSecret!,
    redirect_uri: callbackUrl(p),
  });
  if (typeof tok.access_token !== 'string') throw new Error('GitHub did not return an access token');
  const [user, emails] = await Promise.all([
    getJson<{ id: number; login: string; name: string | null; avatar_url?: string }>(
      'https://api.github.com/user',
      tok.access_token,
    ),
    getJson<Array<{ email: string; primary: boolean; verified: boolean }>>(
      'https://api.github.com/user/emails',
      tok.access_token,
    ),
  ]);
  const email = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  if (!email) throw new Error('GitHub account has no verified email');
  return {
    providerId: String(user.id),
    email: email.email.toLowerCase(),
    name: user.name || user.login,
    avatarUrl: user.avatar_url,
  };
}
