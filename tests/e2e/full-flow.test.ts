import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  createBlobServiceClient,
  createQueueClient,
  ensureContainers,
  ensureQueue,
} from "../../lib/storage";
import { loadConfig } from "../../lib/config";

const config = loadConfig();
const connStr = config.storageConnectionString;

const blobService = createBlobServiceClient(connStr);
const queueClient = createQueueClient(connStr, config.queueName);

let serverProc: ReturnType<typeof Bun.spawn>;
let workerProc: ReturnType<typeof Bun.spawn>;
let baseUrl: string;

beforeAll(async () => {
  await ensureContainers(blobService, [
    config.containerInputs,
    config.containerOutputs,
    config.containerJobs,
    config.containerLogs,
  ]);
  await ensureQueue(queueClient);

  const port = 9200 + Math.floor(Math.random() * 800);
  const env = {
    ...process.env,
    PORT: String(port),
    BIM_ENV: "local",
    CONVERTER_CMD: "bun run dev/mock-converter.ts",
    MOCK_CONVERTER_DURATION_MS: "2000",
    IDLE_SHUTDOWN_MS: "60000", // Don't auto-shutdown during test
    WORKER_POLL_INTERVAL_MS: "500",
  };

  serverProc = Bun.spawn(["bun", "run", "server.ts"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  workerProc = Bun.spawn(["bun", "run", "worker.ts"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  baseUrl = `http://localhost:${port}`;

  // Wait for server
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
  try { workerProc?.kill(); } catch {}
});

describe("end-to-end flow", () => {
  it("create → upload → submit → poll → download", async () => {
    // 1. Create job
    const createRes = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: "E2ETest.rvt" }),
    });
    expect(createRes.status).toBe(200);
    const { jobId, uploadUrl, submitUrl, statusUrl } = (await createRes.json()) as {
      jobId: string; uploadUrl: string; submitUrl: string; statusUrl: string;
    };
    expect(jobId).toBeTruthy();

    // 2. Upload file via SAS URL (PUT to blob storage)
    const fileContent = "FAKE-RVT-FOR-E2E-TEST";
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Type": "application/octet-stream",
      },
      body: fileContent,
    });
    expect(uploadRes.status).toBe(201);

    // 3. Submit for conversion
    const submitRes = await fetch(`${baseUrl}${submitUrl}`, { method: "POST" });
    expect(submitRes.status).toBe(202);

    // 4. Poll until done
    let job: any;
    const maxWait = 20_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      await Bun.sleep(1000);
      const pollRes = await fetch(`${baseUrl}${statusUrl}`);
      job = await pollRes.json();

      if (job.status === "succeeded" || job.status === "failed") break;

      // Progress should be increasing during "running" status
      if (job.status === "running") {
        expect(job.progress).toBeGreaterThanOrEqual(0);
      }
    }

    // 5. Verify completion
    expect(job.status).toBe("succeeded");
    expect(job.progress).toBe(100);
    expect(job.downloadUrl).toBeTruthy();
    expect(job.logUrl).toBeTruthy();

    // 6. Verify download URL works
    const downloadRes = await fetch(job.downloadUrl);
    expect(downloadRes.status).toBe(200);
    const content = await downloadRes.text();
    expect(content).toContain("IFC");
  }, 25_000);
});
