export declare class BaselineRecoveryGateError extends Error {
  constructor(message: string);
}
export declare function assertRestartRecoveryBaseline(report: unknown, input: {
  readonly testName: string;
  readonly testFile: string;
  readonly assertionLine: number;
  readonly output: string;
}): string;
