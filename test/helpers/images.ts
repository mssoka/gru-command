import { Buffer } from 'node:buffer';

/**
 * Minimal structurally-valid synthetic images for the private-evidence
 * suites: they satisfy BOTH the magic-byte sniffer and the structural
 * decodability validator (PNG IHDR/dimensions/IEND, JPEG SOI/EOI, GIF
 * dimensions, WEBP VP8 chunk) while staying tiny. Never real owner pixels.
 */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([length, body, crcBuffer]);
}

export function minimalPng(extra: Buffer = Buffer.alloc(0)): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    extra,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function minimalJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from('synthetic-jpeg-payload'),
    Buffer.from([0xff, 0xd9]),
  ]);
}

export function minimalGif(): Buffer {
  const header = Buffer.alloc(10);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(1, 6); // width
  header.writeUInt16LE(1, 8); // height
  const rest = Buffer.from([0x00, 0x00, 0x00, 0x3b]); // packed, background, aspect, trailer
  return Buffer.concat([header, rest]);
}

export function minimalWebp(): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), Buffer.from('VP8L', 'ascii'), Buffer.from([0x04, 0x00, 0x00, 0x00, 0x2f])]);
  const riff = Buffer.alloc(4);
  riff.writeUInt32LE(body.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), riff, body]);
}

function ebmlElement(id: readonly number[], data: Buffer): Buffer {
  if (data.length > 126) throw new Error('ebmlElement: one-byte sizes only');
  return Buffer.concat([Buffer.from(id), Buffer.from([0x80 | data.length]), data]);
}

function ebmlUint16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value, 0);
  return bytes;
}

/** The head of a WebM recording and nothing else: the EBML header naming the
 * `webm` doctype, then a segment of unknown size (as a streamed recording
 * has) whose one video track names its frame size. No frames. */
export function minimalWebm(width = 2, height = 2): Buffer {
  const header = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], ebmlElement([0x42, 0x82], Buffer.from('webm', 'ascii')));
  const video = ebmlElement([0xe0], Buffer.concat([ebmlElement([0xb0], ebmlUint16(width)), ebmlElement([0xba], ebmlUint16(height))]));
  const entry = ebmlElement([0xae], Buffer.concat([ebmlElement([0xd7], Buffer.from([1])), video]));
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], entry);
  return Buffer.concat([header, Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), tracks]);
}
