import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createBlobServiceClient,
  createQueueClient,
  ensureContainers,
  ensureQueue,
  uploadBlob,
} from "../../lib/storage";
import { loadConfig } from "../../lib/config";

const config = loadConfig();
const connStr = config.storageConnectionString;

const blobService = createBlobServiceClient(connStr);
const queueClient = createQueueClient(connStr, config.queueName);

let serverProc: ReturnType<typeof Bun.spawn>;
let baseUrl: string;

beforeAll(async () => {
  await ensureContainers(blobService, [
    config.containerInputs,
    config.containerOutputs,
    config.containerJobs,
    config.containerLogs,
  ]);
  await ensureQueue(queueClient);

  // Start server on a random port
  const port = 9100 + Math.floor(Math.random() * 900);
  serverProc = Bun.spawn(["bun", "run", "server.ts"], {
    env: { ...process.env, PORT: String(port), BIM_ENV: "local" },
    stdout: "pipe",
    stderr: "pipe",
  });
  baseUrl = `http://localhost:${port}`;

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch {}
    await Bun.sleep(200);
  }
});

afterAll(() => {
  try { serverProc?.kill(); } catch {}
});

interface JobResponse {
  jobId: string;
  uploadUrl: string;
  submitUrl: string;
  statusUrl: string;
}

describe("server endpoints", () => {
  it("GET /health returns ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("GET / returns HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("BIM Convert");
  });

  it("POST /jobs creates a job", async () => {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "Test.rvt" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as JobResponse;
    expect(body.jobId).toBeTruthy();
    expect(body.uploadUrl).toContain("inputs");
    expect(body.submitUrl).toContain(body.jobId);
    expect(body.statusUrl).toContain(body.jobId);
  });

  it("POST /jobs rejects non-.rvt files", async () => {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "Test.dwg" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /jobs rejects missing fileName", async () => {
    const res = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /jobs/:id returns 404 for unknown job", async () => {
    const res = await fetch(`${baseUrl}/jobs/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("POST /jobs/:id/submit rejects if input not uploaded", async () => {
    const createRes = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "NoUpload.rvt" }),
    });
    const { jobId, submitUrl } = (await createRes.json()) as JobResponse;

    const submitRes = await fetch(`${baseUrl}${submitUrl}`, { method: "POST" });
    expect(submitRes.status).toBe(400);
    const body = (await submitRes.json()) as { error: string };
    expect(body.error).toContain("not uploaded");
  });

  it("full create + upload + submit + poll flow", async () => {
    const createRes = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "Building.rvt" }),
    });
    const { jobId, uploadUrl, submitUrl, statusUrl } = (await createRes.json()) as JobResponse;

    // Upload file to blob directly
    const inputsContainer = blobService.getContainerClient(config.containerInputs);
    await uploadBlob(inputsContainer, `${jobId}.rvt`, "FAKE-RVT-CONTENT");

    // Submit
    const submitRes = await fetch(`${baseUrl}${submitUrl}`, { method: "POST" });
    expect(submitRes.status).toBe(202);

    // Poll status
    const pollRes = await fetch(`${baseUrl}${statusUrl}`);
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as { id: string; status: string; fileName: string };
    expect(job.id).toBe(jobId);
    expect(job.status).toBe("queued");
    expect(job.fileName).toBe("Building.rvt");
  });
});
