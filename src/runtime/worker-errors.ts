/** Typed eviction handshake (cap-owned): the resident proxy rejects
 * prompt-family calls while a handle is being reclaimed/disposed. Callers
 * match the CLASS, never a message string. Lives in a leaf module so
 * dispatch code can import it without a registry cycle. */
export class WorkerDisposalInProgressError extends Error {
  constructor() {
    super('worker is being disposed');
    this.name = 'WorkerDisposalInProgressError';
  }
}
