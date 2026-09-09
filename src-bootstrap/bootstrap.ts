import { invoke } from "@tauri-apps/api/core";
import type { RuntimeSnapshot } from "./runtime-state";

const statusNode = document.querySelector<HTMLParagraphElement>("#status");
const phaseNode = document.querySelector<HTMLElement>("#runtime-phase");
const pidNode = document.querySelector<HTMLElement>("#sidecar-pid");
const authorityNode = document.querySelector<HTMLElement>("#authority");
const tokenNode = document.querySelector<HTMLElement>("#token-state");
const errorCodeNode = document.querySelector<HTMLElement>("#error-code");

function render(snapshot: RuntimeSnapshot) {
  if (statusNode) statusNode.textContent = snapshot.status;
  if (phaseNode) phaseNode.textContent = snapshot.phase;
  if (pidNode) pidNode.textContent = snapshot.sidecarPid ? String(snapshot.sidecarPid) : "-";
  if (authorityNode) authorityNode.textContent = snapshot.authority ?? "-";
  if (tokenNode) tokenNode.textContent = snapshot.tokenState;
  if (errorCodeNode) errorCodeNode.textContent = snapshot.errorCode ?? "-";
  document.body.dataset.phase = snapshot.phase;
}

async function refresh() {
  try {
    const snapshot = await invoke<RuntimeSnapshot>("runtime_status");
    render(snapshot);
  } catch {
    if (statusNode) statusNode.textContent = "无法读取 Runtime 状态";
  }
}

async function runAction(command: string) {
  try {
    await invoke(command);
  } catch (error) {
    if (statusNode) statusNode.textContent = String(error);
  }
  await refresh();
}

async function wireActions() {
  document.querySelector("#restart")?.addEventListener("click", async () => {
    await runAction("restart_runtime");
  });

  document.querySelector("#logs")?.addEventListener("click", async () => {
    await runAction("open_logs_directory");
  });

  document.querySelector("#quit")?.addEventListener("click", async () => {
    await runAction("quit_app");
  });
}

await wireActions();
await refresh();
setInterval(() => {
  void refresh();
}, 1500);
