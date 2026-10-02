/**
 * Type surface of test/helpers/harness-diagnostics.mjs for TS consumers
 * (NodeNext resolution pairs the .mjs with this adjacent .d.mts).
 */
import type { ChildProcess } from 'node:child_process';

export interface FixtureStep {
  readonly label: string;
  readonly completedAt: number;
}

export interface TrackedProcess {
  readonly child: ChildProcess;
  readonly pid: number | null;
  readonly label: string;
  readonly startedAt: number;
  exitedAt: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | null;
  output: { stdout: string; stderr: string };
  outputTruncated: boolean;
}

export interface DiagnosticsScope {
  readonly file: string;
  readonly name: string;
  readonly startedAt: number;
  readonly clock: () => number;
  readonly steps: FixtureStep[];
  readonly processes: TrackedProcess[];
}

export declare class FixtureStepTimeoutError extends Error {
  readonly stepLabel: string;
  readonly deadlineMs: number;
  diagnostics: string;
}

export declare function createTestScope(input: {
  file: string;
  name: string;
  now?: () => number;
}): DiagnosticsScope;

/** Returns the displaced scope (if one was active). */
export declare function activateTestScope(scope: DiagnosticsScope): DiagnosticsScope | null;
export declare function currentTestScope(): DiagnosticsScope | null;
export declare function deactivateTestScope(scope: DiagnosticsScope): void;

export declare function markFixtureStep(label: string, scope?: DiagnosticsScope | null): void;

export declare function trackChildProcess(
  child: ChildProcess,
  options?: { label?: string; captureOutput?: boolean; scope?: DiagnosticsScope | null },
): TrackedProcess | null;

export declare function redactDiagnosticText(text: string): string;
export declare function isTimeoutError(error: unknown): boolean;

export declare function renderFailureDiagnostics(
  scope: DiagnosticsScope | null,
  error: unknown,
  options?: { timedOut?: boolean },
): string;

export declare function disposeScopeProcesses(
  scope: DiagnosticsScope | null,
  options?: { graceMs?: number; killGraceMs?: number },
): Promise<Array<{ label: string; pid: number | null; disposition: string }>>;

export declare function runBoundedFixtureStep<T>(
  label: string,
  fn: () => T | Promise<T>,
  options?: { deadlineMs?: number; scope?: DiagnosticsScope | null },
): Promise<T>;
