export declare const EXPECTED_BASELINE_ASSERTIONS: Readonly<{
  backend: string;
  web: string;
}>;
export declare function assertBinnedBaselineLeg(
  label: string,
  report: unknown,
  expectedTitle: string,
): string;
