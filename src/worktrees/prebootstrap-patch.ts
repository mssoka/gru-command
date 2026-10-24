import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const PREBOOTSTRAP_PATCH_AUTHORIZATION = 'GC PRE-BOOTSTRAP DEPENDENCY PATCH AUTHORIZATION: files=requirements.txt';
export const PREBOOTSTRAP_PATCH_MAX_PACKAGE_BYTES = 1024 * 1024;
export const PREBOOTSTRAP_PATCH_MAX_FILE_BYTES = 256 * 1024;
export const PREBOOTSTRAP_PATCH_ALLOWLIST = ['requirements.txt'] as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*\])?==([A-Za-z0-9][A-Za-z0-9.!+_-]*)$/u;

export class PreBootstrapPatchError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PreBootstrapPatchError';
  }
}

export interface PreBootstrapPatchReference {
  readonly packageFile: string;
  readonly packageSha256: string;
}

export interface PreBootstrapDependencyPatchPackage {
  readonly version: 1;
  readonly repository: {
    readonly path: string;
    readonly originSha256: string;
  };
  readonly base: {
    readonly commit: string;
    readonly tree: string;
  };
  readonly authority: {
    readonly contractSha256: string;
    readonly workRevision: number;
    readonly authorityEpoch: number;
    readonly requestSha256: string;
  };
  readonly allowlist: typeof PREBOOTSTRAP_PATCH_ALLOWLIST;
  readonly files: readonly [{
    readonly path: 'requirements.txt';
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly content: string;
  }];
}

export interface PreBootstrapPatchDispatchIdentity {
  readonly jobId: string;
  readonly repoPath: string;
  readonly title: string;
  readonly displayName: string | null;
  readonly deliverable: string;
  readonly briefing: string;
  readonly completionHandoff: { readonly kind: 'gru-decision'; readonly decision: string } | null;
  readonly packageFile: string;
}

export interface LoadedPreBootstrapPatch {
  readonly reference: PreBootstrapPatchReference;
  readonly package: PreBootstrapDependencyPatchPackage;
  readonly packagePath: string;
  readonly packageBytesSha256: string;
  readonly requestPayloadSha256: string;
  readonly intakeIdentitySha256: string;
}

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new PreBootstrapPatchError('package_invalid', `${label} must contain exactly: ${wanted.join(', ')}`);
  }
};
const stringField = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new PreBootstrapPatchError('package_invalid', `${label} must be a non-empty string`);
  return value;
};
const hashField = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new PreBootstrapPatchError('package_invalid', `${label} must be a lowercase SHA-256 digest`);
  return value;
};
const treeObjectField = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new PreBootstrapPatchError('package_invalid', `${label} must be a full Git object id`);
  return value;
};

/** JSON.parse accepts duplicate keys by keeping the last value. The package
 * format is strict and hash-pinned, so refuse that ambiguous representation. */
