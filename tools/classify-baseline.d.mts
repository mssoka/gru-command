export interface BaselineClassification {
  /** 1 = RED classified, 2 = fails-before broken, 3 = setup/collection failure. */
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export declare function classifyBaseline(
  report: unknown,
  options?: {
    readonly playwright?: boolean;
    readonly requireFile?: string | null;
    readonly substrs?: readonly string[];
    /** Required feature-absence causes for the named instrument (a setup
     * AssertionError must not be accepted as feature absence). */
    readonly requireFileSubstrs?: readonly string[];
  },
): BaselineClassification;
