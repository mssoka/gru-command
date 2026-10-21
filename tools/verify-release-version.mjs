#!/usr/bin/env node
/**
 * A release tag must name the version the package actually reports.
 *
 * `gru version` and `/health` read package.json, and the board's
 * deploy chip names the newest release tag — if the two drift, every
 * "update available" message lies about what the user is running. v1.0.1
 * shipped with package.json still at 1.0.0; this check makes that
 * impossible to repeat.
 *
 * usage: node tools/verify-release-version.mjs [tag] [--package <path>]
 *        tag defaults to $GITHUB_REF_NAME
 *
 * Exit 0 = tag matches; 1 = mismatch or non-release tag; 2 = usage.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SEMVER = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const RELEASE_TAG = new RegExp(`^v${SEMVER}$`);
const PACKAGE_VERSION = new RegExp(`^${SEMVER}$`);
const defaultPackage = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

function fail(message, code) {
  process.stderr.write(`verify-release-version: ${message}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
let tag = null;
let packagePath = defaultPackage;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(
      'usage: node tools/verify-release-version.mjs [tag] [--package <path>]\n' +
        '  Fails unless the release tag is vX.Y.Z and package.json reports X.Y.Z.\n',
    );
    process.exit(0);
  }
  if (arg === '--package') {
    const value = args[index + 1];
    if (value === undefined || value === '') fail('--package requires a path', 2);
    packagePath = resolve(value);
    index += 1;
    continue;
  }
  if (arg.startsWith('-')) fail(`unknown option: ${arg}`, 2);
  if (tag !== null) fail(`unexpected extra argument: ${arg}`, 2);
  tag = arg;
}
tag ??= process.env.GITHUB_REF_NAME ?? null;
if (tag === null || tag === '') fail('missing tag (pass vX.Y.Z or set GITHUB_REF_NAME)', 2);

if (!RELEASE_TAG.test(tag)) {
  fail(`"${tag}" is not a stable release tag (expected vMAJOR.MINOR.PATCH)`, 1);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(packagePath, 'utf-8'));
} catch (error) {
  fail(`cannot read package metadata at ${packagePath}: ${error instanceof Error ? error.message : String(error)}`, 1);
}
const version = parsed?.version;
if (typeof version !== 'string' || !PACKAGE_VERSION.test(version)) {
  fail(`package.json version is not MAJOR.MINOR.PATCH: ${JSON.stringify(version)}`, 1);
}

if (`v${version}` !== tag) {
  fail(`release tag ${tag} does not match package.json ${version} — bump package.json, commit, then tag`, 1);
}
process.stdout.write(`release tag ${tag} matches package.json ${version}\n`);
