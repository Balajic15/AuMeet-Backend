import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { Modal } from '../shared/modal';
import { ToastService } from '../shared/toast';
import { RoomService } from './room.service';

/** In-meeting settings: camera, microphone, speaker, captions and the transcription opt-out. */
@Component({
  selector: 'app-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal],
  template: `
    <app-modal heading="Settings" (closed)="closed.emit()">
      <div class="field">
        <label for="mic">Microphone</label>
        <select id="mic" class="input" [value]="active('audioinput')" (change)="pick('audioinput', $event)">
          @for (d of mics(); track d.deviceId) { <option [value]="d.deviceId">{{ label(d, 'Microphone') }}</option> }
        </select>
      </div>
      <div class="field">
        <label for="cam">Camera</label>
        <select id="cam" class="input" [value]="active('videoinput')" (change)="pick('videoinput', $event)">
          @for (d of cams(); track d.deviceId) { <option [value]="d.deviceId">{{ label(d, 'Camera') }}</option> }
        </select>
      </div>
      @if (speakers().length) {
        <div class="field">
          <label for="spk">Speaker</label>
          <select id="spk" class="input" [value]="active('audiooutput')" (change)="pick('audiooutput', $event)">
            @for (d of speakers(); track d.deviceId) { <option [value]="d.deviceId">{{ label(d, 'Speaker') }}</option> }
          </select>
        </div>
      }

      <label class="check">
        <input type="checkbox" [checked]="captionsOn()" (change)="captionsChange.emit($any($event.target).checked)" />
        Show live captions
      </label>

      @if (aiPresent()) {
        <label class="check">
          <input type="checkbox" [checked]="!rs.transcribed()" (change)="toggleTranscription($any($event.target).checked)" />
          Don't transcribe me (the AI won't hear or note what I say or type)
        </label>
      }
    </app-modal>
  `,
  styles: `
    select.input { font-size: 15px; height: 44px; }
    .check { margin-top: 16px; }
  `,
})
export class SettingsDialog {
  protected readonly rs = inject(RoomService);
  private readonly toast = inject(ToastService);

  readonly captionsOn = input(false);
  readonly aiPresent = input(false);
  readonly captionsChange = output<boolean>();
  readonly closed = output<void>();

  protected readonly mics = signal<MediaDeviceInfo[]>([]);
  protected readonly cams = signal<MediaDeviceInfo[]>([]);
  protected readonly speakers = signal<MediaDeviceInfo[]>([]);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const [m, c, s] = await Promise.all([
      this.rs.listDevices('audioinput'),
      this.rs.listDevices('videoinput'),
      this.rs.listDevices('audiooutput'),
    ]);
    this.mics.set(m);
    this.cams.set(c);
    this.speakers.set(s); // empty where the browser can't choose an output (e.g. Firefox, Safari)
  }

  protected active(kind: MediaDeviceKind): string {
    return this.rs.activeDevice(kind) ?? 'default';
  }

  protected label(d: MediaDeviceInfo, fallback: string): string {
    return d.label || fallback;
  }

  protected async pick(kind: MediaDeviceKind, e: Event): Promise<void> {
    try {
      await this.rs.switchDevice(kind, (e.target as HTMLSelectElement).value);
    } catch {
      this.toast.error('Could not switch to that device.');
    }
  }

  protected async toggleTranscription(optOut: boolean): Promise<void> {
    try {
      await this.rs.setTranscribed(!optOut);
      this.toast.show(optOut ? "The AI won't transcribe you" : 'The AI can transcribe you again');
    } catch {
      this.toast.error('Could not change that right now.');
    }
  }
}
