import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_INSTANCE_PORT, SERVICE_PORT_ENV } from './config.js';

/**
 * Worktree listen-port guard (owner incident 2026-09-23, port-squat
 * prevention): a service spawned from a git worktree is a TEST service and
 * must never bind the instance port. On macOS a specific bind (127.0.0.1)
 * and a wildcard bind (0.0.0.0) CAN coexist, so a worktree-spawned service
 * answering loopback turns the real instance's loopback surface into a
 * `503 not_configured` squatter for hours while the LAN address looks fine.
 *
 * The rule enforced here, before any socket binds:
 *   - port 0 (ephemeral) is always allowed;
 *   - a fixed port is allowed only when the spawner handed it in
 *     explicitly through `GRU_SERVICE_PORT` (the test/e2e harness override,
 *     applied by loadConfig) — and it is never the instance port;
 *   - everything else refuses loud, naming the port, the worktree, and the
 *     fix.
 *
 * Context detection is two-pronged: an explicit `GRU_COMMAND_WORKTREE_CONTEXT`
 * marker (spawners/tests declare it) OR the checkout root being a linked
 * git worktree (`.git` is a pointer FILE, unlike the main checkout's `.git`
 * directory). The marker also makes the guard testable from a plain clone.
 */

/** Spawner/test marker: force the worktree context on (`1`) or off (`0`). */
export const WORKTREE_CONTEXT_ENV = 'GRU_COMMAND_WORKTREE_CONTEXT';

/** A listen that the guard refuses — never a silent fallback. */
export class WorktreePortSquatRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreePortSquatRefused';
  }
}

/** True when `root` is a linked git worktree (its `.git` is a FILE). */
export function isLinkedWorktree(root: string): boolean {
  try {
    return lstatSync(join(root, '.git')).isFile();
  } catch {
    return false;
  }
}

/** Is this process a worktree-spawned (test) service? */
export function inWorktreeContext(input: {
  readonly checkoutRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  const marker = env[WORKTREE_CONTEXT_ENV];
  if (marker === '1') return true;
  if (marker === '0') return false;
  return isLinkedWorktree(input.checkoutRoot);
}

export interface WorktreeListenPortInput {
  /** The checkout containing this dist (`defaultPackageRoot()`). */
  readonly checkoutRoot: string;
  /** The effective `[server] port` (GRU_SERVICE_PORT already applied). */
  readonly port: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Overridable for tests/docs; defaults to the documented instance port. */
  readonly instancePort?: number;
  /** Test seam: force the context instead of detecting it. */
  readonly worktreeContext?: boolean;
}

/** Throws {@link WorktreePortSquatRefused} when a worktree-spawned service
 * asks to bind a port that could squat the instance. A no-op outside a
 * worktree context and for ephemeral binds. */
export function assertWorktreeListenPort(input: WorktreeListenPortInput): void {
  const env = input.env ?? process.env;
  const inWorktree = input.worktreeContext ?? inWorktreeContext({ checkoutRoot: input.checkoutRoot, env });
  if (!inWorktree) return;
  const instancePort = input.instancePort ?? DEFAULT_INSTANCE_PORT;
  const port = input.port;
  if (port === 0) return; // ephemeral: the OS hands a unique free port
  const explicitEnvPort = env[SERVICE_PORT_ENV] !== undefined && Number(env[SERVICE_PORT_ENV]) === port;
  if (port === instancePort) {
    throw new WorktreePortSquatRefused(
      `refusing to bind instance port ${instancePort} from a worktree checkout (${input.checkoutRoot}): ` +
        `worktree-spawned services must use an ephemeral port (port = 0) or ${SERVICE_PORT_ENV}=<high port>`,
    );
  }
  if (!explicitEnvPort) {
    throw new WorktreePortSquatRefused(
      `refusing fixed port ${port} from a worktree checkout (${input.checkoutRoot}): the port came from ` +
        `configuration, not an explicit override — use port = 0 or ${SERVICE_PORT_ENV}=<high port>`,
    );
  }
  if (port < 1024) {
    throw new WorktreePortSquatRefused(
      `refusing privileged port ${port} from a worktree checkout (${input.checkoutRoot}) via ` +
        `${SERVICE_PORT_ENV} — use a high port`,
    );
  }
}
