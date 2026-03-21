/**
 * Dev orchestrator — starts Azurite, server, and worker with color-coded output.
 * Usage: bun run dev/dev.ts
 */

import { type Subprocess } from "bun";

const AZURITE_DATA = "dev/azurite-data";
const AZURITE_BLOB_PORT = 10000;
const COLORS = {
  azurite: "\x1b[36m", // cyan
  server: "\x1b[32m",  // green
  worker: "\x1b[33m",  // yellow
  reset: "\x1b[0m",
};

const children: Subprocess[] = [];

function spawn(
  label: keyof typeof COLORS,
  cmd: string[],
  env?: Record<string, string>,
): Subprocess {
  const color = COLORS[label];
  const prefix = `${color}[${label}]${COLORS.reset}`;

  const proc = Bun.spawn(cmd, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Pipe stdout with prefix
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          console.log(`${prefix} ${line}`);
        }
      }
      if (buffer) console.log(`${prefix} ${buffer}`);
    } catch {}
  })();

  // Pipe stderr with prefix
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          console.error(`${prefix} ${line}`);
        }
      }
      if (buffer) console.error(`${prefix} ${buffer}`);
    } catch {}
  })();

  children.push(proc);
  return proc;
}

async function waitForAzurite(maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(`http://127.0.0.1:${AZURITE_BLOB_PORT}/`);
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
  throw new Error("Azurite did not start in time");
}

async function runSetup(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "dev/setup.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error("Setup failed");
}

function cleanup() {
  console.log("\nShutting down...");
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// Main
async function main() {
  console.log("Starting dev environment...\n");

  // 1. Start Azurite
  spawn("azurite", [
    "npx", "azurite",
    "--silent",
    "--location", AZURITE_DATA,
    "--loose",
    "--skipApiVersionCheck",
  ]);

  // 2. Wait for Azurite to be reachable
  console.log("Waiting for Azurite...");
  await waitForAzurite();
  console.log("Azurite is ready.\n");

  // 3. Create containers and queues
  await runSetup();
  console.log("");

  // 4. Start server and worker
  spawn("server", ["bun", "--watch", "server.ts"]);
  spawn("worker", ["bun", "--watch", "worker.ts"]);

  console.log(`\n${COLORS.server}Server${COLORS.reset}: http://localhost:8000`);
  console.log(`Press Ctrl+C to stop all processes.\n`);

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Dev orchestrator failed:", err.message);
  cleanup();
});
