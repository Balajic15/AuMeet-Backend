import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  const handleUnauthorized = vi.fn();

  beforeEach(() => {
    handleUnauthorized.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { handleUnauthorized } },
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });

  it('adds the CSRF header to API writes only', () => {
    void firstValueFrom(http.post('/api/meetings', {}));
    void firstValueFrom(http.get('/api/meetings'));
    void firstValueFrom(http.post('https://elsewhere.example/x', {}));

    expect(ctrl.expectOne((r) => r.method === 'POST' && r.url === '/api/meetings').request.headers.get('X-AuMeet-CSRF')).toBe('1');
    expect(ctrl.expectOne((r) => r.method === 'GET').request.headers.has('X-AuMeet-CSRF')).toBe(false);
    expect(ctrl.expectOne('https://elsewhere.example/x').request.headers.has('X-AuMeet-CSRF')).toBe(false);
  });

  it('treats a 401 as an ended session, except on credential checks', async () => {
    const meetings = firstValueFrom(http.get('/api/meetings')).catch(() => null);
    ctrl.expectOne('/api/meetings').flush({ error: 'expired' }, { status: 401, statusText: 'Unauthorized' });
    await meetings;
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);

    const login = firstValueFrom(http.post('/api/auth/login', {})).catch(() => null);
    ctrl.expectOne('/api/auth/login').flush({ error: 'bad password' }, { status: 401, statusText: 'Unauthorized' });
    await login;
    const me = firstValueFrom(http.get('/api/auth/me')).catch(() => null);
    ctrl.expectOne('/api/auth/me').flush({}, { status: 401, statusText: 'Unauthorized' });
    await me;
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
  });
});
