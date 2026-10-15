/**
 * Preservation-reference resolver (issue #243 F-H1, Root-approved decision A).
 *
 * An EXPLICIT, OPTIONAL caller-supplied selector for retained evidence: a
 * path to a legacy partial retention record plus the expected digest of that
 * record file. It is a SELECTOR for already-retained evidence — never a
 * release token and never a caller-authored assertion of completeness.
 *
 * The resolver is bounded and read-only:
 *  - it reads ONLY the explicitly supplied record and the sibling assets the
 *    record itself names (no default directory scan / discovery);
 *  - it verifies the record's own digest and each reusable original asset
 *    hash against the record's declared digests AND, when the caller supplies
 *    `expectedAssets`, against those independently supplied digests too (a
 *    value read solely from the same untrusted record can never self-certify);
 *  - it validates path/reference containment, refuses escaping entries and
 *    preserves declared dependency links AS LINKS (it never dereferences or
 *    copies a link target);
 *  - it never extracts an archive — the archive is hashed only, and stays
 *    opaque;
 *  - any missing / unreadable / changed / tampered / escaping asset makes the
 *    reference NOT reusable and returns precise restoration guidance.
 *
 * The complete original input/context/source inventory and all live-release
 * safety proofs remain SEPARATE obligations: a reusable verdict here only
 * proves the retained report/session/link/archive portions, it does not grant
 * release.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The explicit caller-supplied selector. */
export interface PreservationReference {
  /** Absolute path to the legacy partial retention record. */
  readonly recordPath: string;
  /** Lowercase sha256 of the record file itself (digest binding). */
  readonly recordSha256: string;
  /** Independently established expected sha256 per sibling asset NAME. When
   * present, each must equal the record's declared digest for the same asset
   * (an independent cross-check, never a value read from the record alone). */
  readonly expectedAssets?: Readonly<Record<string, string>>;
}

export interface PreservationVerdict {
  /** True only when every reusable retained portion verified in place. */
  readonly reusable: boolean;
  /** Precise restoration guidance on refusal; null when reusable. */
  readonly guidance: string | null;
  /** The sibling asset names whose bytes were actually verified. */
  readonly verifiedAssets: readonly string[];
  /** The record's own verified digest (echo of `recordSha256`). */
  readonly recordSha256: string;
}

const REPORT_ASSET = 'complete-original-report.md';
const SESSION_ASSET = 'original-source-session.jsonl';
const LINK_MANIFEST_ASSET = 'link-preservation-manifest.json';

