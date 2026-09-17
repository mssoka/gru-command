/**
 * Type surface of test/helpers/real-service.mjs for TS test imports
 * (NodeNext resolution pairs the .mjs with this adjacent .d.mts).
 */

export declare const REAL_SERVICE_PORT: number;
export declare const REAL_SERVICE_TOKEN: string;

export declare function pickFreePort(): Promise<number>;

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
}): Promise<RealServiceHandle>;
