import { describe, expect, it } from "vitest";
import { initialRuntimeSnapshot, isFailurePhase } from "../../src-bootstrap/runtime-state";

describe("runtime state", () => {
  it("creates the expected initial snapshot", () => {
    expect(initialRuntimeSnapshot()).toEqual({
      phase: "starting",
      status: "准备启动中…",
      sidecarPid: null,
      authority: null,
      tokenState: "unavailable",
      errorCode: null
    });
  });

  it("recognizes failure phases", () => {
    expect(isFailurePhase("startup_failed")).toBe(true);
    expect(isFailurePhase("runtime_failed")).toBe(true);
    expect(isFailurePhase("ready")).toBe(false);
  });
});
