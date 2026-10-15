export declare const EXPECTED_ABSENCE_ASSERTIONS: Readonly<{
  backend: readonly string[];
  web: readonly string[];
}>;
export declare function assertRepoOverviewBaselineLeg(
  label: string,
  report: unknown,
  requiredTitles: readonly string[],
): string;
