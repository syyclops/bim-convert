import { describe, it, expect, beforeAll } from "bun:test";
import {
  createBlobServiceClient,
  ensureContainers,
} from "../../lib/storage";
import {
  createJob,
  readJob,
  writeJob,
  writeProgress,
  updateJobStatus,
  listJobIds,
} from "../../lib/jobs";

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING!;
const testContainer = "test-jobs-" + Date.now();

const blobService = createBlobServiceClient(connStr);
const containerClient = blobService.getContainerClient(testContainer);

beforeAll(async () => {
  await ensureContainers(blobService, [testContainer]);
});

describe("job CRUD", () => {
  it("creates a job with defaults", () => {
    const job = createJob("test-1", "Building.rvt");
    expect(job.id).toBe("test-1");
    expect(job.status).toBe("created");
    expect(job.progress).toBe(0);
    expect(job.fileName).toBe("Building.rvt");
    expect(job.createdAt).toBeTruthy();
  });

  it("writes and reads a job", async () => {
    const job = createJob("test-2", "House.rvt");
    await writeJob(containerClient, job);

    const read = await readJob(containerClient, "test-2");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("test-2");
    expect(read!.fileName).toBe("House.rvt");
    expect(read!.status).toBe("created");
  });

  it("returns null for non-existent job", async () => {
    const read = await readJob(containerClient, "no-such-job");
    expect(read).toBeNull();
  });

  it("updates job status", async () => {
    const job = createJob("test-3", "Office.rvt");
    await writeJob(containerClient, job);

    await updateJobStatus(containerClient, "test-3", "queued", {
      queuedAt: new Date().toISOString(),
    });

    const read = await readJob(containerClient, "test-3");
    expect(read!.status).toBe("queued");
    expect(read!.queuedAt).toBeTruthy();
  });
});

describe("progress tracking", () => {
  it("writes and reads progress separately", async () => {
    const job = createJob("test-progress", "Big.rvt");
    job.status = "running";
    job.progress = 0;
    await writeJob(containerClient, job);

    // Write progress blob
    await writeProgress(containerClient, "test-progress", 45);

    // readJob should merge the progress
    const read = await readJob(containerClient, "test-progress");
    expect(read!.progress).toBe(45);
  });

  it("clamps progress to 0-100", async () => {
    const job = createJob("test-clamp", "X.rvt");
    await writeJob(containerClient, job);

    await writeProgress(containerClient, "test-clamp", 150);
    const read = await readJob(containerClient, "test-clamp");
    expect(read!.progress).toBe(100);

    await writeProgress(containerClient, "test-clamp", -10);
    const read2 = await readJob(containerClient, "test-clamp");
    // -10 clamped to 0, but previous progress blob had 100.
    // writeProgress overwrites the blob, so now it's 0.
    // readJob takes max(job.progress=0, progressBlob=0) = 0.
    expect(read2!.progress).toBe(0);
  });
});

describe("listJobIds", () => {
  it("lists job IDs excluding progress blobs", async () => {
    const job1 = createJob("list-a", "A.rvt");
    const job2 = createJob("list-b", "B.rvt");
    await writeJob(containerClient, job1);
    await writeJob(containerClient, job2);
    await writeProgress(containerClient, "list-a", 50);

    const ids = await listJobIds(containerClient);
    expect(ids).toContain("list-a");
    expect(ids).toContain("list-b");
    // Should not include ".progress" suffix IDs (progress blobs are filtered out)
    const progressSuffixIds = ids.filter((id) => id.endsWith(".progress"));
    expect(progressSuffixIds.length).toBe(0);
  });
});
