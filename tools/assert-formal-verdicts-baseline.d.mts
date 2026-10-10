export declare const EXPECTED_FORMAL_EVENT_ASSERTIONS: Readonly<{
  app: readonly string[];
  wave: readonly string[];
}>;
export declare function assertFormalVerdictsBaselineLeg(
  label: string,
  report: unknown,
  requiredTitles: readonly string[],
): string;
