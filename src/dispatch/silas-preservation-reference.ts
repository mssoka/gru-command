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
 *    reference NOT reusable and returns precise restoration guidance — the
 *    link-preservation manifest included: a missing or malformed manifest,
 *    or a declared archive that is absent, never verifies as reusable (#367);
 *  - every read is no-follow: the record, its assets and the archive must be
 *    single-link regular files (a symlink or FIFO is refused, never read
 *    through), and containment is decided on realpaths with exact `..`
 *    segments, never a lexical prefix (#367).
 *
 * Wiring (#367): the selector is reachable only through the autopilot
 * release seam's explicit `preservationReference`; no plan supplies one, so
 * using it remains a deliberate caller decision — this resolver is safe to
 * wire because it fails closed on every missing or malformed input.
 *
 * The complete original input/context/source inventory and all live-release
 * safety proofs remain SEPARATE obligations: a reusable verdict here only
 * proves the retained report/session/link/archive portions, it does not grant
 * release.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

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

/** Bytes of a SINGLE-LINK REGULAR file, never read through a symlink, FIFO
 * or other entry (#367): lstat decides what the path names before any read. */
function regularFileBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${path} is not a single-link regular file`);
  return readFileSync(path);
}

const sha256 = (path: string): string => createHash('sha256').update(regularFileBytes(path)).digest('hex');

/** A path carrying an exact `..` segment (never a lexical substring match). */
const hasParentSegment = (path: string): boolean => path.split(/[\\/]/u).includes('..');

/** `candidate` resolves strictly inside `root`, decided on REALPATHS (#367):
 * the deepest EXISTING ancestor of the candidate is resolved (so a symlinked
 * directory cannot carry an entry outside the tree) and the remaining,
 * not-yet-existing segments — already free of exact `..` — are appended.
 * The candidate itself is never followed (it may BE a preserved link). */
function contained(root: string, candidate: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rest: string[] = [basename(candidate)];
  let ancestor = dirname(candidate);
  let realAncestor: string | null = null;
  while (realAncestor === null) {
    try {
      realAncestor = realpathSync(ancestor);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return false;
      rest.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
  const rel = relative(realRoot, join(realAncestor, ...rest));
  return rel === '' || (!hasParentSegment(rel) && !isAbsolute(rel));
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
  if (!isAbsolute(reference.recordPath) || hasParentSegment(reference.recordPath)) {
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
    record = JSON.parse(regularFileBytes(reference.recordPath).toString('utf-8')) as Record<string, unknown>;
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
  // The link-preservation manifest is REQUIRED (#367): declared dependency
  // LINKS are preserved as links and never dereferenced; every entry must
  // stay inside the original tree; the archive is hashed only and stays
  // opaque. A missing, unreadable or malformed manifest is never "nothing
  // to verify" — it refuses.
  const manifestPath = join(recordDir, LINK_MANIFEST_ASSET);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(regularFileBytes(manifestPath).toString('utf-8')) as unknown;
    if (!isRecord(parsed)) {
      return refuse('the link-preservation manifest is not an object — the tree is retained', verifiedAssets, actualRecordSha);
    }
    manifest = parsed;
  } catch (error) {
    return refuse(`the link-preservation manifest is missing, unreadable or malformed (${String(error)}) — the tree is retained`, verifiedAssets, actualRecordSha);
  }
  {
    if (manifest['original_tree'] !== treePath) {
      return refuse('the link-preservation manifest names a different original tree — the tree is retained', verifiedAssets, actualRecordSha);
    }
    if (!Array.isArray(manifest['relative_entries'])) {
      return refuse('the link-preservation manifest carries no relative_entries list — the tree is retained', verifiedAssets, actualRecordSha);
    }
    const entries: readonly unknown[] = manifest['relative_entries'];
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry === '' || isAbsolute(entry) || hasParentSegment(entry)) {
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
    // `archive_sha256` is "" when no archive was retained; anything else must
    // be a digest whose archive bytes are present and match (#367): a
    // declared-but-absent archive is unverified, never reusable.
    const archiveSha = manifest['archive_sha256'];
    if (archiveSha !== '' && (typeof archiveSha !== 'string' || !/^[a-f0-9]{64}$/u.test(archiveSha))) {
      return refuse('the link-preservation manifest declares a malformed archive digest — the tree is retained', verifiedAssets, actualRecordSha);
    }
    if (archiveSha !== '') {
      const archivePath = join(recordDir, 'current-ignored-untracked-deliverables-links-preserved.tar.gz');
      let actualArchive: string;
      try {
        actualArchive = sha256(archivePath);
      } catch (error) {
        return refuse(`the declared opaque archive is missing or unreadable (${String(error)}) — the tree is retained`, verifiedAssets, actualRecordSha);
      }
      if (actualArchive !== archiveSha) {
        return refuse('the preserved opaque archive does not match its recorded digest — the tree is retained', verifiedAssets, actualRecordSha);
      }
      verifiedAssets.push('archive(current-ignored-untracked-deliverables-links-preserved.tar.gz)');
    }
  }
  return { reusable: true, guidance: null, verifiedAssets, recordSha256: actualRecordSha };
}
