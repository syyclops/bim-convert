import type { Config } from "./config";

// ---------------------------------------------------------------------------
// Worker VM lifecycle — uses `az` CLI via Bun.spawn
//
// Both VMs have Azure CLI installed and system-assigned managed identity.
// No @azure/identity SDK needed.
// ---------------------------------------------------------------------------

let lastStartRequestedAt = 0;
const START_DEBOUNCE_MS = 60_000; // Don't re-request start within 60s

async function azExec(args: string[]): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(["az", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { ok: exitCode === 0, output: stdout || stderr };
}

async function azLogin(): Promise<boolean> {
  const { ok, output } = await azExec(["login", "--identity", "--output", "none"]);
  if (!ok) console.error("[vm] az login --identity failed:", output);
  return ok;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the worker VM. Fire-and-forget with --no-wait.
 * Debounced to avoid redundant calls within 60 seconds.
 * If already running, Azure returns success.
 */
export async function startWorkerVm(config: Config): Promise<void> {
  if (config.env === "local") {
    console.log("[vm] startWorkerVm (no-op in local mode)");
    return;
  }

  if (!config.workerVmName || !config.azureResourceGroup) {
    console.warn("[vm] Worker VM name or resource group not configured, skipping start");
    return;
  }

  const now = Date.now();
  if (now - lastStartRequestedAt < START_DEBOUNCE_MS) {
    console.log("[vm] startWorkerVm debounced, skipping");
    return;
  }
  lastStartRequestedAt = now;

  console.log(`[vm] Starting worker VM: ${config.workerVmName}`);
  if (!(await azLogin())) return;

  const { ok, output } = await azExec([
    "vm", "start",
    "--resource-group", config.azureResourceGroup,
    "--name", config.workerVmName,
    "--no-wait",
  ]);
  if (!ok) console.error("[vm] Failed to start worker VM:", output);
}

/**
 * Deallocate this VM (worker calls this on itself after idle timeout).
 * Does a final queue peek first to avoid race conditions.
 */
export async function deallocateSelf(config: Config): Promise<void> {
  if (config.env === "local") {
    console.log("[vm] deallocateSelf (no-op in local mode)");
    return;
  }

  if (!config.workerVmName || !config.azureResourceGroup) {
    console.warn("[vm] Worker VM name or resource group not configured, skipping deallocate");
    return;
  }

  console.log(`[vm] Deallocating self: ${config.workerVmName}`);
  if (!(await azLogin())) return;

  const { ok, output } = await azExec([
    "vm", "deallocate",
    "--resource-group", config.azureResourceGroup,
    "--name", config.workerVmName,
    "--no-wait",
  ]);
  if (!ok) console.error("[vm] Failed to deallocate:", output);
}

/** Get the power state of the worker VM. Returns e.g. "running", "deallocated", "starting". */
export async function getVmPowerState(config: Config): Promise<string> {
  if (config.env === "local") return "local";

  if (!config.workerVmName || !config.azureResourceGroup) return "unknown";

  if (!(await azLogin())) return "unknown";

  const { ok, output } = await azExec([
    "vm", "get-instance-view",
    "--resource-group", config.azureResourceGroup,
    "--name", config.workerVmName,
    "--query", "instanceView.statuses[?starts_with(code, 'PowerState/')].displayStatus | [0]",
    "--output", "tsv",
  ]);

  if (!ok) return "unknown";
  return output.trim().toLowerCase().replace("vm ", "") || "unknown";
}
