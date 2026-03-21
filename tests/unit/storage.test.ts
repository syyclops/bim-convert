import { describe, it, expect, beforeAll } from "bun:test";
import {
  createBlobServiceClient,
  createQueueClient,
  ensureContainers,
  ensureQueue,
  uploadBlob,
  downloadBlob,
  blobExists,
  enqueueJob,
  dequeueJob,
  deleteMessage,
  getQueueDepth,
  generateUploadSasUrl,
  generateDownloadSasUrl,
} from "../../lib/storage";

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING!;
const testContainer = "test-storage-" + Date.now();
const testQueue = "test-queue-" + Date.now();

const blobService = createBlobServiceClient(connStr);
const containerClient = blobService.getContainerClient(testContainer);
const queueClient = createQueueClient(connStr, testQueue);

beforeAll(async () => {
  await ensureContainers(blobService, [testContainer]);
  await ensureQueue(queueClient);
});

describe("blob operations", () => {
  it("uploads and downloads a blob", async () => {
    await uploadBlob(containerClient, "test.txt", "hello world");
    const data = await downloadBlob(containerClient, "test.txt");
    expect(data.toString()).toBe("hello world");
  });

  it("checks blob existence", async () => {
    await uploadBlob(containerClient, "exists.txt", "yes");
    expect(await blobExists(containerClient, "exists.txt")).toBe(true);
    expect(await blobExists(containerClient, "nope.txt")).toBe(false);
  });

  it("overwrites existing blob", async () => {
    await uploadBlob(containerClient, "over.txt", "first");
    await uploadBlob(containerClient, "over.txt", "second");
    const data = await downloadBlob(containerClient, "over.txt");
    expect(data.toString()).toBe("second");
  });
});

describe("queue operations", () => {
  it("enqueues and dequeues a job", async () => {
    await enqueueJob(queueClient, "job-1");
    const msg = await dequeueJob(queueClient, 30);
    expect(msg).not.toBeNull();

    const body = JSON.parse(msg!.body);
    expect(body.jobId).toBe("job-1");

    await deleteMessage(queueClient, msg!.messageId, msg!.popReceipt);
  });

  it("returns null when queue is empty", async () => {
    // Drain any remaining messages
    while (true) {
      const msg = await dequeueJob(queueClient, 1);
      if (!msg) break;
      await deleteMessage(queueClient, msg.messageId, msg.popReceipt);
    }

    const msg = await dequeueJob(queueClient, 1);
    expect(msg).toBeNull();
  });

  it("reports queue depth", async () => {
    await enqueueJob(queueClient, "depth-1");
    await enqueueJob(queueClient, "depth-2");

    // Queue depth is approximate — give Azure a moment
    await Bun.sleep(500);
    const depth = await getQueueDepth(queueClient);
    expect(depth).toBeGreaterThanOrEqual(2);

    // Clean up
    while (true) {
      const msg = await dequeueJob(queueClient, 1);
      if (!msg) break;
      await deleteMessage(queueClient, msg.messageId, msg.popReceipt);
    }
  });
});

describe("SAS URL generation", () => {
  it("generates upload SAS URL", () => {
    const url = generateUploadSasUrl(connStr, testContainer, "test.rvt", 30);
    expect(url).toContain(testContainer);
    expect(url).toContain("test.rvt");
    expect(url).toContain("sig=");
  });

  it("generates download SAS URL", () => {
    const url = generateDownloadSasUrl(connStr, testContainer, "test.ifc", 15);
    expect(url).toContain(testContainer);
    expect(url).toContain("test.ifc");
    expect(url).toContain("sig=");
  });
});
