# BIM Convert

Convert Revit (.rvt) files to IFC — no Revit license required.

BIM Convert is an open-source API and web app for converting Revit files to the open IFC format. Upload a `.rvt` file, get back an `.ifc`. It runs on Azure with an always-on API server (~$7/mo) and an on-demand Windows worker VM that spins up for conversions and shuts itself down when idle.

Built with [Bun](https://bun.sh) and powered by the [DDC RVT2IFC Converter](https://github.com/datadrivenconstruction/cad2data-Revit-IFC-DWG-DGN).

---

## How it works

```
                          ┌──────────────┐
                          │   Web UI or  │
                          │   API Client │
                          └──────┬───────┘
                                 │
                          1. POST /jobs
                          2. Upload .rvt via SAS URL
                          3. POST /jobs/:id/submit
                                 │
                          ┌──────▼───────┐         ┌─────────────────┐
                          │   API Server │────────▶│  Azure Storage  │
                          │  (Linux VM)  │         │  Blob + Queue   │
                          └──────────────┘         └────────┬────────┘
                                                            │
                                                     4. Worker picks
                                                        up the job
                                                            │
                                                   ┌────────▼────────┐
                                                   │   Worker VM     │
                                                   │ (Windows, on-   │
                                                   │  demand)        │
                                                   │                 │
                                                   │ Downloads .rvt  │
                                                   │ Runs converter  │
                                                   │ Uploads .ifc    │
                                                   └─────────────────┘
                                                            │
                          5. GET /jobs/:id  ◀───────────────┘
                          6. Download .ifc via SAS URL
```

**Key design decisions:**
- Files upload/download directly to Azure Blob Storage via signed URLs — the API never touches file bytes
- The worker VM auto-deallocates after 15 minutes of idle time, so you only pay when converting
- No database — all state lives in Azure Blob Storage as JSON files

---

## Quick start

**Try it now at [convert.syyclops.com](https://convert.syyclops.com)** — no account, no setup, completely free.

### Web UI

Go to [convert.syyclops.com](https://convert.syyclops.com), drag and drop a `.rvt` file, and download your `.ifc` when it's ready.

### API

The hosted instance is also a fully open API. Integrate it directly into your tools and workflows.

**1. Create a job**
```bash
curl -X POST https://convert.syyclops.com/jobs \
  -H "Content-Type: application/json" \
  -d '{"fileName": "MyBuilding.rvt"}'
```

Returns:
```json
{
  "jobId": "abc123",
  "uploadUrl": "https://storage.blob.core.windows.net/inputs/abc123.rvt?sas=...",
  "submitUrl": "https://convert.syyclops.com/jobs/abc123/submit",
  "statusUrl": "https://convert.syyclops.com/jobs/abc123"
}
```

**2. Upload your file**
```bash
curl -X PUT "<uploadUrl>" \
  -H "x-ms-blob-type: BlockBlob" \
  --data-binary @MyBuilding.rvt
```

**3. Submit for conversion**
```bash
curl -X POST https://convert.syyclops.com/jobs/abc123/submit
```

**4. Poll for status**
```bash
curl https://convert.syyclops.com/jobs/abc123
```

**5. Download when done**

When `status` is `"succeeded"`, the response includes a `downloadUrl`. Download your `.ifc` from there.

### Job statuses

| Status | Meaning |
|---|---|
| `created` | Waiting for file upload |
| `queued` | In the conversion queue |
| `running` | Converting — check `progress` (0–100%) |
| `succeeded` | Done — `downloadUrl` is available |
| `failed` | Something went wrong — see `error` |

---

## Deploy your own

### What you'll need

- [Terraform](https://www.terraform.io/downloads)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- The `datadrivenlibs/` directory containing the [DDC RVT2IFC Converter](https://github.com/datadrivenconstruction/cad2data-Revit-IFC-DWG-DGN) files, placed in the project root
- A domain name you control (for HTTPS)

### Deploy

```bash
az login
cd infra
terraform init
terraform apply
```

Terraform will prompt you for your domain name and an admin password. After it finishes:

1. Copy the API VM's public IP from the Terraform output
2. Create a DNS **A record** pointing your domain to that IP
3. Caddy (the reverse proxy) will automatically provision a Let's Encrypt TLS certificate

That's it. Your instance is live.

### Terraform variables

| Variable | Default | Description |
|---|---|---|
| `domain` | *required* | Your domain for HTTPS |
| `admin_password` | *required* | VM admin password |
| `location` | `eastus` | Azure region |
| `api_vm_size` | `Standard_B2s` | API server VM size |
| `worker_vm_size` | `Standard_D4s_v3` | Worker VM size |
| `worker_idle_timeout_minutes` | `15` | Idle time before worker auto-deallocates |
| `allowed_ip` | `*` | IP allowed for SSH/RDP access |
| `resource_prefix` | `bimconvert` | Prefix for all Azure resource names |

### Managing your deployment

```bash
# SSH into the API server
ssh adminuser@<api-ip>

# View API logs
journalctl -u bim-convert -f

# Manually start or stop the worker
az vm start -g bimconvert-rg -n bimconvert-wkr
az vm deallocate -g bimconvert-rg -n bimconvert-wkr

# Tear everything down
cd infra && terraform destroy
```

### What gets created

| Resource | Purpose | Cost |
|---|---|---|
| Linux VM (B2s) | API server + web UI + Caddy | ~$7/mo (always on) |
| Windows VM (D4s_v3) | Runs the converter | Pay-per-use (auto-deallocates) |
| Storage Account | File storage + job queue + job state | Minimal |
| 2 VNets + NSGs | Network isolation | Free |
| Managed Identities | API starts worker, worker deallocates itself | Free |

Azure Blob lifecycle policies auto-clean old files: inputs after 1 day, outputs after 7 days, job records after 30 days.

---

## Local development

The converter is Windows-only, but you can run the full system locally on any OS using a mock converter and [Azurite](https://github.com/Azure/Azurite) (Azure Storage emulator).

### Prerequisites

- [Bun](https://bun.sh) v1.0+

### Run it

```bash
bun install
bun run dev
```

This starts Azurite, the API server, and the worker — all with hot reload. Open [http://localhost:8000](http://localhost:8000).

### Run tests

```bash
bun test                        # all 39 tests
bun test tests/unit/            # unit tests
bun test tests/integration/     # integration tests
bun test tests/e2e/             # end-to-end flow
```

### Simulate failures

Set `MOCK_CONVERTER_FAIL_MODE` in `.env.local`:

| Mode | Behavior |
|---|---|
| `none` | Normal success (default) |
| `exit-code` | Converter fails at 50% |
| `timeout` | Converter hangs forever |
| `missing-output` | Converter exits but produces no file |

---

## Project structure

```
server.ts                API server (runs on Linux VM)
worker.ts                Queue consumer + converter runner (runs on Windows VM)
index.html               Web UI — drag-and-drop upload with progress tracking

lib/
  config.ts              Environment variable parsing and validation
  storage.ts             Azure Blob, Queue, and SAS URL helpers
  jobs.ts                Job state management (blob-backed)
  converter.ts           Converter execution and progress parsing
  vm.ts                  Worker VM lifecycle (start / deallocate)

dev/
  dev.ts                 Dev process orchestrator
  mock-converter.ts      Simulates the converter on macOS/Linux
  setup.ts               Azurite container and queue initialization

tests/
  unit/                  Config, progress parsing, SAS URLs, job CRUD
  integration/           Server endpoints, worker processing, storage ops
  e2e/                   Full create → upload → convert → download flow

infra/
  main.tf                All Azure resources
  variables.tf           Configurable inputs
  outputs.tf             Post-deploy commands and URLs
  api-bootstrap.sh       Linux VM setup (Bun, Caddy, systemd)
  worker-bootstrap.ps1   Windows VM setup (Bun, NSSM, converter)
```

---

## License

MIT
