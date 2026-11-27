import { Router, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { UserModel, toPublicUser, type UserDoc } from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { deleteAccount } from '../services/account.js';
import { emailHtml, escapeHtml, sendMail } from '../services/mailer.js';
import { authorizeUrl, enabledProviders, fetchProfile, isEnabled, isProvider } from '../services/oauth.js';
import { RENEW_BELOW_MS, clearSession, issueSession, readCookie } from '../services/session.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { badRequest, conflict, notFound, unauthorized } from '../utils/httpError.js';

const router = Router();

const Email = z.email().transform((e) => e.toLowerCase());
const Password = z.string().min(8, 'Password must be at least 8 characters').max(128);

const RegisterBody = z.object({ email: Email, name: z.string().trim().min(1).max(80), password: Password });
const LoginBody = z.object({ email: Email, password: z.string().min(1) });

/** Sets the session cookie and returns the public user (the token itself never reaches page JS). */
function signIn(res: Response, user: UserDoc, status = 200) {
  issueSession(res, user);
  res.status(status).json({ user: toPublicUser(user) });
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

// ---------- email + password ----------

router.post('/register', async (req, res) => {
  const body = RegisterBody.parse(req.body);
  if (await UserModel.exists({ email: body.email })) throw conflict('An account with this email already exists');

  const passwordHash = await bcrypt.hash(body.password, 12);
  try {
    const user = await UserModel.create({ email: body.email, name: body.name, passwordHash });
    signIn(res, user, 201);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('An account with this email already exists');
    throw err;
  }
});

router.post('/login', async (req, res) => {
  const body = LoginBody.parse(req.body);
  const user = await UserModel.findOne({ email: body.email }).select('+passwordHash');
  // Same message for unknown email and wrong password to avoid account enumeration.
  const ok = user?.passwordHash && (await bcrypt.compare(body.password, user.passwordHash));
  if (!user || !ok) throw unauthorized('Invalid email or password');
  signIn(res, user);
});

router.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/** Revokes every session of this account (all devices), including the current one. */
router.post('/logout-all', requireAuth, async (req, res) => {
  await UserModel.updateOne({ _id: req.auth!.sub }, { $inc: { tokenVersion: 1 } });
  clearSession(res);
  res.json({ ok: true });
});

// ---------- profile ----------

router.get('/me', requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.auth!.sub).select('+passwordHash');
  if (!user) throw notFound('User no longer exists');
  // Sliding expiry: active cookie sessions are renewed before they run out.
  if (req.auth!.via === 'cookie' && req.auth!.exp * 1000 - Date.now() < RENEW_BELOW_MS) issueSession(res, user);
  res.json({ user: toPublicUser(user) });
});

const ProfileBody = z.object({ name: z.string().trim().min(1).max(80) });

router.patch('/me', requireAuth, async (req, res) => {
  const { name } = ProfileBody.parse(req.body);
  const user = await UserModel.findByIdAndUpdate(req.auth!.sub, { $set: { name } }, { new: true }).select('+passwordHash');
  if (!user) throw notFound('User no longer exists');
  res.json({ user: toPublicUser(user) });
});

const ChangePasswordBody = z.object({ currentPassword: z.string().optional(), newPassword: Password });

/** Change (or, for Google/GitHub accounts, set) a password. Signs out other devices. */
router.post('/password/change', requireAuth, async (req, res) => {
  const body = ChangePasswordBody.parse(req.body);
  const user = await UserModel.findById(req.auth!.sub).select('+passwordHash');
  if (!user) throw notFound('User no longer exists');
  if (user.passwordHash) {
    if (!body.currentPassword || !(await bcrypt.compare(body.currentPassword, user.passwordHash))) {
      throw badRequest('Your current password is incorrect');
    }
  }
  user.passwordHash = await bcrypt.hash(body.newPassword, 12);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();
  signIn(res, user); // fresh session for this device only
});

const ForgotBody = z.object({ email: Email });
const RESET_TTL_MS = 30 * 60 * 1000;

/** Always answers the same way, whether or not the email has an account (no enumeration). */
router.post('/password/forgot', async (req, res) => {
  const { email } = ForgotBody.parse(req.body);
  const user = await UserModel.findOne({ email });
  if (user) {
    const token = randomBytes(32).toString('base64url');
    await UserModel.updateOne(
      { _id: user._id },
      { $set: { resetTokenHash: hashToken(token), resetTokenExpires: new Date(Date.now() + RESET_TTL_MS) } },
    );
    const url = `${env.WEB_URL}/reset-password?token=${token}`;
    try {
      await sendMail({
        to: user.email,
        subject: 'Reset your AuMeet password',
        text: `Hi ${user.name},\n\nUse this link to choose a new password (valid for 30 minutes):\n${url}\n\nIf you didn't ask for this, you can ignore this email.`,
        html: emailHtml(
          'Reset your password',
          `<p>Hi ${escapeHtml(user.name)},</p><p>Use the button below to choose a new password. The link is valid for 30 minutes.</p><p style="color:#8a8a8a">If you didn't ask for this, you can ignore this email.</p>`,
          { label: 'Choose a new password', url },
        ),
      });
    } catch (err) {
      logger.error({ err }, 'could not send password reset email');
    }
  }
  res.json({ ok: true });
});

