/**
 * GH350 language-neutral property-contract contract (shared, seam-spanning).
 *
 * Ownership: this file is the FROZEN shared contract written by the pA
 * integration owner BEFORE executor/qualification lanes start. Lanes code
 * against these shapes; changes route through the integration owner and a
 * re-freeze commit, never a silent lane-side edit.
 *
 * Honesty rules carried in the types themselves:
 * - Raw receipts preserve direct exit/signal/timeout verbatim.
 * - Interpreted outcomes are runner-report classifications, never qualified
 *   product proof; qualification is a separate seam-C verdict.
 * - Tooling states are an ordered ladder; a lockfile proves locked
 *   dependencies only, never installed or runnable tooling.
 * - Zero selected and zero EXECUTED are distinct and neither is PASS.
 */

/** The exact outcome vocabulary (issue §7). `not-run` covers typed refusals
 * (sandbox unavailable, mode disabled) that never executed anything. */
export type PropertyOutcomeKind =
  | 'pass'
  | 'property-failure'
  | 'build-failure'
  | 'collection-failure'
  | 'selection-failure'
  | 'infrastructure-error'
  | 'timeout'
  | 'inconclusive'
  | 'unsupported'
  | 'not-run';

/** Host-captured raw execution facts, preserved verbatim on every outcome. */
export interface RawExecutionReceipt {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** What an interpretation is allowed to claim — by construction it can never
 * carry contract or product proof; qualification (seam C) owns that. */
export const INTERPRETATION_EVIDENCE_CLASS = 'runner-report-classification' as const;

/** One failing assertion inside the plan's selection. */
export interface PropertyFailureRecord {
  readonly testIdentity: string;
  readonly messageExcerpt: string;
  readonly seed: string | null;
}

/** A failure the runner reported OUTSIDE the plan's selection: disclosed,
 * never promoted to the contract's failure, never dropped. */
export interface UnselectedFailureRecord {
  readonly testIdentity: string;
  readonly messageExcerpt: string;
}

/** Adapter interpretation of one raw receipt against one execution plan. */
export interface PropertyRunOutcome {
  readonly kind: PropertyOutcomeKind;
  readonly evidenceClass: typeof INTERPRETATION_EVIDENCE_CLASS;
  readonly selected: number;
  readonly executed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly passed: number;
  readonly failures: readonly PropertyFailureRecord[];
  readonly unselectedFailures: readonly UnselectedFailureRecord[];
  readonly reasons: readonly string[];
  readonly matchedDiagnostic: string | null;
  readonly receipt: RawExecutionReceipt;
}

/** Ordered tooling ladder. `absent` = no evidence at all. */
export type ToolingState = 'absent' | 'declared' | 'locked' | 'installed' | 'runnable';

/** The runner must be `runnable` and every required library `installed`
 * before a resolution row may claim executable capability. */
export interface ToolingLadder {
  readonly runner: ToolingState;
  readonly libraries: Readonly<Record<string, ToolingState>>;
  readonly executable: boolean;
  readonly reasons: readonly string[];
}

export type PackageResolutionStatus =
  | 'resolved'
  | 'ambiguous'
  | 'missing-dependency'
  | 'unsupported-ecosystem'
  | 'no-tooling'
  | 'invalid-manifest';

/** What resolution read to reach its verdict (paths repo-relative). */
export interface ManifestEvidenceEntry {
  readonly path: string;
  readonly role: 'manifest' | 'lockfile' | 'config' | 'test-config' | 'installed-module';
  readonly sha256: string;
}

export interface PackageResolution {
  readonly packageDir: string;
  readonly ecosystem: string | null;
  readonly status: PackageResolutionStatus;
  readonly adapterId: string | null;
  readonly tooling: ToolingLadder | null;
  readonly reasons: readonly string[];
  readonly evidence: readonly ManifestEvidenceEntry[];
  /** sha256 over contributing file identities; changes on any byte change. */
  readonly resolutionKey: string;
}

export interface PropertyCapabilityReport {
  readonly repoRoot: string;
  readonly packages: readonly PackageResolution[];
  readonly scoped: boolean;
}

/** What an adapter can honestly do (issue §5 capability flags). */
export interface PropertyCapabilityFlags {
  readonly scalarGeneration: boolean;
  readonly statefulSequences: boolean;
  readonly controlledInterleavings: boolean;
  readonly shrinking: boolean;
  readonly replayBySeed: boolean;
}

export interface AdapterSupport {
  readonly adapterId: string;
  readonly ecosystem: string;
  readonly framework: string;
  readonly runner: string;
  readonly testedVersionRange: string;
  /** `shipped` rows are backed by deterministic fixture tests; every other
   * candidate ecosystem stays an explicit `unsupported` matrix row. */
  readonly status: 'shipped' | 'unsupported';
  readonly capabilities: PropertyCapabilityFlags;
  readonly notes: string;
}

/** One repo/package detection context handed to an adapter. */
export interface PropertyDetectionContext {
  readonly repoRoot: string;
  readonly packageDir: string;
  readonly manifest: Readonly<Record<string, unknown>> | null;
  readonly lockfiles: readonly { readonly path: string; readonly text: string }[];
  readonly approvedCommands: Readonly<Record<string, string>>;
}

export interface PropertyDetectionResult {
  readonly compatible: boolean;
  readonly reasons: readonly string[];
  readonly versions: Readonly<Record<string, string>>;
}

/** Where a generated property test file is placed and how it is selected. */
export interface PropertyTestPlacement {
  readonly filePath: string;
  readonly selectionFilter: string;
  readonly rationale: string;
}

/** Host-executable plan: adapter names the installed binary and arguments;
 * the ADAPTER NEVER SPAWNS — the host executor owns spawning under policy. */
export interface PropertyExecutionPlan {
  readonly adapterId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly envAllowlist: readonly string[];
  readonly budget: ExecutionBudget;
  readonly executable: boolean;
  readonly refusalReason: string | null;
}

/** Approved execution bounds; never silently raised after failures. */
export interface ExecutionBudget {
  readonly maxIterations: number;
  readonly maxShrinkSteps: number;
  readonly runTimeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface PropertyAdapter {
  readonly support: AdapterSupport;
  detect(context: PropertyDetectionContext): PropertyDetectionResult;
  planPlacement(context: PropertyDetectionContext, slug: string): PropertyTestPlacement;
  buildExecutionPlan(context: PropertyDetectionContext, placement: PropertyTestPlacement): PropertyExecutionPlan;
  interpretExecution(raw: RawExecutionReceipt, plan: PropertyExecutionPlan): PropertyRunOutcome;
}

// ---------------------------------------------------------------------------
// Seam B contracts: restricted execution, overlay identity, receipts, replay.
// ---------------------------------------------------------------------------

/** Enforcement, not assertion: the executor either runs under a real OS
 * backend or refuses with `not-run`/`unsupported` naming the gap. */
export type SandboxBackend = 'macos-sandbox-exec' | 'none-found';

export interface SandboxEnforcement {
  readonly backend: SandboxBackend;
  readonly profileSummary: string;
  readonly networkDenied: boolean;
  readonly filesystemIsolated: boolean;
  readonly credentialsStripped: boolean;
  readonly refusalReason: string | null;
}

/** Explicit overlay identity (issue §7 integration constraint): the overlay
 * is represented in evidence; the source SHA alone never identifies the
 * tested bytes, and clean-tree semantics elsewhere are untouched. */
export interface OverlayFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface OverlayIdentity {
  readonly files: readonly OverlayFile[];
  readonly overlaySha256: string;
}

/** Everything a receipt binds so later changes invalidate it (issue §7). */
export interface ExecutionIdentity {
  readonly sourceSha: string;
  readonly treeDirty: boolean;
  readonly overlay: OverlayIdentity | null;
  readonly configSha256: string | null;
  readonly adapterProfile: string;
  readonly toolVersions: Readonly<Record<string, string>>;
}

export interface OutputArtefactRef {
  readonly kind: 'stdout' | 'stderr';
  readonly bytes: number;
  readonly sha256: string;
}

/** Replay data retained with every retained counterexample (issue §7). */
export interface ReplayData {
  readonly seed: string | null;
  readonly shrinkPath: readonly string[];
  readonly schedule: string | null;
  readonly environmentProfile: string;
  readonly replaySupported: boolean;
  readonly replayDisclosure: string | null;
}

/** Host-owned execution receipt — the ONLY evidence that tests ran. */
export interface PropertyExecutionReceipt {
  readonly identity: ExecutionIdentity;
  readonly command: string;
  readonly cwd: string;
  readonly outcome: PropertyRunOutcome;
  readonly outputs: readonly OutputArtefactRef[];
  readonly sandbox: SandboxEnforcement;
  readonly replay: ReplayData | null;
  readonly budget: ExecutionBudget;
}

declare const EXECUTOR_SEAL: unique symbol;

/** RUNTIME-ENFORCED provenance (Root planning-record correction, 2026-10-14):
 * only the host executor module may construct a sealed receipt — the seal
 * token is a module-closure symbol that is never exported, and every
 * PRODUCTION consumer (qualification, freeze, metrics, Perkins wiring)
 * must verify receipts through the executor-exported runtime guard. A
 * TypeScript brand alone is not unforgeable provenance: callers cannot
 * construct this type without the symbol, and the runtime guard rejects
 * any object that was not produced through the executor closure. */
export interface SealedExecutionReceipt extends PropertyExecutionReceipt {
  readonly [EXECUTOR_SEAL]: true;
}

/** The runtime guard the executor exports and every production consumer
 * calls before trusting a receipt: `(candidate) => candidate is
 * SealedExecutionReceipt`. */
export type ExecutionReceiptGuard = (candidate: unknown) => candidate is SealedExecutionReceipt;

// ---------------------------------------------------------------------------
// Seam C contracts: proposals, qualification, freeze, modes, metrics.
// ---------------------------------------------------------------------------

/** Requirement-grounded reviewer proposal — UNTRUSTED input, never evidence. */
export interface PropertyProposal {
  readonly requirementRef: string;
  readonly invariant: string;
  readonly inputDomain: string;
  readonly invalidInputBehavior: string;
  readonly targetPackageDir: string;
  readonly adapterId: string;
  readonly testArtifactRefs: readonly { readonly path: string; readonly sha256: string }[];
  readonly establishes: string;
  readonly doesNotEstablish: string;
}

export type QualificationVerdict =
  | 'qualified'
  | 'rejected-vacuous'
  | 'rejected-contradictory'
  | 'rejected-inconclusive'
  | 'escalated';

export interface QualificationControlResult {
  readonly satisfied: boolean;
  readonly detail: string;
}

/** Frozen repair inputs (issue §4): tamper with the oracle ⇒ requalify. */
export interface FrozenContract {
  readonly proposal: PropertyProposal;
  readonly frozenOverlay: OverlayIdentity;
  readonly knownBadControl: QualificationControlResult;
  readonly healthyControl: QualificationControlResult;
  readonly baselineAttribution: 'candidate-only' | 'baseline-also-fails' | 'unattributed';
  readonly frozenAtSha256: string;
}

export interface QualificationRecord {
  readonly verdict: QualificationVerdict;
  readonly reasons: readonly string[];
  readonly frozen: FrozenContract | null;
}

/** Repo-level staged rollout modes (issue §9). */
export type PropertyMode = 'disabled' | 'observation' | 'enforced';

/** Effectiveness metrics (issue §9) — counts that cannot be gamed by
 * generating more cases. */
export interface PropertyMetricsSnapshot {
  readonly actionableDefects: number;
  readonly invalidOracles: number;
  readonly replayReliability: { readonly replayed: number; readonly reproduced: number };
  readonly escapedRegressions: number;
  readonly executedRuns: number;
  readonly totalExecutionMs: number;
  readonly totalTokenCost: number | null;
}
