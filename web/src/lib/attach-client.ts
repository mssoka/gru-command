/**
 * Attach API client (SPEC ruling 19): the composer's ONE resolution
 * surface. On-disk picks browse the service's workspace root and send
 * PATHS (no bytes ever move for browse); clipboard/phone bytes
 * materialize into the instance uploads dir and return THAT path.
 *
 * Same token as the chat socket; rebuilt per pair (tokens rotate).
 */

import type { AttachmentChip } from './protocol.js';

export interface BrowseEntry {
  readonly name: string;
  readonly kind: 'dir' | 'file';
  readonly size: number | null;
  readonly image: boolean;
}

export interface BrowseResult {
  /** Absolute workspace root (chips join it for on-disk picks). */
  readonly root: string;
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly BrowseEntry[];
}

export interface UploadedFile {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
}

export interface AttachClientOptions {
  readonly token: string;
  readonly host: string;
  readonly secure?: boolean;
}

/** Uploads cap mirrored from src/attachments/resolver.ts. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Attach surface timeout (review r1): a hung service must not leave the
 * picker on "browsing…" and busy chips forever. */
const ATTACH_TIMEOUT_MS = 10_000;

/** THE client-side image-kind test (review r1: three drifted copies —
 * this is the one the composer + upload path share). */
export const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function imageKindFor(name: string): 'image' | 'file' {
  return IMAGE_NAME_RE.test(name) ? 'image' : 'file';
}

export class AttachError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AttachError';
  }
}

export class AttachClient {
  constructor(private readonly options: AttachClientOptions) {}

  /** List one directory under the workspace root (metadata only). */
  async browse(path: string): Promise<BrowseResult> {
    const result = await this.request(`/api/attach/browse?path=${encodeURIComponent(path)}`);
    return result as BrowseResult;
  }

  /** Materialize clipboard/phone bytes into the uploads dir → that path. */
  async upload(filename: string, bytes: Uint8Array): Promise<UploadedFile> {
    if (bytes.byteLength === 0) throw new AttachError(400, 'empty file — nothing to upload');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new AttachError(
        413,
        `file exceeds the ${MAX_UPLOAD_BYTES} byte cap (${bytes.byteLength} bytes)`,
      );
    }
    // Bounded chunks: build the binary string piecewise (spread limits
    // and string length both stay safe even at the 8 MiB cap).
    const parts: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
      let chunk = '';
      const end = Math.min(offset + 8_192, bytes.byteLength);
      for (let i = offset; i < end; i += 1) chunk += String.fromCharCode(bytes[i]!);
      parts.push(chunk);
    }
    const base64 = btoa(parts.join(''));
    const result = await this.request('/api/attach/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename, content_base64: base64 }),
    });
    return result as UploadedFile;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const secure = this.options.secure ?? true;
    const base = `${secure ? 'https' : 'http'}://${this.options.host}`;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        signal: AbortSignal.timeout(ATTACH_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      throw new AttachError(0, `attach surface unreachable: ${String(error)}`);
    }
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const body = (await res.json()) as { detail?: unknown; error?: unknown };
        if (body.detail !== undefined) detail = String(body.detail);
        else if (body.error !== undefined) detail = String(body.error);
      } catch {
        /* non-JSON error body */
      }
      throw new AttachError(res.status, `attach failed: ${detail}`);
    }
    return res.json();
  }
}

/** File → bytes (browser FileReader; ArrayBuffer). */
export function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    });
    reader.addEventListener('error', () => reject(new Error(`could not read ${file.name}`)));
    reader.readAsArrayBuffer(file);
  });
}

/** Build a chip from an uploaded file (kind from the shared test). */
export function uploadedChip(uploaded: UploadedFile): AttachmentChip {
  return { path: uploaded.path, name: uploaded.name, kind: imageKindFor(uploaded.name) };
}