function assertUniqueJsonObjectKeys(text: string): void {
  let index = 0;
  const whitespace = (): void => { while (/\s/u.test(text[index] ?? '')) index += 1; };
  const string = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') index += 2;
      else if (character === '"') { index += 1; return JSON.parse(text.slice(start, index)) as string; }
      else index += 1;
    }
    throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package contains an unterminated JSON string');
  };
  const value = (): void => {
    whitespace();
    if (text[index] === '{') {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === '}') { index += 1; return; }
      while (index < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new PreBootstrapPatchError('package_invalid', `prebootstrap package contains duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        index += 1; // the already-validated colon
        value();
        whitespace();
        const separator = text[index];
        index += 1;
        if (separator === '}') return;
        if (separator !== ',') throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package contains malformed JSON object syntax');
      }
    } else if (text[index] === '[') {
      index += 1;
      whitespace();
      if (text[index] === ']') { index += 1; return; }
      while (index < text.length) {
        value();
        whitespace();
        const separator = text[index];
        index += 1;
        if (separator === ']') return;
        if (separator !== ',') throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package contains malformed JSON array syntax');
      }
    } else if (text[index] === '"') {
      string();
    } else {
      while (index < text.length && !/[\s,\]}]/u.test(text[index] ?? '')) index += 1;
    }
    if (index > text.length) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package JSON scan exceeded its input');
  };
  value();
  whitespace();
  if (index !== text.length) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package has trailing JSON content');
}

/** The package name is a basename, not a caller-selected path. */
export function parsePreBootstrapPatchReference(value: unknown): PreBootstrapPatchReference {
  if (!isRecord(value)) throw new PreBootstrapPatchError('request_invalid', 'prebootstrap_patch must be an object');
  exactKeys(value, ['package_file', 'package_sha256'], 'prebootstrap_patch');
  const packageFile = stringField(value['package_file'], 'prebootstrap_patch.package_file');
  if (packageFile.length > 128 || packageFile === '.' || packageFile === '..' || packageFile.includes('/') || packageFile.includes('\\') || packageFile.includes('\u0000') || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(packageFile)) {
    throw new PreBootstrapPatchError('request_invalid', 'prebootstrap_patch.package_file must be a plain .json basename');
  }
  const packageSha256 = hashField(value['package_sha256'], 'prebootstrap_patch.package_sha256');
  return { packageFile, packageSha256 };
}

/** Stable, versioned normalized dispatch identity. The package SHA is
 * deliberately separate (self-reference would make its content hash
 * circular); the package basename and all other dispatch fields are bound. */
export function preBootstrapRequestPayloadSha256(input: PreBootstrapPatchDispatchIdentity): string {
  const canonical = JSON.stringify({
    version: 1,
    job_id: input.jobId,
    repo_path: input.repoPath,
    title: input.title,
    display_name: input.displayName,
    deliverable: input.deliverable,
    briefing_sha256: sha256(input.briefing),
    completion_handoff: input.completionHandoff === null ? null : {
      kind: input.completionHandoff.kind,
      decision: input.completionHandoff.decision,
    },
    prebootstrap_package_file: input.packageFile,
  });
  return sha256(canonical);
}

/** This joins the non-circular package request digest to the exact package
 * bytes supplied by the request. Persist this as the full intake identity. */
export function preBootstrapIntakeIdentitySha256(requestPayloadSha256: string, packageSha256: string): string {
  if (!SHA256.test(requestPayloadSha256) || !SHA256.test(packageSha256)) throw new PreBootstrapPatchError('request_invalid', 'prebootstrap intake identity requires two SHA-256 digests');
  return sha256(JSON.stringify({ version: 1, request_payload_sha256: requestPayloadSha256, package_sha256: packageSha256 }));
}

export function parsePreBootstrapDependencyPatchPackage(bytes: Buffer, expectedSha256: string): PreBootstrapDependencyPatchPackage {
  if (bytes.length > PREBOOTSTRAP_PATCH_MAX_PACKAGE_BYTES) throw new PreBootstrapPatchError('package_invalid', `prebootstrap package exceeds ${PREBOOTSTRAP_PATCH_MAX_PACKAGE_BYTES} bytes`);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) throw new PreBootstrapPatchError('package_hash_mismatch', 'prebootstrap package SHA-256 does not match the supplied digest');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package must be valid UTF-8 JSON bytes');
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; } catch (error) {
    throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package is not valid UTF-8 JSON', { cause: error });
  }
  assertUniqueJsonObjectKeys(text);
  if (!isRecord(raw)) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package root must be an object');
  exactKeys(raw, ['version', 'repository', 'base', 'authority', 'allowlist', 'files'], 'prebootstrap package');
  if (raw['version'] !== 1) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package version must be 1');

  const repository = raw['repository'];
  if (!isRecord(repository)) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package repository must be an object');
  exactKeys(repository, ['path', 'origin_sha256'], 'prebootstrap package repository');
  const repositoryPath = stringField(repository['path'], 'prebootstrap package repository.path');
  if (!isAbsolute(repositoryPath) || repositoryPath.includes('\u0000')) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package repository.path must be an absolute canonical path');
  const originSha256 = hashField(repository['origin_sha256'], 'prebootstrap package repository.origin_sha256');

  const base = raw['base'];
  if (!isRecord(base)) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package base must be an object');
  exactKeys(base, ['commit', 'tree'], 'prebootstrap package base');
  const baseCommit = treeObjectField(base['commit'], 'prebootstrap package base.commit');
  const baseTree = treeObjectField(base['tree'], 'prebootstrap package base.tree');

  const authority = raw['authority'];
  if (!isRecord(authority)) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package authority must be an object');
  exactKeys(authority, ['contract_sha256', 'work_revision', 'authority_epoch', 'request_sha256'], 'prebootstrap package authority');
  const contractSha256 = hashField(authority['contract_sha256'], 'prebootstrap package authority.contract_sha256');
  const requestSha256 = hashField(authority['request_sha256'], 'prebootstrap package authority.request_sha256');
  const workRevision = authority['work_revision'];
  const authorityEpoch = authority['authority_epoch'];
  if (!Number.isSafeInteger(workRevision) || workRevision !== 0) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package work_revision must be the initial revision 0');
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch !== 0) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package authority_epoch must be the initial epoch 0');

  const allowlist = raw['allowlist'];
  if (!Array.isArray(allowlist) || allowlist.length !== 1 || allowlist[0] !== PREBOOTSTRAP_PATCH_ALLOWLIST[0]) {
    throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package allowlist must be exactly ["requirements.txt"]');
  }
  const files = raw['files'];
  if (!Array.isArray(files) || files.length !== 1 || !isRecord(files[0])) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package must contain exactly one file change');
  const file = files[0];
  exactKeys(file, ['path', 'before_sha256', 'after_sha256', 'content'], 'prebootstrap package files[0]');
  if (file['path'] !== 'requirements.txt') throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package file path must be exactly requirements.txt');
  const beforeSha256 = hashField(file['before_sha256'], 'prebootstrap package files[0].before_sha256');
  const afterSha256 = hashField(file['after_sha256'], 'prebootstrap package files[0].after_sha256');
  if (beforeSha256 === afterSha256) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package must change the pinned dependency file');
  const content = stringField(file['content'], 'prebootstrap package files[0].content');
  const contentBytes = Buffer.from(content, 'utf8');
  if (contentBytes.length > PREBOOTSTRAP_PATCH_MAX_FILE_BYTES || content.includes('\u0000') || contentBytes.toString('utf8') !== content) {
    throw new PreBootstrapPatchError('package_invalid', `prebootstrap requirements content must be valid UTF-8 text of at most ${PREBOOTSTRAP_PATCH_MAX_FILE_BYTES} bytes`);
  }
  if (sha256(contentBytes) !== afterSha256) throw new PreBootstrapPatchError('package_hash_mismatch', 'prebootstrap requirements content does not match its after_sha256');

  return {
    version: 1,
    repository: { path: repositoryPath, originSha256 },
    base: { commit: baseCommit, tree: baseTree },
    authority: { contractSha256, workRevision: 0, authorityEpoch: 0, requestSha256 },
    allowlist: PREBOOTSTRAP_PATCH_ALLOWLIST,
    files: [{ path: 'requirements.txt', beforeSha256, afterSha256, content }],
  };
}

/** Read a hash-pinned package with no symlink or path escape. The inode read
 * is compared with the lstat receipt to close the usual replace-before-open
 * race; callers re-read before application as well. */
export function readPreBootstrapDependencyPatchPackage(
  root: string,
  reference: PreBootstrapPatchReference,
): LoadedPreBootstrapPatch {
  const record = reference as unknown as Record<string, unknown>;
  const safeReference = parsePreBootstrapPatchReference({ package_file: record['packageFile'], package_sha256: record['packageSha256'] });
  let rootStat;
  let rootPath: string;
  try {
    rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) throw new Error('package root is not a private regular directory');
    rootPath = realpathSync(root);
  } catch (error) {
    throw new PreBootstrapPatchError('package_unavailable', 'prebootstrap package root is unavailable or is not owner-only', { cause: error });
  }
  const path = join(rootPath, safeReference.packageFile);
  let listed;
  try { listed = lstatSync(path); } catch (error) {
    throw new PreBootstrapPatchError('package_unavailable', `prebootstrap package ${safeReference.packageFile} is unavailable`, { cause: error });
  }
  if (!listed.isFile() || listed.isSymbolicLink() || (listed.mode & 0o077) !== 0 || listed.size > PREBOOTSTRAP_PATCH_MAX_PACKAGE_BYTES) {
    throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package must be a bounded owner-only regular file, not a symlink');
  }
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); } catch (error) {
    throw new PreBootstrapPatchError('package_unavailable', `prebootstrap package ${safeReference.packageFile} could not be opened safely`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || (opened.mode & 0o077) !== 0 || opened.dev !== listed.dev || opened.ino !== listed.ino || opened.size !== listed.size || opened.size > PREBOOTSTRAP_PATCH_MAX_PACKAGE_BYTES) {
      throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package changed while it was being opened');
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new PreBootstrapPatchError('package_invalid', 'prebootstrap package ended before its recorded size');
      offset += count;
    }
  } catch (error) {
    if (error instanceof PreBootstrapPatchError) throw error;
    throw new PreBootstrapPatchError('package_unavailable', 'prebootstrap package could not be read safely', { cause: error });
  } finally { closeSync(fd); }
  const parsed = parsePreBootstrapDependencyPatchPackage(bytes, safeReference.packageSha256);
  const requestPayloadSha256 = parsed.authority.requestSha256;
  return {
    reference: safeReference,
    package: parsed,
    packagePath: path,
    packageBytesSha256: safeReference.packageSha256,
    requestPayloadSha256,
    intakeIdentitySha256: preBootstrapIntakeIdentitySha256(requestPayloadSha256, safeReference.packageSha256),
  };
}

export function assertPreBootstrapContractAuthorization(briefing: string): void {
  const markers = [...briefing.matchAll(/^GC PRE-BOOTSTRAP DEPENDENCY PATCH AUTHORIZATION: files=requirements\.txt$/gmu)];
  const attempts = [...briefing.matchAll(/^GC PRE-BOOTSTRAP DEPENDENCY PATCH AUTHORIZATION:/gmu)];
  if (markers.length !== 1 || attempts.length !== 1) {
    throw new PreBootstrapPatchError('authorization_missing', 'work contract must contain exactly one `GC PRE-BOOTSTRAP DEPENDENCY PATCH AUTHORIZATION: files=requirements.txt` line');
  }
}

export function assertPreBootstrapPatchDispatchBinding(
  loaded: LoadedPreBootstrapPatch,
  input: PreBootstrapPatchDispatchIdentity,
): void {
  assertPreBootstrapContractAuthorization(input.briefing);
  const packageData = loaded.package;
  const contractSha256 = sha256(input.briefing);
  if (packageData.authority.contractSha256 !== contractSha256) throw new PreBootstrapPatchError('contract_mismatch', 'prebootstrap package is bound to a different work contract');
  const requestSha256 = preBootstrapRequestPayloadSha256(input);
  if (packageData.authority.requestSha256 !== requestSha256 || loaded.requestPayloadSha256 !== requestSha256) {
    throw new PreBootstrapPatchError('request_mismatch', 'prebootstrap package is bound to a different dispatch payload');
  }
  if (loaded.reference.packageSha256 !== loaded.packageBytesSha256 || loaded.intakeIdentitySha256 !== preBootstrapIntakeIdentitySha256(requestSha256, loaded.reference.packageSha256)) {
    throw new PreBootstrapPatchError('request_mismatch', 'prebootstrap package intake identity is inconsistent');
  }
}

/** The only supported dependency syntax contains pinned requirements; comments
 * and blank lines are immutable across the patch, so configuration, includes,
 * URLs, credentials, command flags, environment markers and VCS paths cannot
 * enter through this write surface. Every line keeps its slot: a pin keeps its
 * exact name and extras and may change only its `==version`, so no
 * distribution is added, removed or moved. */
export function assertSafeRequirementsPatch(before: string, after: string): void {
  type Line = { readonly pin: null; readonly text: string } | { readonly pin: string; readonly spec: string; readonly version: string; readonly text: string };
  const parse = (text: string, label: string): readonly Line[] => {
    if (Buffer.byteLength(text, 'utf8') > PREBOOTSTRAP_PATCH_MAX_FILE_BYTES || text.includes('\u0000') || text.includes('\r') || Buffer.from(text, 'utf8').toString('utf8') !== text) {
      throw new PreBootstrapPatchError('content_invalid', `${label} must be bounded UTF-8 text with LF newlines`);
    }
    const names = new Set<string>();
    const lines = text.split('\n').map((line, index): Line => {
      if (line === '' || /^\s*$/u.test(line) || /^\s*#/u.test(line)) return { pin: null, text: line };
      const match = REQUIREMENT.exec(line);
      if (match === null) throw new PreBootstrapPatchError('content_invalid', `${label} line ${String(index + 1)} is not a pinned distribution==version dependency`);
      const name = (match[1] ?? '').toLowerCase().replace(/[-_.]+/gu, '-');
      if (names.has(name)) throw new PreBootstrapPatchError('content_invalid', `${label} contains duplicate dependency ${name}`);
      names.add(name);
      const version = match[2] ?? '';
      return { pin: name, spec: line.slice(0, line.length - version.length - 2), version, text: line };
    });
    if (names.size === 0) throw new PreBootstrapPatchError('content_invalid', `${label} must contain at least one pinned dependency`);
    return lines;
  };
  const oldLines = parse(before, 'existing requirements.txt');
  const newLines = parse(after, 'patched requirements.txt');
  const pins = (lines: readonly Line[]): ReadonlySet<string> => new Set(lines.flatMap((line) => line.pin === null ? [] : [line.pin]));
  const oldPins = pins(oldLines);
  const newPins = pins(newLines);
  for (const name of newPins) {
    if (!oldPins.has(name)) throw new PreBootstrapPatchError('content_invalid', `prebootstrap patch adds distribution ${name}; it may change pinned versions only`);
  }
  for (const name of oldPins) {
    if (!newPins.has(name)) throw new PreBootstrapPatchError('content_invalid', `prebootstrap patch removes the pin for ${name}; it may change pinned versions only`);
  }
  if (oldLines.length !== newLines.length) {
    throw new PreBootstrapPatchError('content_invalid', 'prebootstrap patch may change pinned dependency declarations only; comments and blank lines must remain unchanged');
  }
  let changed = false;
  for (const [index, oldLine] of oldLines.entries()) {
    const newLine = newLines[index]!;
    if (oldLine.pin === null || newLine.pin === null || oldLine.pin !== newLine.pin) {
      const moved = oldLine.pin ?? newLine.pin;
      if (moved !== null) throw new PreBootstrapPatchError('content_invalid', `prebootstrap patch moves distribution ${moved}; every pin must keep its line`);
      if (oldLine.text !== newLine.text) {
        throw new PreBootstrapPatchError('content_invalid', 'prebootstrap patch may change pinned dependency declarations only; comments and blank lines must remain unchanged');
      }
      continue;
    }
    if (newLine.spec !== oldLine.spec) throw new PreBootstrapPatchError('content_invalid', `prebootstrap patch changes more than the version of ${oldLine.pin}`);
    if (newLine.version !== oldLine.version) changed = true;
  }
  if (!changed) throw new PreBootstrapPatchError('content_invalid', 'prebootstrap dependency patch does not change any pinned dependency');
}

export function originIdentitySha256(origin: string): string {
  return sha256(origin.trim());
}

export function preBootstrapPackageContentSha256(content: string): string {
  return sha256(Buffer.from(content, 'utf8'));
}
