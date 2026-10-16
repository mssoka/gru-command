export declare const BASELINE_TITLES: {
  readonly fast: readonly string[];
  readonly heavy: readonly string[];
  readonly r7: readonly string[];
  readonly r8: readonly string[];
  readonly r9: readonly string[];
  readonly r10: readonly string[];
};
export declare function frameLocation(line: string): string | undefined;
export declare function isBehavioralAssertion(message: string): boolean;
/** Why a failure message is no behavioral RED, or null when it is one. */
export declare function behavioralRefusal(message: unknown): string | null;
export declare function assertPerkinsIntegrationBaseline(leg: string, report: unknown): readonly string[];
