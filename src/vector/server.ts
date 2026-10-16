import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { LogLevel } from '../logger.js';
import type { RaidCandidate, RaidExclusion } from './candidates.js';
import type { RaidRecord } from './ledger.js';
import { VectorRefusal, type RaidPickInput, type VectorService } from './service.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Vector's raid surface (#351): Gru reads the code-built candidate list and
 * records his picks; anyone paired can read the raids. Thin: the service
 * owns validation, and every refusal names its reason.
 *
 *   GET  /api/vector/candidates   the ranked list, its digest and exclusions
 *   POST /api/vector/raids        { digest?, picks: [{ repo, package_dir, reason }], requested_by? }
 *   GET  /api/vector/raids        every raid record
 */

export interface VectorServerOptions {
  readonly token: string;
  readonly service: VectorService;
  readonly log?: Log;
}

export interface VectorServer {
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const candidateView = (candidate: RaidCandidate) => ({
  repo: candidate.target.repo,
  package_dir: candidate.target.packageDir,
  head_sha: candidate.headSha,
  source_identity: candidate.sourceIdentity,
  adapter_id: candidate.adapterId,
  score: candidate.score,
  signals: {
    commits_since_last_raid: candidate.signals.commitsSinceLastRaid,
    escaped_regressions: candidate.signals.escapedRegressions,
    perkins_findings: candidate.signals.perkinsFindings,
    days_since_last_raid: candidate.signals.daysSinceLastRaid,
  },
});

const exclusionView = (exclusion: RaidExclusion) => ({ repo: exclusion.repo, package_dir: exclusion.packageDir, reason: exclusion.reason });

const raidView = (raid: RaidRecord) => ({
  id: raid.id,
  repo: raid.target.repo,
  package_dir: raid.target.packageDir,
  source_identity: raid.sourceIdentity,
  head_sha: raid.headSha,
  reason: raid.reason,
  requested_by: raid.requestedBy,
  state: raid.state,
  notification_id: raid.notificationId,
  launched_by: raid.launchedBy,
  launched_at: raid.launchedAt,
  picked_at: raid.pickedAt,
  closed_detail: raid.closedDetail,
});

const REFUSAL_STATUS: Readonly<Record<VectorRefusal['code'], number>> = {
  vector_disabled: 409,
  invalid_pick: 422,
  not_a_candidate: 422,
};

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    let seen = 0;
    const chunks: Buffer[] = [];
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      seen += chunk.length;
      if (seen > 64 * 1024) {
        rejected = true;
        rejectBody(new Error('request body exceeds 64 KiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const parsed = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejectBody(new Error('request body must be a JSON object'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        rejectBody(new Error(`request body is not valid JSON: ${String(error)}`));
      }
    });
    req.on('error', (error) => { if (!rejected) rejectBody(error); });
  });
}

function parsePicks(body: Record<string, unknown>): { readonly picks: readonly RaidPickInput[]; readonly digest: string | null; readonly requestedBy: 'gru' | 'owner-chat' } {
  for (const key of Object.keys(body)) {
    if (!['picks', 'digest', 'requested_by'].includes(key)) throw new VectorRefusal('invalid_pick', `unknown field "${key}" (valid: picks, digest, requested_by)`);
  }
  const rawPicks = body['picks'];
  if (!Array.isArray(rawPicks)) throw new VectorRefusal('invalid_pick', 'picks must be a list (empty answers an offered list with no raid)');
  if (rawPicks.length > 20) throw new VectorRefusal('invalid_pick', 'at most 20 picks per request');
  const picks = rawPicks.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new VectorRefusal('invalid_pick', `picks[${String(index)}] must be an object`);
    const pick = entry as Record<string, unknown>;
    for (const key of Object.keys(pick)) {
      if (!['repo', 'package_dir', 'reason'].includes(key)) throw new VectorRefusal('invalid_pick', `picks[${String(index)}] has unknown field "${key}" (valid: repo, package_dir, reason)`);
    }
    return { repo: pick['repo'] as string, packageDir: pick['package_dir'] as string, reason: pick['reason'] as string };
  });
  const digest = body['digest'];
  if (digest !== undefined && (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest))) throw new VectorRefusal('invalid_pick', 'digest must be the offered list\'s 64-hex digest');
  const requestedBy = body['requested_by'] ?? 'gru';
  // The pairing bearer is shared, so this is the caller's declaration (Gru
  // relaying an owner's chat request); it is recorded as declared.
  if (requestedBy !== 'gru' && requestedBy !== 'owner-chat') throw new VectorRefusal('invalid_pick', 'requested_by must be "gru" or "owner-chat"');
  return { picks, digest: (digest as string | undefined) ?? null, requestedBy };
}

export function createVectorServer(options: VectorServerOptions): VectorServer {
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
    if (path === '/api/vector/candidates' && req.method === 'GET') {
      if (!authed(req, res)) return true;
      const list = options.service.candidates();
      json(res, 200, { digest: list.digest, candidates: list.candidates.map(candidateView), exclusions: list.exclusions.map(exclusionView) });
      return true;
    }
    if (path === '/api/vector/raids' && req.method === 'GET') {
      if (!authed(req, res)) return true;
      json(res, 200, { enabled: options.service.enabled, raids: options.service.raids().map(raidView) });
      return true;
    }
    if (path === '/api/vector/raids' && req.method === 'POST') {
      if (!authed(req, res)) return true;
      let body: Record<string, unknown>;
      try { body = await readBody(req); } catch (error) {
        json(res, 400, { error: 'bad_request', detail: error instanceof Error ? error.message : String(error) });
        return true;
      }
      const result = options.service.pick(parsePicks(body));
      json(res, 201, { raids: result.raids.map(raidView) });
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (!path.startsWith('/api/vector/')) return false;
      handle(req, res, path)
        .then((handled) => {
          if (!handled && !res.headersSent) json(res, 404, { error: 'not_found', path });
        })
        .catch((error: unknown) => {
          if (res.headersSent) return;
          if (error instanceof VectorRefusal) {
            json(res, REFUSAL_STATUS[error.code], { error: error.code, detail: error.message });
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          log('error', 'vector api request failed', { path, detail });
          json(res, 500, { error: 'internal', detail });
        });
      return true;
    },
  };
}
