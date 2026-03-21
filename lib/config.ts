export interface Config {
  // Mode
  env: "local" | "production";

  // Server
  port: number;

  // Storage
  storageConnectionString: string;
  queueName: string;
  containerInputs: string;
  containerOutputs: string;
  containerJobs: string;
  containerLogs: string;

  // Timeouts & limits
  conversionTimeoutMs: number;
  queueVisibilityTimeoutSec: number;
  maxFileSizeMb: number;
  sasExpiryMinutes: number;
  maxQueuedJobs: number;

  // Worker
  idleShutdownMs: number;
  workerPollIntervalMs: number;
  converterCmd: string;
  converterDir: string;

  // VM management
  azureResourceGroup: string;
  azureSubscriptionId: string;
  workerVmName: string;
}

export function loadConfig(): Config {
  const env = (process.env.BIM_ENV ?? "production") as Config["env"];
  if (env !== "local" && env !== "production") {
    throw new Error(`Invalid BIM_ENV: ${env}. Must be "local" or "production".`);
  }

  const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!storageConnectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is required");
  }

  const conversionTimeoutMs = Number(process.env.CONVERSION_TIMEOUT_MS) || 1_800_000; // 30 min
  const queueVisibilityTimeoutSec =
    Number(process.env.QUEUE_VISIBILITY_TIMEOUT_SEC) ||
    Math.ceil(conversionTimeoutMs / 1000) + 300; // conversion timeout + 5 min buffer

  return Object.freeze({
    env,
    port: Number(process.env.PORT) || 8000,

    storageConnectionString,
    queueName: process.env.QUEUE_NAME ?? "conversions",
    containerInputs: process.env.CONTAINER_INPUTS ?? "inputs",
    containerOutputs: process.env.CONTAINER_OUTPUTS ?? "outputs",
    containerJobs: process.env.CONTAINER_JOBS ?? "jobs",
    containerLogs: process.env.CONTAINER_LOGS ?? "logs",

    conversionTimeoutMs,
    queueVisibilityTimeoutSec,
    maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB) || 500,
    sasExpiryMinutes: Number(process.env.SAS_EXPIRY_MINUTES) || 60,
    maxQueuedJobs: Number(process.env.MAX_QUEUED_JOBS) || 20,

    idleShutdownMs: Number(process.env.IDLE_SHUTDOWN_MS) || 900_000, // 15 min
    workerPollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS) || 5_000,
    converterCmd: process.env.CONVERTER_CMD ?? "RVT2IFCconverter.exe",
    converterDir: process.env.CONVERTER_DIR ?? "./datadrivenlibs",

    azureResourceGroup: process.env.AZURE_RESOURCE_GROUP ?? "",
    azureSubscriptionId: process.env.AZURE_SUBSCRIPTION_ID ?? "",
    workerVmName: process.env.WORKER_VM_NAME ?? "",
  });
}
