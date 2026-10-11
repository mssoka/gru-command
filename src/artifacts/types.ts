/** Identity of the verified, immutable workflow selected by the caller. */
export interface ArtifactWorkflow {
  readonly id: string;
  readonly sha256: string;
}
