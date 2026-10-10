export declare const BASELINE_TITLES: {
  readonly fast: readonly string[];
  readonly heavy: readonly string[];
  readonly r7: readonly string[];
  readonly r8: readonly string[];
};
export declare function isBehavioralAssertion(message: string): boolean;
export declare function assertPerkinsIntegrationBaseline(leg: string, report: unknown): readonly string[];
