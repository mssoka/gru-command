export declare const EXPECTED_FORMAL_EVENT_ASSERTIONS: Readonly<{
  app: readonly string[];
  wave: readonly string[];
}>;
export declare const EXPECTED_FORMAL_EVENT_FAILURE_MARKERS: Readonly<{
  app: readonly string[];
  wave: readonly string[];
}>;
export declare function assertNamedRedBaselineLeg(
  label: string,
  report: unknown,
  requiredTitles: readonly string[],
): string;
export declare function assertFormalVerdictsBaselineLeg(
  label: string,
  report: unknown,
  requiredTitles: readonly string[],
): string;
