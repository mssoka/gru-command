export declare const EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS: Readonly<{
  server: readonly string[];
  capture: readonly string[];
}>;
export declare function resolveBaselineLeg(leg: string): readonly string[];
export declare function isBehavioralRed(message: unknown): boolean;
export declare function assertKeepaliveBaseline(report: unknown, expected?: readonly string[]): string[];
