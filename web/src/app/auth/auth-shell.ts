import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Black page, logo, heading, and the dark card that every auth screen sits in. */
@Component({
  selector: 'app-auth-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="page">
      <img class="mark" src="aumeet-mark.svg" alt="AuMeet" width="56" height="56" />
      <h1>{{ heading() }}</h1>
      <section class="card">
        <ng-content />
      </section>
    </main>
  `,
  styles: `
    .page {
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 22px 16px 48px;
    }
    .mark {
      display: block;
      width: 56px;
      height: 56px;
    }
    h1 {
      margin: 20px 0 32px;
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.01em;
      text-align: center;
    }
    .card {
      width: 100%;
      max-width: 550px;
      padding: 60px 60px 56px;
      background: var(--surface);
      border: 1px solid #222;
    }
    @media (max-width: 520px) {
      .card { padding: 36px 20px; }
      h1 { font-size: 24px; }
    }
  `,
})
export class AuthShell {
  readonly heading = input('Welcome to AuMeet!');
}
