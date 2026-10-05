#!/usr/bin/env node
/** Publish a non-secret, deterministic dependency closure digest for installed
 * reviews. npm excludes package-lock.json from the tarball; its resolved URLs
 * and authentication fields must never appear in (or be hashed into) a review
 * manifest. Only audited public package names and numeric versions enter the
 * digest. Integrity and resolved URLs are deliberately never hashed. */
import { createHash } from 'node:crypto';
import process from 'node:process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
if (!Number.isSafeInteger(lock.lockfileVersion) || lock.lockfileVersion < 1 ||
  typeof lock.packages !== 'object' || lock.packages === null || Array.isArray(lock.packages)) {
  throw new Error('review dependency identity requires a valid npm package-lock packages map');
}
// Share the source-audited finite dependency names with the runtime reader;
// do not build an allowlist from untrusted lock contents.
const publicFields = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'public-loader-fields.ts'), 'utf8');
const match = /export const PUBLIC_DEPENDENCY_NAMES: ReadonlySet<string> = new Set\((\[[\s\S]*?\])\);/u.exec(publicFields);
if (!match) throw new Error('audited dependency names are missing');
const publicNames = new Set(JSON.parse(match[1]));
const publicPath = (path) => {
  if (path === '' || path === 'web' || path === 'node_modules/@gru-command/web') return true;
  const prefix = path.startsWith('node_modules/') ? 'node_modules/' : 'web/node_modules/';
  if (!path.startsWith(prefix)) return false;
  const names = path.slice(prefix.length).split('/node_modules/');
  return names.every((name) => publicNames.has(name));
};
const entries = Object.entries(lock.packages).filter(([path]) => publicPath(path))
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, entry]) => {
    if (!publicPath(path) || typeof entry !== 'object' || entry === null || Array.isArray(entry) ||
      (entry.version !== undefined && (typeof entry.version !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(entry.version))) ||
      (entry.version === undefined && !(path === 'node_modules/@gru-command/web' && entry.link === true))) {
      throw new Error('review dependency identity cannot safely represent lock package');
    }
    return [path, entry.version ?? null, entry.link === true];
  });
const dependencySha256 = createHash('sha256').update(JSON.stringify([lock.lockfileVersion, entries])).digest('hex');
const destination = join(root, 'dist', 'review-dependency-identity.json');
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify({ schemaVersion: 1, dependencySha256 })}\n`, { mode: 0o644 });
process.stdout.write(`review dependency identity → ${destination}\n`);
