#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const PERKINS_POLICY_SHA256 = '9debb01babf453f87771e99d0d76768742e91a568100dfb3389e80075c4b203a';
const PERKINS_CANONICAL_SOURCE_SHA256 = 'f38c28ffb10b4e44fa1f87f260a08507bb0a5c8872de2cf47e05a985c5eb92e7';
const PERKINS_MCP_SERVER_SHA256 = 'badd96c16800cffb9e18734f777d40d423b72423b89debed5684ad42c62f2032';
const MAX_VERIFIED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RESIDUE_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_SCAN_FILE_BYTES = 16 * 1024 * 1024;
// Keep excluded identifiers out of tracked bytes while still constructing
// the data-only scanner's denylist at runtime.
const EXCLUDED_PRODUCT_MARKERS = [
  ['j', 'ev'],
  ['open', 'router'],
  ['decision', 'service'],
  ['api', 'alpha', 'decisions'],
  ['open', 'router', 'api', 'key'],
].map((parts) => parts.join(''));
// The residue invariant is PERKINS-SURFACE INDEPENDENCE: the integrity-pinned
// Perkins policy/bridge/server bytes and the Perkins role must not embed the
// optional Jev decision feature. It was originally written as a whole-product
// scan when Jev shipped nowhere; since the decisions lane landed
// (gru-command-jev-integration), the product legitimately carries Jev outside
// the Perkins surface, so the scan is scoped to the Perkins-owned paths.
const PRODUCT_SCAN_ENTRIES = [
  'dist/dispatch/perkins-review',
  'dist/dispatch/perkins.js',
  'dist/runtime/review-mcp-bridge.js',
  'dist/runtime/review-mcp-server.mjs',
  'resources',
  'roles',
];

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function regularInRoot(root, path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlinked file: ${path}`);
  }
  const actual = realpathSync(path);
  if (!contained(root, actual)) throw new Error(`${label} resolves outside the installed product root: ${actual}`);
  return actual;
}

function boundedBytes(path, label) {
  const size = statSync(path).size;
  if (size > MAX_VERIFIED_FILE_BYTES) throw new Error(`${label} exceeds ${MAX_VERIFIED_FILE_BYTES} bytes`);
  const bytes = readFileSync(path);
  if (bytes.byteLength !== size || bytes.byteLength > MAX_VERIFIED_FILE_BYTES) {
    throw new Error(`${label} changed while bounded bytes were read`);
  }
  return bytes;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function scanExcludedResidue(root) {
  let scannedBytes = 0;
  let scannedFiles = 0;
  // NOTE: visit/scanFile are hoisted function declarations below.
  for (const entry of PRODUCT_SCAN_ENTRIES) {
    const candidate = join(root, entry);
    // Only the TOP-LEVEL entry may be absent (optional shipped path). Any
    // ENOENT raised inside the recursive walk is a mid-scan disappearance
    // and fails verification loudly instead of silently truncating the scan.
    let topInfo = null;
    try {
      topInfo = lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    visit(topInfo, candidate);
  }
  return { scannedBytes, scannedFiles };

  function visit(info, candidate) {
    if (info.isSymbolicLink()) throw new Error(`product residue scan refuses symlink: ${candidate}`);
    const rel = relative(root, candidate).split(sep).join('/');
    const loweredPath = rel.toLowerCase();
    const normalizedPath = loweredPath.replace(/[^a-z0-9]+/gu, '');
    for (const marker of EXCLUDED_PRODUCT_MARKERS) {
      if (normalizedPath.includes(marker)) throw new Error(`excluded product residue found in path: ${rel}`);
    }
    if (info.isDirectory()) {
      for (const entry of readdirSync(candidate).sort()) visit(lstatSync(join(candidate, entry)), join(candidate, entry));
      return;
    }
    if (!info.isFile()) throw new Error(`product residue scan found non-regular entry: ${candidate}`);
    scanFile(candidate, rel, info);
  }

  function scanFile(candidate, rel, info) {
    if (info.size > MAX_SCAN_FILE_BYTES || scannedBytes + info.size > MAX_RESIDUE_SCAN_BYTES) {
      throw new Error(`product residue scan byte bound exceeded at: ${rel}`);
    }
    const bytes = readFileSync(candidate);
    if (bytes.byteLength !== info.size) throw new Error(`product residue file changed while read: ${rel}`);
    scannedBytes += bytes.byteLength;
    scannedFiles += 1;
    // This trusted verifier necessarily carries the fragmented denylist used
    // to detect residue. Scan every other shipping file's bytes.
    if (rel === 'tools/verify-perkins-resource.mjs') return;
    const loweredText = bytes.toString('utf8').toLowerCase();
    for (const marker of EXCLUDED_PRODUCT_MARKERS) {
      if (loweredText.includes(marker)) throw new Error(`excluded product residue found in file: ${rel}`);
    }
    // Separator-tolerant pass for the long vendor identifiers (spaced,
    // hyphenated, or slash-separated spellings): strip separators, then
    // match. Short markers stay raw-substring to avoid false positives in
    // generated bytes.
    const normalizedText = loweredText.replace(/[^a-z0-9]+/gu, '');
    for (const marker of EXCLUDED_PRODUCT_MARKERS) {
      if (marker.length >= 8 && normalizedText.includes(marker)) {
        throw new Error(`excluded product residue found in file: ${rel}`);
      }
    }
  }
}

const requestedRoot = process.argv[2];
if (requestedRoot === undefined || requestedRoot.trim() === '') {
  process.stderr.write('usage: node tools/verify-perkins-resource.mjs <installed-product-root>\n');
  process.exitCode = 2;
} else {
  const root = realpathSync(resolve(requestedRoot));
  const moduleFile = regularInRoot(
    root,
    join(root, 'dist', 'dispatch', 'perkins-review', 'policy.js'),
    'Perkins policy module',
  );
  const bridgeModuleFile = regularInRoot(
    root,
    join(root, 'dist', 'runtime', 'review-mcp-bridge.js'),
    'Perkins MCP bridge module',
  );
  const policyFile = regularInRoot(
    root,
    join(root, 'resources', 'perkins-code-review', 'policy.json'),
    'Perkins policy resource',
  );
  const bridgeFile = regularInRoot(
    root,
    join(root, 'dist', 'runtime', 'review-mcp-server.mjs'),
    'Perkins MCP server',
  );

  const policyBytes = boundedBytes(policyFile, 'Perkins policy resource');
  const bridgeBytes = boundedBytes(bridgeFile, 'Perkins MCP server');
  const policyModuleSource = boundedBytes(moduleFile, 'Perkins policy module').toString('utf8');
  const bridgeModuleSource = boundedBytes(bridgeModuleFile, 'Perkins MCP bridge module').toString('utf8');
  const policySha256 = sha256(policyBytes);
  const bridgeSha256 = sha256(bridgeBytes);
  if (policySha256 !== PERKINS_POLICY_SHA256) {
    throw new Error(`Perkins resource integrity mismatch: expected ${PERKINS_POLICY_SHA256}, got ${policySha256}`);
  }
  if (bridgeSha256 !== PERKINS_MCP_SERVER_SHA256) {
    throw new Error(`Perkins MCP server integrity mismatch: expected ${PERKINS_MCP_SERVER_SHA256}, got ${bridgeSha256}`);
  }
  for (const [source, name, value] of [
    [policyModuleSource, 'PERKINS_POLICY_SHA256', PERKINS_POLICY_SHA256],
    [policyModuleSource, 'PERKINS_CANONICAL_SOURCE_SHA256', PERKINS_CANONICAL_SOURCE_SHA256],
    [bridgeModuleSource, 'PERKINS_MCP_SERVER_SHA256', PERKINS_MCP_SERVER_SHA256],
  ]) {
    if (!source.includes(name) || !source.includes(value)) {
      throw new Error(`compiled Perkins module does not carry the pinned ${name}`);
    }
  }

  let policy;
  try {
    policy = JSON.parse(policyBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Perkins policy resource is malformed JSON (${String(error)})`);
  }
  if (
    policy?.identity !== 'perkins-code-review' || policy?.version !== 1 ||
    policy?.provenance?.sourceSha256 !== PERKINS_CANONICAL_SOURCE_SHA256 ||
    policy?.portableContract?.rules?.incompleteNeverApproves !== true
  ) {
    throw new Error('Perkins policy identity/provenance/rules contract is invalid');
  }

  const residueScan = scanExcludedResidue(root);
  process.stdout.write(`${JSON.stringify({
    loadedFile: policyFile,
    bridgeFile,
    policySha256,
    bridgeSha256,
    canonicalSourceSha256: policy.provenance.sourceSha256,
    residueScan,
  })}\n`);
}
