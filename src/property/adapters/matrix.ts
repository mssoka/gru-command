import type { AdapterSupport, PropertyAdapter } from '../types.js';
import { VITEST_FAST_CHECK_ADAPTER } from './vitest-fast-check.js';

/**
 * GH350 shipped adapter support matrix (issue §2): every row is an honest
 * capability statement. `shipped` rows are backed by deterministic fixture
 * tests in this repository; candidate ecosystems stay explicit
 * `unsupported` rows — the matrix never asserts that an ecosystem works
 * just because a manifest hinted at it. `docs/PROPERTY-CONTRACTS.md` is the
 * rendered form of this table; keep the two in sync.
 */
export const ADAPTER_SUPPORT_MATRIX: readonly AdapterSupport[] = Object.freeze([
  VITEST_FAST_CHECK_ADAPTER.support,
  {
    adapterId: 'hypothesis-pytest',
    ecosystem: 'python',
    framework: 'Hypothesis',
    runner: 'pytest',
    testedVersionRange: 'none',
    status: 'unsupported',
    capabilities: {
      scalarGeneration: true,
      statefulSequences: true,
      controlledInterleavings: false,
      shrinking: true,
      replayBySeed: true,
    },
    notes:
      'Candidate only (issue §2). No adapter is shipped: resolution reports unsupported-ecosystem naming this row rather than guessing syntax or installing anything.',
  },
  {
    adapterId: 'proptest-cargo',
    ecosystem: 'rust',
    framework: 'proptest',
    runner: 'cargo test',
    testedVersionRange: 'none',
    status: 'unsupported',
    capabilities: {
      scalarGeneration: true,
      statefulSequences: true,
      controlledInterleavings: false,
      shrinking: true,
      replayBySeed: true,
    },
    notes:
      'Candidate only (issue §2). Shipped as an explicit unsupported row; cargo workspaces are discovered for attribution but never executed.',
  },
  {
    adapterId: 'go-native-fuzz',
    ecosystem: 'go',
    framework: 'native fuzzing',
    runner: 'go test',
    testedVersionRange: 'none',
    status: 'unsupported',
    capabilities: {
      scalarGeneration: true,
      statefulSequences: false,
      controlledInterleavings: false,
      shrinking: false,
      replayBySeed: true,
    },
    notes:
      'Candidate only (issue §2). go.mod manifests are discovered; no Go adapter is shipped.',
  },
  {
    adapterId: 'streamdata-mix',
    ecosystem: 'elixir',
    framework: 'StreamData',
    runner: 'mix test',
    testedVersionRange: 'none',
    status: 'unsupported',
    capabilities: {
      scalarGeneration: true,
      statefulSequences: true,
      controlledInterleavings: false,
      shrinking: true,
      replayBySeed: true,
    },
    notes: 'Candidate only (issue §2); mix.exs manifests are discovered, nothing shipped.',
  },
  {
    adapterId: 'gleam-testing',
    ecosystem: 'gleam',
    framework: 'Gleam testing',
    runner: 'gleam test',
    testedVersionRange: 'none',
    status: 'unsupported',
    capabilities: {
      scalarGeneration: false,
      statefulSequences: false,
      controlledInterleavings: false,
      shrinking: false,
      replayBySeed: false,
    },
    notes: 'Candidate only (issue §2); gleam.toml manifests are discovered, nothing shipped.',
  },
]);

/** Registered adapter implementations (shipped rows only). */
export const PROPERTY_ADAPTERS: readonly PropertyAdapter[] = Object.freeze([VITEST_FAST_CHECK_ADAPTER]);

export function adapterById(adapterId: string): PropertyAdapter | null {
  return PROPERTY_ADAPTERS.find((adapter) => adapter.support.adapterId === adapterId) ?? null;
}

export function matrixRowFor(ecosystem: string): AdapterSupport | null {
  return (
    ADAPTER_SUPPORT_MATRIX.find((row) => row.ecosystem === ecosystem) ?? null
  );
}
