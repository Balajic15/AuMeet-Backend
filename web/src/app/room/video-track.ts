import { ChangeDetectionStrategy, Component, ElementRef, effect, input, viewChild } from '@angular/core';
import type { VideoTrack } from 'livekit-client';

/** Renders a LiveKit (or preview) video track into a <video> element. */
@Component({
  selector: 'app-video-track',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<video #v autoplay playsinline muted [class.mirror]="mirror()" [class.contain]="fit() === 'contain'"></video>`,
  styles: `
    :host { display: block; width: 100%; height: 100%; }
    video { display: block; width: 100%; height: 100%; object-fit: cover; background: #000; }
    video.contain { object-fit: contain; }
    video.mirror { transform: scaleX(-1); }
  `,
})
export class VideoTrackView {
  readonly track = input.required<VideoTrack>();
  readonly mirror = input(false);
  readonly fit = input<'cover' | 'contain'>('cover');

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('v');

  constructor() {
    effect((onCleanup) => {
      const track = this.track();
      const el = this.video().nativeElement;
      track.attach(el);
      onCleanup(() => track.detach(el));
    });
  }
}
