import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production static-serving of the built web UI (EPICS E4; the E5
 * integration note: "production static-serving and the real pairing-token
 * QR wire into the service with E4"). The service serves the Vite build
 * output (`web/dist`) on the same port as the chat socket, so the
 * frontend's `location.host` wiring pairs against the real endpoint with
 * zero configuration — and the pairing QR (built client-side from
 * `location.origin` + the typed token) carries the real payload.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(file: string): string {
  const dot = file.lastIndexOf('.');
  const type = dot >= 0 ? MIME[file.slice(dot).toLowerCase()] : undefined;
  return type ?? 'application/octet-stream';
}

export interface StaticRoot {
  /** Serve the request when it maps to a file; return false to fall through. */
  serve(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

/**
 * A static root over `dir`. Every guard is structural: the resolved path
 * must stay inside the root, must exist, and must be a regular file.
 * Vite hashes asset names, so `/assets/*` is cache-immutable; html is
 * never cached (deploys must show up on reload).
 */
export function createStaticRoot(dir: string): StaticRoot {
  const root = resolve(dir);
  return {
    serve(req, res, path): boolean {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      // decodeURIComponent can throw on malformed escapes — a malformed
      // path is simply not ours (falls through to the JSON 404).
      let decoded: string;
      try {
        decoded = decodeURIComponent(relative);
      } catch {
        return false;
      }
      const resolved = resolve(root, normalize(decoded));
      if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return false;
      if (!existsSync(resolved)) return false;
      let stat;
      try {
        stat = statSync(resolved);
      } catch {
        return false;
      }
      if (!stat.isFile()) return false;
      const isHtml = resolved.toLowerCase().endsWith('.html');
      const inAssets = resolved.slice(root.length).includes(`${sep}assets${sep}`);
      res.writeHead(200, {
        'content-type': mimeFor(resolved),
        'content-length': stat.size,
        'cache-control': isHtml
          ? 'no-cache'
          : inAssets
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      createReadStream(resolved).pipe(res);
      return true;
    },
  };
}

/** The default production UI root: `<package>/web/dist` (present after
 * `npm run build:web`; absent in a backend-only checkout). */
export function defaultStaticRoot(moduleUrl: string): string {
  // src/static.ts → <root>/src; dist/static.js → <root>/dist — one level
  // below the package root in both cases.
  return join(fileDirname(moduleUrl), '..', 'web', 'dist');
}

function fileDirname(moduleUrl: string): string {
  return dirname(fileURLToPath(moduleUrl));
}
