import { deflateSync } from 'node:zlib';

/*
 * Small, dependency-free image helpers for shared-screen frames (RGBA, 8 bit per channel):
 *   - downscale for the vision model (bounded size and cost)
 *   - a tiny grey thumbnail for change detection (cheap to compare every second)
 *   - PNG encoding (lossless, so text and error messages stay readable)
 */

export interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Box-filter downscale so the longest side is at most `maxSide` (no upscaling). */
export function downscale(img: Rgba, maxSide: number): Rgba {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      // Sample at most a 4×4 grid per output pixel: fast and good enough for text at this size.
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      for (let yy = y0; yy < y1; yy += stepY) {
        for (let xx = x0; xx < x1; xx += stepX) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]!; g += img.data[i + 1]!; b += img.data[i + 2]!; a += img.data[i + 3]!; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

/** Grey thumbnail (luma), used only to measure how much the screen changed. */
export function thumbnail(img: Rgba, w = 64, h = 36): Uint8Array {
  const small = downscale(img, Math.max(w, h) * 2);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(small.width - 1, Math.floor((x / w) * small.width));
      const sy = Math.min(small.height - 1, Math.floor((y / h) * small.height));
      const i = (sy * small.width + sx) * 4;
      out[y * w + x] = (small.data[i]! * 299 + small.data[i + 1]! * 587 + small.data[i + 2]! * 114) / 1000;
    }
  }
  return out;
}

/**
 * 0 = identical … 1 = completely different: the share of thumbnail pixels that changed noticeably. Counting changed
 * pixels (not the average difference) means a new dialog or error banner registers even on a busy screen.
 */
export function changeScore(a: Uint8Array, b: Uint8Array, pixelThreshold = 24): number {
  if (a.length !== b.length || !a.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > pixelThreshold) changed++;
  return changed / a.length;
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGBA → PNG (colour type 6, no interlace). */
export function encodePng(img: Rgba): Buffer {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
