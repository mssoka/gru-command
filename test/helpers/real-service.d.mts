/**
 * Type surface of test/helpers/real-service.mjs for TS test imports
 * (NodeNext resolution pairs the .mjs with this adjacent .d.mts).
 */

export declare const REAL_SERVICE_PORT: number;
export declare const REAL_SERVICE_TOKEN: string;
/** The documented instance port (src/config.ts DEFAULT_INSTANCE_PORT). */
export declare const INSTANCE_PORT: number;

/** Refuse a test/e2e service port that is not ephemeral or an explicit
 * high-range override (never the instance port, never privileged). */
export declare function assertSafeTestServicePort(port: number, label?: string): void;

export declare function pickFreePort(): Promise<number>;

/** Extract the bound port from the service's `listening` JSON log line. */
export declare function parseListeningPort(stderrText: string): number | null;

export interface RealServiceHandle {
  /** The real service child process (node dist/main.js). */
  readonly child: import('node:child_process').ChildProcess;
  /** Throwaway GRU_COMMAND_HOME for this boot (survives stop() when
   *  keepHome; removed by stop() when this boot created it). */
  readonly home: string;
  /** The service workspace_root (claude spawns run with this cwd). */
  readonly workspace: string;
  readonly port: number;
  readonly token: string;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export declare function startRealService(options?: {
  port?: number;
  token?: string;
  keepHome?: boolean;
  requireWebDist?: boolean;
  /** Reuse a prior boot's home (durable frame log + session state). */
  home?: string;
  /** Reuse a prior boot's workspace. */
  workspace?: string;
  /** Model ref written to config; unknown metadata declines vision conservatively. */
  model?: string;
  /** Write enabled=true into the hermetic decision configuration. */
  decisionsEnabled?: boolean;
  /** Provision through the compiled stdin-only CLI before service boot. */
  decisionKey?: string;
  /** Offline child preload, e.g. the Jev fetch double. */
  nodeImport?: string;
  /** Additional non-secret test controls for the child process. */
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<RealServiceHandle>;
