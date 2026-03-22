import { join } from "path";
import type { Config } from "./config";

// ---------------------------------------------------------------------------
// Progress parsing
//
// The DDC converter outputs three phases, each with its own 0-100%:
//   1. "Started Loading BimRv file"  → Loading model
//   2. "Started Loading Elements"    → Loading elements
//   3. "Started Export to IFC"       → IFC export (the longest phase)
//
// We map these to weighted ranges of overall progress:
//   Phase 1: 0-15%    (loading is fast)
//   Phase 2: 15-30%   (elements loading is fast)
//   Phase 3: 30-100%  (export is the real work)
// ---------------------------------------------------------------------------

interface PhaseRange {
  start: number;
  end: number;
}

const PHASE_RANGES: PhaseRange[] = [
  { start: 0, end: 15 },   // Phase 1: Loading file
  { start: 15, end: 30 },  // Phase 2: Loading elements
  { start: 30, end: 100 }, // Phase 3: Export to IFC
];

const PHASE_TRIGGERS = [
  /started loading bimrv/i,
  /started loading elements/i,
  /started export to ifc/i,
];

export function parseRawProgress(line: string): number | null {
  const match = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (value >= 0 && value <= 100) return value;
  return null;
}

/** For unit tests — kept as a simple parser */
export function parseProgressLine(line: string): number | null {
  const raw = parseRawProgress(line);
  return raw !== null ? Math.round(raw) : null;
}

/** Stateful progress tracker that maps multi-phase converter output to 0-100 overall. */
export class ProgressTracker {
  private phase = 0;

  processLine(line: string): number | null {
    // Check for phase transitions
    for (let i = 0; i < PHASE_TRIGGERS.length; i++) {
      if (PHASE_TRIGGERS[i].test(line)) {
        this.phase = i;
        return null;
      }
    }

    // Parse progress value
    const raw = parseRawProgress(line);
    if (raw === null) return null;

    // Map phase-local 0-100 to overall range
    const range = PHASE_RANGES[this.phase] ?? PHASE_RANGES[PHASE_RANGES.length - 1];
    const overall = range.start + (raw / 100) * (range.end - range.start);
    return Math.round(Math.min(100, overall));
  }
}

// ---------------------------------------------------------------------------
// Converter execution
// ---------------------------------------------------------------------------

// The DDC converter sometimes doesn't exit after completing. It writes the
// success message but the process hangs open. We detect this and stop waiting.
const COMPLETION_PATTERN = /conversion has been completed/i;

export interface ConversionResult {
  exitCode: number;
  log: string;
}

export async function runConversion(
  config: Config,
  inputPath: string,
  outputPath: string,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
  stallTimeoutMs: number = 300_000,
): Promise<ConversionResult> {
  const cmdParts = config.converterCmd.split(/\s+/);
  const isMock = cmdParts[0] === "bun";

  let cmd: string[];
  let cwd: string;

  if (isMock) {
    // Mock converter: "bun run dev/mock-converter.ts"
    cmd = [...cmdParts, inputPath, outputPath];
    cwd = process.cwd();
  } else {
    // Real converter: "RVT2IFCconverter.exe input output preset=standard"
    cmd = [join(config.converterDir, cmdParts[0]), inputPath, outputPath, "preset=standard"];
    cwd = config.converterDir;
  }

  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Kill process on abort signal (timeout)
  const onAbort = () => proc.kill();
  signal.addEventListener("abort", onAbort, { once: true });

  // Read stdout and stderr CONCURRENTLY to prevent pipe deadlock.
  // If stderr fills the OS pipe buffer (~64KB) while we're reading stdout
  // sequentially, the converter blocks on stderr write and never closes
  // stdout — deadlocking both sides.
  let log = "";
  const tracker = new ProgressTracker();

  // Stderr: collect in background
  const stderrPromise = new Response(proc.stderr).text();

  // Stdout: read line-by-line for progress.
  // Track when we last received output — if the converter goes silent for
  // too long it's almost certainly stuck and we should kill it early rather
  // than making the user wait for the full conversion timeout.
  const stdoutReader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastOutputAt = Date.now();
  let stalled = false;
  let completed = false;

  try {
    while (true) {
      // Race the next chunk against the stall timeout so we don't sit
      // forever on a silent process.
      const remaining = stallTimeoutMs - (Date.now() - lastOutputAt);
      if (remaining <= 0) {
        stalled = true;
        proc.kill();
        break;
      }

      const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      );

      const { done, value } = await Promise.race([
        stdoutReader.read(),
        timeout,
      ]);

      if (done && !value) {
        // Stall timeout fired (our sentinel — real EOF has done=true but
        // comes from the reader, not our timeout)
        stalled = true;
        proc.kill();
        break;
      }
      if (done) break; // Real EOF

      lastOutputAt = Date.now();
      const text = decoder.decode(value, { stream: true });
      log += text;
      buffer += text;

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // The DDC converter sometimes hangs after printing the completion
        // message — the process never exits. Stop reading immediately.
        if (COMPLETION_PATTERN.test(trimmed)) {
          completed = true;
        }

        const progress = tracker.processLine(trimmed);
        if (progress !== null) {
          onProgress(progress);
        }
      }

      if (completed) {
        proc.kill();
        break;
      }
    }
  } catch {
    // stdout read error — process may have been killed
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const progress = tracker.processLine(buffer.trim());
    if (progress !== null) onProgress(progress);
    log += buffer;
  }

  // Collect stderr (already draining concurrently)
  const stderr = await stderrPromise;
  if (stderr) log += "\n--- stderr ---\n" + stderr;

  // Wait for exit
  const exitCode = await proc.exited;
  signal.removeEventListener("abort", onAbort);

  // The converter reported success but the process hung — treat as success.
  // The worker will still verify the output file exists and isn't empty.
  if (completed) {
    return { exitCode: 0, log };
  }

  if (stalled) {
    return { exitCode: 1, log: log + `\n--- STALLED (no output for ${stallTimeoutMs / 1000}s) ---\n` };
  }

  if (signal.aborted) {
    return { exitCode: 1, log: log + "\n--- TIMED OUT ---\n" };
  }

  return { exitCode, log };
}
