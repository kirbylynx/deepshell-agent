export type RuntimePhase =
  | "starting"
  | "ready"
  | "recovering"
  | "startup_failed"
  | "runtime_failed";

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  status: string;
  sidecarPid: number | null;
  authority: string | null;
  tokenState: string;
  errorCode: string | null;
}

export function initialRuntimeSnapshot(): RuntimeSnapshot {
  return {
    phase: "starting",
    status: "准备启动中…",
    sidecarPid: null,
    authority: null,
    tokenState: "unavailable",
    errorCode: null
  };
}

export function isFailurePhase(phase: RuntimePhase): boolean {
  return phase === "startup_failed" || phase === "runtime_failed";
}
