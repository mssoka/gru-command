import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { LogLevel } from '../logger.js';
import { OnboardingRefusal, type OnboardingService, type RepoScan } from './service.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Onboarding's one route (#427). Gru calls it only when the owner asks to
 * onboard a repository: it clears a decline, then scans that repository.
 *
 *   POST /api/onboarding/propose   { repo }   → the scan's outcome
 */

export interface OnboardingServerOptions {
  readonly token: string;
  readonly service: Pick<OnboardingService, 'propose'>;
  readonly log?: Log;
}

export interface OnboardingServer {
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const scanView = (scan: RepoScan) => ({
  repo: scan.repo,
  origin: scan.origin,
  action: scan.action,
  detail: scan.detail,
  notification_id: scan.notificationId,
  job_id: scan.jobId,
});

const REFUSAL_STATUS: Readonly<Record<OnboardingRefusal['code'], number>> = {
  onboarding_off: 409,
  not_managed: 422,
};

class BadRequest extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    let seen = 0;
    const chunks: Buffer[] = [];
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      seen += chunk.length;
      if (seen > 16 * 1024) {
        rejected = true;
        rejectBody(new BadRequest(413, 'payload_too_large', 'request body exceeds 16 KiB'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const parsed = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejectBody(new BadRequest(400, 'bad_request', 'request body must be a JSON object'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        rejectBody(new BadRequest(400, 'bad_request', `request body is not valid JSON: ${String(error)}`));
      }
    });
    req.on('error', (error) => { if (!rejected) rejectBody(error); });
  });
}

function parseRepo(body: Record<string, unknown>): string {
  for (const key of Object.keys(body)) {
    if (key !== 'repo') throw new BadRequest(422, 'invalid_request', `unknown field "${key}" (valid: repo)`);
  }
  const repo = body['repo'];
  if (typeof repo !== 'string' || repo.trim() === '') throw new BadRequest(422, 'invalid_request', 'repo must be a managed repository name');
  return repo;
}

export function createOnboardingServer(options: OnboardingServerOptions): OnboardingServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.token);
  const configured = tokenConfigured(options.token);

  function authed(req: IncomingMessage, res: ServerResponse): boolean {
    if (!configured) {
      json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
      return false;
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header.trim()) : null;
    if (match === null || !tokenMatches(match[1]!, tokenHash)) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (path === '/api/onboarding/propose' && req.method === 'POST') {
      if (!authed(req, res)) return true;
      const repo = parseRepo(await readBody(req));
      json(res, 200, scanView(await options.service.propose(repo)));
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (!path.startsWith('/api/onboarding/')) return false;
      handle(req, res, path)
        .then((handled) => {
          if (!handled && !res.headersSent) json(res, 404, { error: 'not_found', path });
        })
        .catch((error: unknown) => {
          if (res.headersSent) return;
          if (error instanceof OnboardingRefusal) {
            json(res, REFUSAL_STATUS[error.code], { error: error.code, detail: error.message });
            return;
          }
          if (error instanceof BadRequest) {
            json(res, error.status, { error: error.code, detail: error.message });
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          log('error', 'onboarding api request failed', { path, detail });
          json(res, 500, { error: 'internal', detail });
        });
      return true;
    },
  };
}
