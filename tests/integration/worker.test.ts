import { describe, it, expect, beforeAll } from "bun:test";
import {
  createBlobServiceClient,
  createQueueClient,
  ensureContainers,
  ensureQueue,
  uploadBlob,
  enqueueJob,
  blobExists,
} from "../../lib/storage";
import { createJob, writeJob, readJob } from "../../lib/jobs";
import { loadConfig } from "../../lib/config";

const config = loadConfig();
const connStr = config.storageConnectionString;

const blobService = createBlobServiceClient(connStr);
const queueClient = createQueueClient(connStr, config.queueName);

const inputsContainer = blobService.getContainerClient(config.containerInputs);
const outputsContainer = blobService.getContainerClient(config.containerOutputs);
const jobsContainer = blobService.getContainerClient(config.containerJobs);
const logsContainer = blobService.getContainerClient(config.containerLogs);

beforeAll(async () => {
  await ensureContainers(blobService, [
    config.containerInputs,
    config.containerOutputs,
    config.containerJobs,
    config.containerLogs,
  ]);
  await ensureQueue(queueClient);
});

describe("worker processing", () => {
  it("processes a queued job end-to-end", async () => {
    const jobId = `worker-test-${Date.now()}`;

    // Set up: create job record, upload input, enqueue
    const job = createJob(jobId, "TestBuilding.rvt");
    job.status = "queued";
    job.queuedAt = new Date().toISOString();
    await writeJob(jobsContainer, job);
    await uploadBlob(inputsContainer, `${jobId}.rvt`, "FAKE-RVT-CONTENT");
    await enqueueJob(queueClient, jobId);

    // Start worker as subprocess
    const workerProc = Bun.spawn(["bun", "run", "worker.ts"], {
      env: {
        ...process.env,
        BIM_ENV: "local",
        CONVERTER_CMD: "bun run dev/mock-converter.ts",
        MOCK_CONVERTER_DURATION_MS: "2000",
        IDLE_SHUTDOWN_MS: "3000",
        WORKER_POLL_INTERVAL_MS: "500",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for the worker to process the job (mock takes ~2s + overhead)
    const maxWait = 15_000;
    const start = Date.now();
    let finalJob = await readJob(jobsContainer, jobId);

    while (
      finalJob &&
      finalJob.status !== "succeeded" &&
      finalJob.status !== "failed" &&
      Date.now() - start < maxWait
    ) {
      await Bun.sleep(1000);
      finalJob = await readJob(jobsContainer, jobId);
    }

    // Kill worker
    try { workerProc.kill(); } catch {}

    // Verify
    expect(finalJob).not.toBeNull();
    expect(finalJob!.status).toBe("succeeded");
    expect(finalJob!.finishedAt).toBeTruthy();

    // Output and log should exist
    expect(await blobExists(outputsContainer, `${jobId}.ifc`)).toBe(true);
    expect(await blobExists(logsContainer, `${jobId}.log`)).toBe(true);
  }, 20_000);
});
