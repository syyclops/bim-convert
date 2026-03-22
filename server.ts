import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { loadConfig } from "./lib/config";
import {
  createBlobServiceClient,
  createQueueClient,
  ensureContainers,
  ensureQueue,
  setCorsRules,
  generateUploadSasUrl,
  generateDownloadSasUrl,
  enqueueJob,
  getQueueDepth,
  blobExists,
} from "./lib/storage";
import {
  createJob,
  readJob,
  writeJob,
  updateJobStatus,
  listJobIds,
} from "./lib/jobs";
import { startWorkerVm } from "./lib/vm";

const config = loadConfig();

const blobService = createBlobServiceClient(config.storageConnectionString);
const queueClient = createQueueClient(config.storageConnectionString, config.queueName);

const inputsContainer = blobService.getContainerClient(config.containerInputs);
const outputsContainer = blobService.getContainerClient(config.containerOutputs);
const jobsContainer = blobService.getContainerClient(config.containerJobs);
const logsContainer = blobService.getContainerClient(config.containerLogs);

const INDEX_HTML = join(resolve(import.meta.dir), "index.html");

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

try {
  await setCorsRules(blobService);
} catch (err) {
  // CORS setting may fail on Azurite in some configs — non-fatal
  console.warn("[server] Failed to set CORS rules:", err instanceof Error ? err.message : err);
}

// Stale job scanner — runs every 5 minutes
const STALE_SCAN_INTERVAL = 300_000;
const STALE_THRESHOLD_MS = config.conversionTimeoutMs + 300_000; // timeout + 5 min

setInterval(async () => {
  try {
    const jobIds = await listJobIds(jobsContainer);
    for (const id of jobIds) {
      const job = await readJob(jobsContainer, id);
      if (!job || job.status !== "running" || !job.startedAt) continue;

      const elapsed = Date.now() - new Date(job.startedAt).getTime();
      if (elapsed > STALE_THRESHOLD_MS) {
        console.log(`[server] Marking stale job ${id} as failed (running for ${Math.round(elapsed / 1000)}s)`);
        await updateJobStatus(jobsContainer, id, "failed", {
          finishedAt: new Date().toISOString(),
          error: "Worker timeout — conversion may have crashed",
        });
      }
    }
  } catch (err) {
    console.error("[server] Stale scan error:", err);
  }
}, STALE_SCAN_INTERVAL);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: config.port,

  async fetch(req) {
    const url = new URL(req.url);

    // GET / — serve UI
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(Bun.file(INDEX_HTML));
    }

    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // POST /jobs — create a new conversion job
    if (req.method === "POST" && url.pathname === "/jobs") {
      return handleCreateJob(req);
    }

    // POST /jobs/:id/submit — submit job for conversion
    const submitMatch = url.pathname.match(/^\/jobs\/([^/]+)\/submit$/);
    if (req.method === "POST" && submitMatch) {
      return handleSubmitJob(submitMatch[1]);
    }

    // GET /jobs/:id — poll job status
    const statusMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (req.method === "GET" && statusMatch) {
      return handleGetJob(statusMatch[1]);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[server] BIM Convert API running on http://localhost:${server.port}`);

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleCreateJob(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { fileName?: string; fileSize?: number };
    const fileName = body?.fileName;
    const fileSize = body?.fileSize;

    if (!fileName || typeof fileName !== "string") {
      return Response.json({ error: "fileName is required" }, { status: 400 });
    }

    if (!fileName.toLowerCase().endsWith(".rvt")) {
      return Response.json({ error: "File must be a .rvt file" }, { status: 400 });
    }

    const jobId = randomUUID();
    const job = createJob(jobId, fileName);
    if (typeof fileSize === "number" && fileSize > 0) {
      job.fileSize = fileSize;
    }
    await writeJob(jobsContainer, job);

    const uploadUrl = generateUploadSasUrl(
      config.storageConnectionString,
      config.containerInputs,
      `${jobId}.rvt`,
      config.sasExpiryMinutes,
    );

    return Response.json({
      jobId,
      uploadUrl,
      submitUrl: `/jobs/${jobId}/submit`,
      statusUrl: `/jobs/${jobId}`,
    });
  } catch (err) {
    console.error("[server] Create job error:", err);
    return Response.json({ error: "Failed to create job" }, { status: 500 });
  }
}

async function handleSubmitJob(jobId: string): Promise<Response> {
  try {
    const job = await readJob(jobsContainer, jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.status !== "created") {
      return Response.json(
        { error: `Job cannot be submitted in status "${job.status}"` },
        { status: 409 },
      );
    }

    // Verify input blob was uploaded
    const inputExists = await blobExists(inputsContainer, `${jobId}.rvt`);
    if (!inputExists) {
      return Response.json(
        { error: "Input file not uploaded yet. Upload to the uploadUrl first." },
        { status: 400 },
      );
    }

    // Check queue depth
    const depth = await getQueueDepth(queueClient);
    if (depth >= config.maxQueuedJobs) {
      return Response.json(
        { error: `Queue is full (${depth}/${config.maxQueuedJobs}). Try again later.` },
        { status: 429 },
      );
    }

    // Update job status
    await updateJobStatus(jobsContainer, jobId, "queued", {
      queuedAt: new Date().toISOString(),
    });

    // Enqueue
    await enqueueJob(queueClient, jobId);

    // Start worker VM (fire-and-forget, debounced)
    startWorkerVm(config).catch((err) => {
      console.error("[server] Failed to start worker VM:", err);
    });

    return Response.json({ statusUrl: `/jobs/${jobId}` }, { status: 202 });
  } catch (err) {
    console.error("[server] Submit job error:", err);
    return Response.json({ error: "Failed to submit job" }, { status: 500 });
  }
}

async function handleGetJob(jobId: string): Promise<Response> {
  try {
    const job = await readJob(jobsContainer, jobId);
    if (!job) {
      return Response.json({ error: "Job not found" }, { status: 404 });
    }

    const response: Record<string, unknown> = {
      id: job.id,
      status: job.status,
      progress: job.progress,
      fileName: job.fileName,
      createdAt: job.createdAt,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
    };

    // Generate download URLs for completed jobs
    if (job.status === "succeeded") {
      const outputExists = await blobExists(outputsContainer, `${jobId}.ifc`);
      if (outputExists) {
        const ifcName = job.fileName.replace(/\.rvt$/i, ".ifc");
        response.downloadUrl = generateDownloadSasUrl(
          config.storageConnectionString,
          config.containerOutputs,
          `${jobId}.ifc`,
          15, // 15 min download window
          ifcName,
        );
      }
    }

    // Attach log URL for succeeded or failed jobs
    if (job.status === "succeeded" || job.status === "failed") {
      const logExists = await blobExists(logsContainer, `${jobId}.log`);
      if (logExists) {
        response.logUrl = generateDownloadSasUrl(
          config.storageConnectionString,
          config.containerLogs,
          `${jobId}.log`,
          15,
        );
      }
    }

    return Response.json(response);
  } catch (err) {
    console.error("[server] Get job error:", err);
    return Response.json({ error: "Failed to get job status" }, { status: 500 });
  }
}
