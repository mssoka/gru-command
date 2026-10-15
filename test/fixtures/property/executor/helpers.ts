import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PropertyExecutionPlan } from '../../../../src/property/types.js';

/** Fake runners are OS-mechanism unit controls, never real Vitest proof. */
export function scenarioRepo(script: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'property-unit-')));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), script);
  symlinkSync('../vitest/vitest.mjs', join(root, 'node_modules', '.bin', 'vitest'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'test', 'placeholder'), 'tracked\n');
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'unit control']);
  const plan: PropertyExecutionPlan = {
    adapterId: 'vitest-fast-check', command: join(root, 'node_modules', 'vitest', 'vitest.mjs'),
    args: ['run', '--reporter=json', 'test/contract.test.ts'], cwd: root,
    envAllowlist: ['PATH', 'CI', 'TZ'], executable: true, refusalReason: null,
    budget: { maxIterations: 20, maxShrinkSteps: 100, runTimeoutMs: 10_000, maxOutputBytes: 32_768 },
  };
  return { root, git, plan, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
/** A fake runner reports through the host's authenticated channel the way
 * the host config's reporter does (#378): the per-run nonce arrives on fd 3
 * and the report is printed between nonce frames. Block-safe (no import). */
export const REPORT_FRAME = `const __fs=process.getBuiltinModule('node:fs');let __nonce='';try{__nonce=__fs.readFileSync(3,'utf8').trim();__fs.closeSync(3);}catch{}const __report=(r)=>process.stdout.write('\\n'+__nonce+':BEGIN\\n'+JSON.stringify(r)+'\\n'+__nonce+':END\\n');`;
export const PASS_RUNNER = `${REPORT_FRAME}const name=process.cwd()+'/test/contract.test.ts';
__report(({numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,success:true,testResults:[{name,status:'passed',message:'',assertionResults:[{status:'passed',fullName:'contract',failureMessages:[]}]}]}));`;
export const FAILURE_RUNNER = `${REPORT_FRAME}const seed=process.env.GRU_PROPERTY_SEED ?? '42';
const failure='Property failed after 1 tests\\n{ seed: '+seed+', path: "0:1", endOnFailure: true }\\nCounterexample: [1]\\nShrunk 1 time(s)';
__report(({numTotalTests:1,numPassedTests:0,numFailedTests:1,numPendingTests:0,numTodoTests:0,success:false,testResults:[{name:process.cwd()+'/test/contract.test.ts',status:'failed',message:'',assertionResults:[{status:'failed',fullName:'contract',failureMessages:[failure]}]}]}));process.exitCode=1;`;
