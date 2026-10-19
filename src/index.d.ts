import type { IncomingMessage, ServerResponse } from "node:http";

/** Gets a signal that aborts when the check times out. */
export type CheckFn = (signal: AbortSignal) => unknown | Promise<unknown>;
export interface CheckSpec {
  check: CheckFn;
  /** Default: the global timeoutMs. */
  timeoutMs?: number;
  /** A failing critical check makes the service "down" (default true); otherwise "degraded". */
  critical?: boolean;
}

export interface CheckResult {
  status: "up" | "down";
  ms: number;
  critical: boolean;
  /** Only with `verbose: true`. */
  error?: string;
}

export interface HealthReport {
  status: "ok" | "degraded" | "down";
  checks: Record<string, CheckResult>;
  at: string;
}

export interface HealthOptions {
  checks?: Record<string, CheckFn | CheckSpec>;
  timeoutMs?: number;
  cacheMs?: number;
  verbose?: boolean;
  now?: () => number;
}

export interface Health {
  run(): Promise<HealthReport>;
  ready(req: IncomingMessage, res: ServerResponse): Promise<void>;
  live(req: IncomingMessage, res: ServerResponse): void;
}

export function createHealth(options?: HealthOptions): Health;
