/**
 * Test runner — starts Azurite, runs bun test, then kills Azurite.
 * Usage: bun run tests/run.ts [-- ...bun test args]
 */

import { mkdirSync } from "fs";

const args = process.argv.slice(2);

async function isAzuriteRunning(): Promise<boolean> {
  try {
    await fetch("http://127.0.0.1:10000/");
    return true;
  } catch {
    return false;
  }
}

// Check if Azurite is already running externally (e.g. via `bun run dev`)
const externalAzurite = await isAzuriteRunning();

let azuriteProc: ReturnType<typeof Bun.spawn> | null = null;

if (!externalAzurite) {
  mkdirSync("dev/azurite-data", { recursive: true });
  azuriteProc = Bun.spawn(
    ["npx", "azurite", "--silent", "--location", "dev/azurite-data", "--loose", "--skipApiVersionCheck"],
    { stdout: "ignore", stderr: "ignore" },
  );

  // Wait for Azurite
  for (let i = 0; i < 40; i++) {
    if (await isAzuriteRunning()) break;
    await Bun.sleep(250);
  }

  if (!(await isAzuriteRunning())) {
    console.error("Azurite failed to start.");
    azuriteProc.kill();
    process.exit(1);
  }
}

// Run tests
const testProc = Bun.spawn(["bun", "test", ...args], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

const exitCode = await testProc.exited;

// Kill Azurite if we started it
if (azuriteProc) {
  azuriteProc.kill();
}

process.exit(exitCode);
