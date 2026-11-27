import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const CREDENTIAL_CHECKS = ['/api/auth/login', '/api/auth/register', '/api/auth/password/', '/api/auth/me'];

/**
 * API calls: the session cookie travels automatically (same origin). Writes carry the CSRF
 * header the server requires for cookie sessions. A 401 elsewhere means the session ended.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  if (!req.url.startsWith('/api/')) return next(req);

  const withCsrf = SAFE.has(req.method) ? req : req.clone({ setHeaders: { 'X-AuMeet-CSRF': '1' } });

  return next(withCsrf).pipe(
    catchError((err: unknown) => {
      // 401 from login means "wrong password", and /me is how we discover we're signed out.
      const isCredentialCheck = CREDENTIAL_CHECKS.some((p) => req.url.startsWith(p));
      if (err instanceof HttpErrorResponse && err.status === 401 && !isCredentialCheck) {
        auth.handleUnauthorized();
      }
      return throwError(() => err);
    }),
  );
};
