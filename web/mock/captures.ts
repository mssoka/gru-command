/**
 * ──────────────────────────── DEV TOOLING ONLY ────────────────────────────
 * Sample PR captures for the mock board's `captures` mode: drawn pages (a
 * header, a few fields, a button) encoded as real PNGs, so the FOR YOU strip
 * and the capture viewer can be exercised without a real heist. Generic
 * sample content only. Never part of the production service or bundle.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { crc32, deflateSync } from 'node:zlib';

type Rgb = readonly [number, number, number];

const PAPER: Rgb = [255, 255, 255];
const HEADER: Rgb = [34, 48, 74];
const LINE: Rgb = [213, 218, 227];
const FIELD: Rgb = [176, 184, 198];
const BUTTON: Rgb = [224, 162, 43];

export interface MockCapture {
  readonly id: string;
  readonly kind: 'image';
  readonly mediaType: 'image/png';
  readonly role: 'before' | 'after';
  readonly caption: string;
  readonly bytes: number;
}

/** A truecolor PNG from a canvas of filled rectangles. */
class Canvas {
  private readonly raw: Buffer;

  constructor(private readonly width: number, private readonly height: number) {
    this.raw = Buffer.alloc((width * 3 + 1) * height);
    this.fill(0, 0, width, height, PAPER);
  }

  fill(x: number, y: number, width: number, height: number, color: Rgb): void {
    const left = Math.max(0, Math.round(x));
    const right = Math.min(this.width, Math.round(x + width));
    const top = Math.max(0, Math.round(y));
    const bottom = Math.min(this.height, Math.round(y + height));
    for (let row = top; row < bottom; row += 1) {
      const start = row * (this.width * 3 + 1) + 1;
      for (let column = left; column < right; column += 1) this.raw.set(color, start + column * 3);
    }
  }

  /** An outlined box: a field, or a checkbox. */
  box(x: number, y: number, width: number, height: number): void {
    this.fill(x, y, width, height, FIELD);
    this.fill(x + 2, y + 2, width - 4, height - 4, PAPER);
  }

  png(): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // truecolor
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(this.raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, sum]);
}

/** A sign-up page: four required fields before, one field and an opt-in
 * checkbox after. */
function page(width: number, height: number, role: 'before' | 'after'): Buffer {
  const canvas = new Canvas(width, height);
  const column = Math.min(width * 0.84, 520);
  const left = (width - column) / 2;
  canvas.fill(0, 0, width, height * 0.13, HEADER);
  let y = height * 0.13 + 36;
  canvas.fill(left, y, column * 0.55, 16, LINE);
  y += 44;
  for (let field = 0; field < (role === 'before' ? 4 : 1); field += 1) {
    canvas.fill(left, y, column * 0.3, 10, LINE);
    canvas.box(left, y + 18, column, 44);
    y += 84;
  }
  if (role === 'after') {
    canvas.box(left, y, 22, 22);
    canvas.fill(left + 34, y + 6, column * 0.6, 10, LINE);
    y += 50;
  }
  canvas.fill(left, y, column, 48, BUTTON);
  return canvas.png();
}

const SHOTS = [
  ['before', 390, 844, 'Sign-up form at 390x844, before: four required fields'],
  ['before', 1280, 800, 'Sign-up form at desktop 1280x800, before'],
  ['after', 390, 844, 'Sign-up form at 390x844, after: one field and an optional opt-in'],
  ['after', 1280, 800, 'Sign-up form at desktop 1280x800, after'],
] as const;

let drawn: ReadonlyMap<string, { readonly capture: MockCapture; readonly png: Buffer }> | null = null;

function captures(): ReadonlyMap<string, { readonly capture: MockCapture; readonly png: Buffer }> {
  drawn ??= new Map(SHOTS.map(([role, width, height, caption], at) => {
    const id = `m-00000000-0000-4000-8000-00000000000${at + 1}`;
    const png = page(width, height, role);
    return [id, { capture: { id, kind: 'image', mediaType: 'image/png', role, caption, bytes: png.length }, png }];
  }));
  return drawn;
}

/** The sample captures, before shots first (the order the server sends). */
export function mockCaptures(): readonly MockCapture[] {
  return [...captures().values()].map((entry) => entry.capture);
}

/** One sample capture's PNG bytes; null for an id the mock never issued. */
export function mockCaptureBytes(id: string): Buffer | null {
  return captures().get(id)?.png ?? null;
}
