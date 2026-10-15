/** Canonical JSON for the versioned historical receipt/decision stale-input
 * fence. Object insertion order is irrelevant; array order remains factual. */
export function canonicalRebriefEvidence(value: unknown): string {
  const ordered = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(ordered);
    if (typeof item !== 'object' || item === null) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, ordered(child)]));
  };
  return JSON.stringify(ordered(value));
}

export interface RebriefReceiptEvidence {
  readonly version: 1;
  readonly sha256: string;
  readonly markers: readonly {
    readonly id: string; readonly jobId: string; readonly kind: string;
    readonly payloadHash: string; readonly baselineSeq: number;
    readonly phaseId: string | null; readonly agentId: string | null;
    readonly sessionFile: string | null; readonly workRevision: number | null;
  }[];
  readonly phase: {
    readonly phaseId: string; readonly jobId: string; readonly source: string;
    readonly requestId: string | null; readonly generation: number;
    readonly intentSeq: number; readonly minionId: string | null;
  } | null;
  readonly receipts: readonly {
    readonly seq: number; readonly kind: string; readonly jobId: string | null;
    readonly agentId: string | null; readonly classification: 'accepted' | 'unproven';
    readonly payload: unknown;
  }[];
}
