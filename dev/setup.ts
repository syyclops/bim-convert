/**
 * One-time Azurite setup — creates the required blob containers and queue.
 * Idempotent: safe to run multiple times.
 */

import { BlobServiceClient } from "@azure/storage-blob";
import { QueueServiceClient } from "@azure/storage-queue";

const connStr =
  process.env.AZURE_STORAGE_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;";

const containers = ["inputs", "outputs", "jobs", "logs"];
const queues = ["conversions"];

async function setup() {
  console.log("Setting up Azurite containers and queues...");

  const blobService = BlobServiceClient.fromConnectionString(connStr);
  for (const name of containers) {
    const client = blobService.getContainerClient(name);
    const { succeeded } = await client.createIfNotExists();
    console.log(`  container "${name}": ${succeeded ? "created" : "exists"}`);
  }

  const queueService = QueueServiceClient.fromConnectionString(connStr);
  for (const name of queues) {
    const client = queueService.getQueueClient(name);
    const created = await client.createIfNotExists();
    console.log(`  queue "${name}": ${created.succeeded ? "created" : "exists"}`);
  }

  console.log("Setup complete.");
}

setup().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
