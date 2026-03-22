import { join, resolve } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";
import { loadConfig } from "./lib/config";
import {
  createBlobServiceClient,
  createQueueClient,
  ensureContainers,
  ensureQueue,
  dequeueJob,
  deleteMessage,
  peekQueue,
  downloadBlobToFile,
  uploadBlob,
} from "./lib/storage";
import { readJob, writeProgress, updateJobStatus } from "./lib/jobs";
import { runConversion } from "./lib/converter";
import { deallocateSelf } from "./lib/vm";

const config = loadConfig();

const blobService = createBlobServiceClient(config.storageConnectionString);
const queueClient = createQueueClient(config.storageConnectionString, config.queueName);

const inputsContainer = blobService.getContainerClient(config.containerInputs);
const outputsContainer = blobService.getContainerClient(config.containerOutputs);
const jobsContainer = blobService.getContainerClient(config.containerJobs);
const logsContainer = blobService.getContainerClient(config.containerLogs);

const TEMP_DIR = resolve("temp");
mkdirSync(TEMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await ensureContainers(blobService, [
  config.containerInputs,
  config.containerOutputs,
  config.containerJobs,
  config.containerLogs,
]);
await ensureQueue(queueClient);

console.log(`[worker] Started. Polling queue "${config.queueName}" every ${config.workerPollIntervalMs}ms`);
console.log(`[worker] Converter: ${config.converterCmd}`);
console.log(`[worker] Idle shutdown: ${config.idleShutdownMs}ms`);

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastActivityAt = Date.now();

while (true) {
  const message = await dequeueJob(queueClient, config.queueVisibilityTimeoutSec);

  if (!message) {
    // No work — check idle timeout
    if (Date.now() - lastActivityAt > config.idleShutdownMs) {
      // Final queue peek to avoid race condition
      const pending = await peekQueue(queueClient);
      if (pending === 0) {
        console.log("[worker] Idle timeout reached, deallocating...");
        await deallocateSelf(config);
        process.exit(0);
      }
    }
    await Bun.sleep(config.workerPollIntervalMs);
    continue;
  }

  lastActivityAt = Date.now();

  try {
    const { jobId } = JSON.parse(message.body);
    await processJob(jobId, message.messageId, message.popReceipt);
  } catch (err) {
    console.error("[worker] Failed to process message:", err);
    // Don't delete message — it will become visible again after visibility timeout
  }
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async function processJob(
  jobId: string,
  messageId: string,
  popReceipt: string,
): Promise<void> {
  console.log(`[worker] Processing job ${jobId}`);

  // Read job record
  const job = await readJob(jobsContainer, jobId);
  if (!job) {
    console.warn(`[worker] Job ${jobId} not found, deleting message`);
    await deleteMessage(queueClient, messageId, popReceipt);
    return;
  }

  // Idempotency guard
  if (job.status === "succeeded" || job.status === "failed") {
    console.log(`[worker] Job ${jobId} already ${job.status}, skipping`);
    await deleteMessage(queueClient, messageId, popReceipt);
    return;
  }

  // Crash recovery: if job is "running" with a stale startedAt, re-process
  if (job.status === "running" && job.startedAt) {
    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    if (elapsed < config.conversionTimeoutMs) {
      console.log(`[worker] Job ${jobId} still running (${Math.round(elapsed / 1000)}s), skipping`);
      await deleteMessage(queueClient, messageId, popReceipt);
      return;
    }
    console.log(`[worker] Job ${jobId} was running but stale, treating as crash recovery`);
  }

  // Mark as running
  await updateJobStatus(jobsContainer, jobId, "running", {
    startedAt: new Date().toISOString(),
    progress: 0,
  });

  const jobDir = join(TEMP_DIR, jobId);
  mkdirSync(jobDir, { recursive: true });
  const inputPath = join(jobDir, "input.rvt");
  const outputPath = join(jobDir, "output.ifc");

  try {
    // Download input
    console.log(`[worker] Downloading input for job ${jobId} (file: ${job.fileName}, expected: ${job.fileSize ?? "unknown"} bytes)`);
    await downloadBlobToFile(inputsContainer, `${jobId}.rvt`, inputPath);

    // Verify downloaded file size matches what client reported
    const downloadedSize = Bun.file(inputPath).size;
    console.log(`[worker] Downloaded ${downloadedSize} bytes for job ${jobId}`);
    if (job.fileSize && Math.abs(downloadedSize - job.fileSize) > 0) {
      const errorMsg = `File size mismatch: expected ${job.fileSize} bytes, got ${downloadedSize} bytes. Upload may have been incomplete.`;
      console.error(`[worker] Job ${jobId} failed: ${errorMsg}`);
      await updateJobStatus(jobsContainer, jobId, "failed", {
        finishedAt: new Date().toISOString(),
        error: errorMsg,
      });
      await deleteMessage(queueClient, messageId, popReceipt);
      return;
    }

    // Run conversion with progress reporting
    let lastProgressWrite = 0;
    const onProgress = async (percent: number) => {
      const now = Date.now();
      if (now - lastProgressWrite > 3_000 || percent >= 100) {
        lastProgressWrite = now;
        try {
          await writeProgress(jobsContainer, jobId, percent);
        } catch {
          // Progress write failure is non-fatal
        }
      }
    };

    console.log(`[worker] Starting conversion for job ${jobId}`);
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      config.conversionTimeoutMs,
    );

    const result = await runConversion(
      config,
      inputPath,
      outputPath,
      onProgress,
      abortController.signal,
    );
    clearTimeout(timeoutId);

    // Upload log
    await uploadBlob(logsContainer, `${jobId}.log`, result.log);

    // Check result
    if (result.exitCode !== 0) {
      const errorMsg = abortController.signal.aborted
        ? `Conversion timed out after ${config.conversionTimeoutMs / 1000}s`
        : `Converter exited with code ${result.exitCode}`;
      console.error(`[worker] Job ${jobId} failed: ${errorMsg}`);
      await updateJobStatus(jobsContainer, jobId, "failed", {
        finishedAt: new Date().toISOString(),
        error: errorMsg,
      });
      await deleteMessage(queueClient, messageId, popReceipt);
      return;
    }

    // The converter can exit 0 even on failure — check log for error patterns
    const logLower = result.log.toLowerCase();
    const errorPatterns = [
      "error when reading file",
      "can't open file",
      "fatal error",
      "unhandled exception",
      "access violation",
    ];
    const logError = errorPatterns.find((p) => logLower.includes(p));
    if (logError) {
      const errorMsg = `Conversion failed: ${logError}`;
      console.error(`[worker] Job ${jobId} failed: ${errorMsg}`);
      await updateJobStatus(jobsContainer, jobId, "failed", {
        finishedAt: new Date().toISOString(),
        error: errorMsg,
      });
      await deleteMessage(queueClient, messageId, popReceipt);
      return;
    }

    if (!existsSync(outputPath)) {
      console.error(`[worker] Job ${jobId} failed: no output file produced`);
      await updateJobStatus(jobsContainer, jobId, "failed", {
        finishedAt: new Date().toISOString(),
        error: "Conversion produced no output file",
      });
      await deleteMessage(queueClient, messageId, popReceipt);
      return;
    }

    // Verify output file is not empty (converter may create a 0-byte file on failure)
    const outputFile = Bun.file(outputPath);
    if (outputFile.size === 0) {
      console.error(`[worker] Job ${jobId} failed: output file is empty`);
      await updateJobStatus(jobsContainer, jobId, "failed", {
        finishedAt: new Date().toISOString(),
        error: "Conversion produced an empty output file",
      });
      await deleteMessage(queueClient, messageId, popReceipt);
      return;
    }

    // Upload output
    console.log(`[worker] Uploading output for job ${jobId}`);
    const outputData = await outputFile.arrayBuffer();
    await uploadBlob(outputsContainer, `${jobId}.ifc`, Buffer.from(outputData));

    // Mark succeeded
    await updateJobStatus(jobsContainer, jobId, "succeeded", {
      finishedAt: new Date().toISOString(),
      progress: 100,
    });
    await writeProgress(jobsContainer, jobId, 100);
    await deleteMessage(queueClient, messageId, popReceipt);
    console.log(`[worker] Job ${jobId} completed successfully`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] Job ${jobId} unexpected error:`, errorMsg);

    try {
      await updateJobStatus(jobsContainer, jobId, "failed", {
        finishedAt: new Date().toISOString(),
        error: `Unexpected error: ${errorMsg}`,
      });
      await deleteMessage(queueClient, messageId, popReceipt);
    } catch {
      // If we can't update the job or delete the message,
      // the message will become visible again for retry
    }
  } finally {
    // Clean up temp dir
    try {
      rmSync(jobDir, { recursive: true, force: true });
    } catch {}
  }
}
