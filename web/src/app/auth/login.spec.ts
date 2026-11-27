import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../core/auth.service';
import { Login } from './login';

/**
 * Regression: the forms used (ngSubmit) without a form directive, so pressing the button did a
 * native form submit (page reload) and sign-in never ran.
 */
describe('Login', () => {
  const login = vi.fn(async () => {});

  beforeEach(() => {
    login.mockClear();
    TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { login, providers: () => ({ google: false, github: false }), startOAuth: vi.fn() } },
      ],
    });
  });

  function submit(form: HTMLFormElement): Event {
    const ev = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    return ev;
  }

  it('goes from email to password and signs in, without a native form submit', async () => {
    const fixture = TestBed.createComponent(Login);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const email = el.querySelector('#email') as HTMLInputElement;
    email.value = 'asha@example.com';
    email.dispatchEvent(new Event('input'));
    const first = submit(el.querySelector('form') as HTMLFormElement);
    expect(first.defaultPrevented).toBe(true); // no page reload
    fixture.detectChanges();
    await fixture.whenStable();

    const password = el.querySelector('#password') as HTMLInputElement;
    expect(password).not.toBeNull();
    password.value = 'password123';
    password.dispatchEvent(new Event('input'));
    const second = submit(el.querySelector('form') as HTMLFormElement);
    expect(second.defaultPrevented).toBe(true);
    await fixture.whenStable();

    expect(login).toHaveBeenCalledWith('asha@example.com', 'password123');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows a validation message instead of submitting an invalid email', async () => {
    const fixture = TestBed.createComponent(Login);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    submit(el.querySelector('form') as HTMLFormElement);
    fixture.detectChanges();
    expect(el.textContent).toContain('Enter a valid email address');
    expect(login).not.toHaveBeenCalled();
  });
});
