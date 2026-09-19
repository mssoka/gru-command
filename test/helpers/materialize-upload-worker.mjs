import { Buffer } from 'node:buffer';
import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { materializeUpload } from '../../src/attachments/resolver.ts';

const [uploadsDir, readyFile, barrierFile, resultFile, filename, content] = process.argv.slice(2);
if (!uploadsDir || !readyFile || !barrierFile || !resultFile || !filename || content === undefined) {
  throw new Error('materialize-upload-worker: missing argument');
}

writeFileSync(readyFile, String(process.pid), { flag: 'wx' });
const sleeper = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(barrierFile)) Atomics.wait(sleeper, 0, 0, 5);

let result;
try {
  const stored = materializeUpload(uploadsDir, {
    filename,
    bytes: Buffer.from(content),
  });
  result = { ok: true, path: stored.path };
} catch (error) {
  result = {
    ok: false,
    status: typeof error === 'object' && error !== null && 'status' in error ? error.status : null,
    message: error instanceof Error ? error.message : String(error),
  };
}
writeFileSync(resultFile, JSON.stringify(result), { flag: 'wx' });
