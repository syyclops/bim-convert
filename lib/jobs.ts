import type { ContainerClient } from "@azure/storage-blob";
import { uploadBlob, downloadBlob, blobExists } from "./storage";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = "created" | "queued" | "running" | "succeeded" | "failed";

export interface Job {
  id: string;
  status: JobStatus;
  progress: number; // 0-100
  fileName: string;
  error?: string;
  createdAt: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface ProgressRecord {
  progress: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Job CRUD — stored as JSON blobs in the jobs container
//
// State ownership:
//   API  owns:  created → queued
//   Worker owns: queued → running → succeeded | failed
// ---------------------------------------------------------------------------

export function createJob(id: string, fileName: string): Job {
  return {
    id,
    status: "created",
    progress: 0,
    fileName,
    createdAt: new Date().toISOString(),
  };
}

export async function writeJob(container: ContainerClient, job: Job): Promise<void> {
  await uploadBlob(container, `${job.id}.json`, JSON.stringify(job));
}

export async function readJob(
  jobsContainer: ContainerClient,
  jobId: string,
): Promise<Job | null> {
  const exists = await blobExists(jobsContainer, `${jobId}.json`);
  if (!exists) return null;

  const data = await downloadBlob(jobsContainer, `${jobId}.json`);
  const job: Job = JSON.parse(data.toString("utf-8"));

  // Merge progress from separate progress blob if it exists
  try {
    const progressExists = await blobExists(jobsContainer, `${jobId}.progress.json`);
    if (progressExists) {
      const progressData = await downloadBlob(jobsContainer, `${jobId}.progress.json`);
      const progressRecord: ProgressRecord = JSON.parse(progressData.toString("utf-8"));
      if (progressRecord.progress > job.progress) {
        job.progress = progressRecord.progress;
      }
    }
  } catch {
    // Progress blob read failure is non-fatal
  }

  return job;
}

/** Write only the progress value — small blob, updated frequently by the worker. */
export async function writeProgress(
  container: ContainerClient,
  jobId: string,
  progress: number,
): Promise<void> {
  const record: ProgressRecord = {
    progress: Math.round(Math.min(100, Math.max(0, progress))),
    updatedAt: new Date().toISOString(),
  };
  await uploadBlob(container, `${jobId}.progress.json`, JSON.stringify(record));
}

/** Convenience: read-modify-write the job status + optional extra fields. */
export async function updateJobStatus(
  container: ContainerClient,
  jobId: string,
  status: JobStatus,
  extra?: Partial<Job>,
): Promise<Job | null> {
  const job = await readJob(container, jobId);
  if (!job) return null;

  job.status = status;
  if (extra) Object.assign(job, extra);
  await writeJob(container, job);
  return job;
}

/** List job IDs by scanning blobs matching *.json (excluding *.progress.json). */
export async function listJobIds(container: ContainerClient): Promise<string[]> {
  const ids: string[] = [];
  for await (const blob of container.listBlobsFlat()) {
    if (blob.name.endsWith(".json") && !blob.name.endsWith(".progress.json")) {
      ids.push(blob.name.replace(".json", ""));
    }
  }
  return ids;
}
