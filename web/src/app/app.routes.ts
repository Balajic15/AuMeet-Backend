import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guards';
import { MEETING_CODE_RE } from './core/meetings.service';

export const routes: Routes = [
  {
    path: '',
    canActivate: [authGuard],
    title: 'AuMeet',
    loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.Dashboard),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · AuMeet',
    loadComponent: () => import('./auth/login').then((m) => m.Login),
  },
  {
    path: 'signup',
    canActivate: [guestGuard],
    title: 'Sign up · AuMeet',
    loadComponent: () => import('./auth/signup').then((m) => m.Signup),
  },
  {
    path: 'forgot-password',
    canActivate: [guestGuard],
    title: 'Reset password · AuMeet',
    loadComponent: () => import('./auth/forgot-password').then((m) => m.ForgotPassword),
  },
  {
    path: 'verify-email',
    title: 'Confirm email · AuMeet',
    loadComponent: () => import('./auth/verify-email').then((m) => m.VerifyEmail),
  },
  {
    path: 'reset-password',
    title: 'Choose a new password · AuMeet',
    loadComponent: () => import('./auth/reset-password').then((m) => m.ResetPassword),
  },
  {
    path: 'account',
    canActivate: [authGuard],
    title: 'Account · AuMeet',
    loadComponent: () => import('./pages/account/account-page').then((m) => m.AccountPage),
  },
  {
    path: 'analytics',
    canActivate: [authGuard],
    title: 'Analytics · AuMeet',
    loadComponent: () => import('./pages/analytics/analytics-page').then((m) => m.AnalyticsPage),
  },
  {
    path: ':code/insights',
    canMatch: [(_r: unknown, segments: { path: string }[]) => MEETING_CODE_RE.test(segments[0]?.path ?? '')],
    canActivate: [authGuard],
    title: 'Meeting notes · AuMeet',
    loadComponent: () => import('./pages/insights/insights-page').then((m) => m.InsightsPage),
  },
  {
    // Invite links: aumeet.app/abc-defg-hij (open to guests; the lobby handles sign-in rules)
    path: ':code',
    canMatch: [(_r: unknown, segments: { path: string }[]) => MEETING_CODE_RE.test(segments[0]?.path ?? '')],
    title: 'Meeting · AuMeet',
    loadComponent: () => import('./room/meeting-page').then((m) => m.MeetingPage),
  },
  { path: '**', redirectTo: '' },
];
