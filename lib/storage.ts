import {
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  type BlobDownloadResponseParsed,
} from "@azure/storage-blob";
import { QueueClient, QueueServiceClient } from "@azure/storage-queue";
import type { Config } from "./config";

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

export function createBlobServiceClient(connStr: string): BlobServiceClient {
  return BlobServiceClient.fromConnectionString(connStr);
}

export function createQueueClient(connStr: string, queueName: string): QueueClient {
  const queueService = QueueServiceClient.fromConnectionString(connStr);
  return queueService.getQueueClient(queueName);
}

// ---------------------------------------------------------------------------
// Container / queue init  (idempotent — safe to call on every startup)
// ---------------------------------------------------------------------------

export async function ensureContainers(
  blobService: BlobServiceClient,
  names: string[],
): Promise<void> {
  await Promise.all(
    names.map((n) => blobService.getContainerClient(n).createIfNotExists()),
  );
}

export async function ensureQueue(queue: QueueClient): Promise<void> {
  await queue.createIfNotExists();
}

// ---------------------------------------------------------------------------
// CORS (needed for browser direct-to-blob uploads via SAS URL)
// ---------------------------------------------------------------------------

export async function setCorsRules(blobService: BlobServiceClient): Promise<void> {
  await blobService.setProperties({
    cors: [
      {
        allowedOrigins: "*",
        allowedMethods: "PUT,GET,HEAD",
        allowedHeaders: "x-ms-blob-type,Content-Type,Content-Length",
        exposedHeaders: "Content-Length",
        maxAgeInSeconds: 3600,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// SAS URL generation
// ---------------------------------------------------------------------------

function getCredentialFromConnStr(connStr: string): {
  accountName: string;
  credential: StorageSharedKeyCredential;
} {
  const accountName = connStr.match(/AccountName=([^;]+)/)?.[1];
  const accountKey = connStr.match(/AccountKey=([^;]+)/)?.[1];
  if (!accountName || !accountKey) {
    throw new Error("Cannot extract account name/key from connection string");
  }
  return {
    accountName,
    credential: new StorageSharedKeyCredential(accountName, accountKey),
  };
}

export function generateUploadSasUrl(
  connStr: string,
  containerName: string,
  blobPath: string,
  expiryMinutes: number,
): string {
  const { accountName, credential } = getCredentialFromConnStr(connStr);
  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + expiryMinutes * 60_000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("cw"), // create + write
      startsOn,
      expiresOn,
    },
    credential,
  ).toString();

  const blobEndpoint = connStr.match(/BlobEndpoint=([^;]+)/)?.[1];
  const baseUrl = blobEndpoint
    ? `${blobEndpoint}/${containerName}/${blobPath}`
    : `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}`;

  return `${baseUrl}?${sas}`;
}

export function generateDownloadSasUrl(
  connStr: string,
  containerName: string,
  blobPath: string,
  expiryMinutes: number,
  downloadFileName?: string,
): string {
  const { accountName, credential } = getCredentialFromConnStr(connStr);
  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + expiryMinutes * 60_000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"), // read only
      startsOn,
      expiresOn,
      contentDisposition: downloadFileName
        ? `attachment; filename="${downloadFileName}"`
        : undefined,
    },
    credential,
  ).toString();

  const blobEndpoint = connStr.match(/BlobEndpoint=([^;]+)/)?.[1];
  const baseUrl = blobEndpoint
    ? `${blobEndpoint}/${containerName}/${blobPath}`
    : `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}`;

  return `${baseUrl}?${sas}`;
}

// ---------------------------------------------------------------------------
// Queue operations
// ---------------------------------------------------------------------------

export interface QueueMessage {
  messageId: string;
  popReceipt: string;
  body: string;
}

export async function enqueueJob(
  queue: QueueClient,
  jobId: string,
): Promise<void> {
  const body = JSON.stringify({ jobId });
  const encoded = Buffer.from(body).toString("base64");
  await queue.sendMessage(encoded);
}

export async function dequeueJob(
  queue: QueueClient,
  visibilityTimeoutSec: number,
): Promise<QueueMessage | null> {
  const resp = await queue.receiveMessages({
    numberOfMessages: 1,
    visibilityTimeout: visibilityTimeoutSec,
  });
  const msg = resp.receivedMessageItems[0];
  if (!msg) return null;

  const body = Buffer.from(msg.messageText, "base64").toString("utf-8");
  return {
    messageId: msg.messageId,
    popReceipt: msg.popReceipt,
    body,
  };
}

export async function peekQueue(queue: QueueClient): Promise<number> {
  const resp = await queue.peekMessages({ numberOfMessages: 1 });
  return resp.peekedMessageItems.length;
}

export async function deleteMessage(
  queue: QueueClient,
  messageId: string,
  popReceipt: string,
): Promise<void> {
  await queue.deleteMessage(messageId, popReceipt);
}

export async function getQueueDepth(queue: QueueClient): Promise<number> {
  const props = await queue.getProperties();
  return props.approximateMessagesCount ?? 0;
}

// ---------------------------------------------------------------------------
// Blob operations
// ---------------------------------------------------------------------------

export async function uploadBlob(
  container: ContainerClient,
  blobPath: string,
  data: Buffer | string,
): Promise<void> {
  const blockBlob = container.getBlockBlobClient(blobPath);
  const content = typeof data === "string" ? Buffer.from(data) : data;
  await blockBlob.upload(content, content.length);
}

export async function downloadBlob(
  container: ContainerClient,
  blobPath: string,
): Promise<Buffer> {
  const blockBlob = container.getBlockBlobClient(blobPath);
  const resp: BlobDownloadResponseParsed = await blockBlob.download(0);
  const body = resp.readableStreamBody;
  if (!body) throw new Error(`Blob ${blobPath} has no body`);

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function downloadBlobToFile(
  container: ContainerClient,
  blobPath: string,
  filePath: string,
): Promise<void> {
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.downloadToFile(filePath);
}

export async function blobExists(
  container: ContainerClient,
  blobPath: string,
): Promise<boolean> {
  const blockBlob = container.getBlockBlobClient(blobPath);
  return blockBlob.exists();
}
