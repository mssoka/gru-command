import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Quota-race racer (Perkins r2 B1/W3/W5). Runs the REAL production
 * resolver in a real process; only fs scheduling is instrumented (never
 * product code). Schedules:
 *
 *  - natural : no instrumentation; waits for the parent's `go` barrier.
 *  - barrier : both claims exist before either election scan, and both
 *              election scans complete before either commit (the exact
 *              interleaving that reproduced the both-rejected defect).
 *  - miss    : as `barrier`, but each election scan is filtered to hide
 *              the PEER's claim (simulating a readdir miss), and both
 *              commits complete before either post-commit audit. Pins the
 *              never-overbook invariant and discriminates the audit.
 *
 * Every wait has a deadline and every failure lands in result-<id>.json
 * as { ok:false, fatal } so a lost racer can never hang the suite (r2 W5).
 */

const [uploadsDir, coordDir, id, schedule] = process.argv.slice(2);
if (!uploadsDir || !coordDir || !id || !schedule) {
  throw new Error('materialize-upload-worker: missing argument (uploadsDir coordDir id schedule)');
}
if (!['natural', 'barrier', 'miss'].includes(schedule)) {
  throw new Error(`materialize-upload-worker: unknown schedule ${schedule}`);
}

const { existsSync, writeFileSync: coordWrite } = fs;
const DEADLINE_MS = 15_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const coord = (name) => join(coordDir, name);

function waitFor(path, what) {
  const deadline = Date.now() + DEADLINE_MS;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`barrier timeout: ${what}`);
    Atomics.wait(sleeper, 0, 0, 2);
  }
}

function fail(message) {
  coordWrite(coord(`result-${id}.json`), JSON.stringify({ ok: false, fatal: message }));
}

coordWrite(coord(`ready-${id}`), String(process.pid), { flag: 'wx' });

try {
  if (schedule === 'natural') {
    waitFor(coord('go'), 'go');
  } else {
    const originalWrite = fs.writeFileSync;
    const originalRename = fs.renameSync;
    const originalReaddir = fs.readdirSync;
    const claimPrefix = '.gru-upload-claim-';
    let myClaim = null;
    let scans = 0;

    fs.writeFileSync = function (path, ...args) {
      const result = originalWrite.call(fs, path, ...args);
      // The admission write is the resolver's only write into the uploads
      // dir during materialize — detect by location (not name) so a
      // mutated admission cannot silently bypass the barrier.
      if (String(path).startsWith(uploadsDir + '/')) {
        myClaim = String(path).split('/').pop();
        coordWrite(coord(`claimed-${id}`), '1', { flag: 'wx' });
        waitFor(coord('scan-go'), 'scan-go');
      }
      return result;
    };
    fs.renameSync = function (from, to, ...args) {
      const result = originalRename.call(fs, from, to, ...args);
      if (myClaim !== null && String(from).endsWith(myClaim)) {
        coordWrite(coord(`committed-${id}`), '1', { flag: 'wx' });
        if (schedule === 'miss') waitFor(coord('audit-go'), 'audit-go');
      }
      return result;
    };
    fs.readdirSync = function (path, ...args) {
      const result = originalReaddir.call(fs, path, ...args);
      if (String(path) === uploadsDir) {
        scans += 1;
        // Scan ordinals in materializeUpload: #1 cleanup, #2 election,
        // #3 audit. Only the election scan is barriered/filtered.
        if (scans === 2) {
          coordWrite(coord(`scanned-${id}`), '1', { flag: 'wx' });
          waitFor(coord('commit-go'), 'commit-go');
          if (schedule === 'miss') {
            return result.filter((entry) => !entry.startsWith(claimPrefix) || entry === myClaim);
          }
        }
      }
      return result;
    };
    syncBuiltinESMExports();
  }

  const { materializeUpload } = await import('../../src/attachments/resolver.ts');
  let result;
  try {
    const stored = materializeUpload(uploadsDir, {
      filename: `racer-${id}.txt`,
      bytes: Buffer.from(id),
    });
    result = { ok: true, path: stored.path };
  } catch (error) {
    result = {
      ok: false,
      status: error && typeof error === 'object' && 'status' in error ? error.status : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  coordWrite(coord(`result-${id}.json`), JSON.stringify(result), { flag: 'wx' });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