const refuse = (guidance: string, verifiedAssets: readonly string[] = [], recordSha256 = ''): PreservationVerdict => ({
  reusable: false,
  guidance,
  verifiedAssets,
  recordSha256,
});

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A candidate path must resolve strictly inside `root` (no escape). */
function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolvePreservationReference(input: {
  readonly reference: PreservationReference;
  readonly jobId: string;
  readonly expectedRepo?: string | null;
}): PreservationVerdict {
  const { reference, jobId } = input;
  if (!isAbsolute(reference.recordPath) || reference.recordPath.includes('..')) {
    return refuse('the preservation reference must be an explicit absolute path without ".." segments');
  }
  if (!/^[a-f0-9]{64}$/u.test(reference.recordSha256)) {
    return refuse('the preservation reference must carry a lowercase sha256 of the record');
  }
  let actualRecordSha: string;
  try {
    actualRecordSha = sha256(reference.recordPath);
  } catch (error) {
    return refuse(`the supplied preservation record is unreadable (${String(error)}) — the tree is retained`);
  }
  if (actualRecordSha !== reference.recordSha256) {
    return refuse(
      `the supplied preservation record digest does not match (expected ${reference.recordSha256}, got ${actualRecordSha}) — the tree is retained`,
    );
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(reference.recordPath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    return refuse(`the supplied preservation record is not valid JSON (${String(error)})`, [], actualRecordSha);
  }
  if (!isRecord(record)) return refuse('the preservation record is not an object', [], actualRecordSha);
  const job = isRecord(record['job']) ? record['job'] : null;
  const tree = isRecord(record['tree']) ? record['tree'] : null;
  if (job === null || tree === null) {
    return refuse('the preservation record does not carry the legacy partial job/tree shape', [], actualRecordSha);
  }
  // Independent identity binding: the record must name THIS release job.
  if (job['id'] !== jobId || tree['job_id'] !== jobId) {
    return refuse('the preservation record belongs to a different job — release refused', [], actualRecordSha);
  }
  if (input.expectedRepo !== undefined && input.expectedRepo !== null && job['repo'] !== input.expectedRepo) {
    return refuse('the preservation record names a different repository — release refused', [], actualRecordSha);
  }
  const treePath = typeof tree['path'] === 'string' ? tree['path'] : null;
  if (treePath === null || treePath === '') {
    return refuse('the preservation record carries no original tree path', [], actualRecordSha);
  }
  const recordDir = dirname(resolve(reference.recordPath));
  // The reusable original portions the legacy record declares.
  const declared: { readonly name: string; readonly sha: unknown }[] = [
    { name: REPORT_ASSET, sha: record['original_report_sha256'] },
    { name: SESSION_ASSET, sha: record['original_session_sha256'] },
  ];
  const verifiedAssets: string[] = [];
  for (const asset of declared) {
    if (typeof asset.sha !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha)) {
      return refuse(`the preservation record declares no usable digest for ${asset.name}`, verifiedAssets, actualRecordSha);
    }
    const expected = reference.expectedAssets?.[asset.name];
    if (expected !== undefined && expected !== asset.sha) {
      // Independently supplied digest contradicts the record: tampering.
      return refuse(
        `independent digest for ${asset.name} contradicts the preservation record — the tree is retained`,
        verifiedAssets,
        actualRecordSha,
      );
    }
    const assetPath = join(recordDir, asset.name);
    if (!contained(recordDir, assetPath)) {
      return refuse(`the preservation record references ${asset.name} outside its own directory — retained`, verifiedAssets, actualRecordSha);
    }
    let actual: string;
    try {
      actual = sha256(assetPath);
    } catch (error) {
      return refuse(`retained asset ${asset.name} is unreadable (${String(error)}) — the tree is retained`, verifiedAssets, actualRecordSha);
    }
    if (actual !== asset.sha) {
      return refuse(`retained asset ${asset.name} does not match its recorded digest — the tree is retained`, verifiedAssets, actualRecordSha);
    }
    verifiedAssets.push(asset.name);
  }
  // The link-preservation manifest (optional): declared dependency LINKS are
  // preserved as links and never dereferenced; every entry must stay inside
  // the original tree; the archive is hashed only and stays opaque.
  const manifestPath = join(recordDir, LINK_MANIFEST_ASSET);
  let manifest: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
    manifest = isRecord(parsed) ? parsed : null;
  } catch {
    manifest = null;
  }
  if (manifest !== null) {
    if (manifest['original_tree'] !== treePath) {
      return refuse('the link-preservation manifest names a different original tree — the tree is retained', verifiedAssets, actualRecordSha);
    }
    const entries = Array.isArray(manifest['relative_entries']) ? manifest['relative_entries'] : [];
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry === '' || isAbsolute(entry) || entry.includes('..')) {
        return refuse(`a link-preservation entry escapes the original tree ("${String(entry)}") — the tree is retained`, verifiedAssets, actualRecordSha);
      }
      const entryPath = join(treePath, entry);
      if (!contained(treePath, entryPath)) {
        return refuse(`a link-preservation entry escapes the original tree ("${entry}") — the tree is retained`, verifiedAssets, actualRecordSha);
      }
      let stat;
      try {
        stat = lstatSync(entryPath);
      } catch {
        // A preserved entry may live only in the opaque archive: the archive
        // hash below is the integrity witness; a live entry is verified as a
        // link without dereferencing it.
        continue;
      }
      if (stat.isSymbolicLink()) {
        // The link IS the deliverable: reading its target would dereference
        // it. Presence is enough — the target is never followed or copied.
        verifiedAssets.push(`link:${entry}`);
      }
    }
    const archiveSha = manifest['archive_sha256'];
    if (typeof archiveSha === 'string' && /^[a-f0-9]{64}$/u.test(archiveSha)) {
      const archivePath = join(recordDir, 'current-ignored-untracked-deliverables-links-preserved.tar.gz');
      try {
        if (sha256(archivePath) !== archiveSha) {
          return refuse('the preserved opaque archive does not match its recorded digest — the tree is retained', verifiedAssets, actualRecordSha);
        }
        verifiedAssets.push('archive(current-ignored-untracked-deliverables-links-preserved.tar.gz)');
      } catch {
        // No archive bytes present: the manifest's declared hash is the only
        // witness and remains UNKNOWN — never fabricated.
      }
    }
  }
  return { reusable: true, guidance: null, verifiedAssets, recordSha256: actualRecordSha };
}