const ResetBody = z.object({ token: z.string().min(20).max(200), password: Password });

router.post('/password/reset', async (req, res) => {
  const { token, password } = ResetBody.parse(req.body);
  const user = await UserModel.findOne({ resetTokenHash: hashToken(token), resetTokenExpires: { $gt: new Date() } });
  if (!user) throw badRequest('This reset link is invalid or has expired. Request a new one.');
  user.passwordHash = await bcrypt.hash(password, 12);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1; // sign out everywhere
  user.set('resetTokenHash', undefined);
  user.set('resetTokenExpires', undefined);
  await user.save();
  signIn(res, user);
});

const DeleteBody = z.object({ confirmEmail: Email, password: z.string().optional() });

/** Permanently delete the account and hosted meeting data (see services/account.ts). */
router.delete('/me', requireAuth, async (req, res) => {
  const body = DeleteBody.parse(req.body);
  const user = await UserModel.findById(req.auth!.sub).select('+passwordHash');
  if (!user) throw notFound('User no longer exists');
  if (body.confirmEmail !== user.email) throw badRequest('Type your account email to confirm');
  if (user.passwordHash && !(body.password && (await bcrypt.compare(body.password, user.passwordHash)))) {
    throw badRequest('Your password is incorrect');
  }
  const result = await deleteAccount(user.id);
  clearSession(res);
  logger.info({ userId: user.id, ...result }, 'account deleted');
  res.json({ ok: true, ...result });
});

// ---------- OAuth (Google / GitHub) ----------

const STATE_COOKIE = 'aumeet_oauth';
const STATE_TTL_S = 600;

router.get('/providers', (_req, res) => {
  res.json({ providers: enabledProviders() });
});

function safeReturnUrl(v: unknown): string {
  // Only same-site paths – blocks open redirects like `//evil.com` or `https://…`.
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : '/';
}

function loginErrorRedirect(res: Response, message: string) {
  res.redirect(`${env.WEB_URL}/login?error=${encodeURIComponent(message)}`);
}

const providerLabel = (p: string) => (p === 'google' ? 'Google' : 'GitHub');

router.get('/oauth/:provider', (req, res) => {
  const provider = req.params.provider as string;
  if (!isProvider(provider)) throw notFound('Unknown sign-in provider');
  if (!isEnabled(provider)) return loginErrorRedirect(res, `${providerLabel(provider)} sign-in is not configured yet`);

  // The nonce lives in an httpOnly cookie and inside the signed state, binding the
  // callback to this browser (prevents login CSRF).
  const nonce = randomBytes(16).toString('hex');
  const state = jwt.sign({ n: nonce, p: provider, r: safeReturnUrl(req.query.returnUrl) }, env.JWT_SECRET, {
    expiresIn: STATE_TTL_S,
  });
  res.cookie(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: STATE_TTL_S * 1000,
    path: '/api/auth/oauth',
  });
  res.redirect(authorizeUrl(provider, state));
});

router.get('/oauth/:provider/callback', async (req, res) => {
  const provider = req.params.provider as string;
  if (!isProvider(provider) || !isEnabled(provider)) throw notFound('Unknown sign-in provider');
  res.clearCookie(STATE_COOKIE, { path: '/api/auth/oauth' });

  if (req.query.error) return loginErrorRedirect(res, 'Sign-in was cancelled');

  let returnUrl = '/';
  try {
    const st = jwt.verify(String(req.query.state ?? ''), env.JWT_SECRET) as { n: string; p: string; r: string };
    if (st.p !== provider || st.n !== readCookie(req, STATE_COOKIE)) throw new Error('state mismatch');
    returnUrl = safeReturnUrl(st.r);
  } catch {
    return loginErrorRedirect(res, 'Sign-in session expired, please try again');
  }

  let profile;
  try {
    profile = await fetchProfile(provider, String(req.query.code ?? ''));
  } catch (err) {
    logger.warn({ err, provider }, 'OAuth sign-in failed');
    return loginErrorRedirect(res, `Could not sign in with ${providerLabel(provider)}`);
  }

  const idField = provider === 'google' ? 'googleId' : 'githubId';
  // 1) known provider account → 2) same verified email → link → 3) new user
  let user = await UserModel.findOne({ [idField]: profile.providerId });
  if (!user) {
    user = await UserModel.findOne({ email: profile.email });
    if (user) {
      user.set(idField, profile.providerId);
      if (!user.avatarUrl && profile.avatarUrl) user.avatarUrl = profile.avatarUrl;
      await user.save();
    } else {
      user = await UserModel.create({
        email: profile.email,
        name: profile.name.slice(0, 80),
        avatarUrl: profile.avatarUrl,
        [idField]: profile.providerId,
      });
    }
  }

  // The session is a cookie now – no token in the URL at all.
  issueSession(res, user);
  res.redirect(`${env.WEB_URL}${returnUrl}`);
});

export default router;
