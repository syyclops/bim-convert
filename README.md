# bim-convert

HTTP API that converts Revit (.rvt) files to IFC. Async job-based architecture with a cheap always-on Linux API server and an on-demand Windows worker that auto-deallocates when idle.

Uses [DDC RVT2IFC Converter](https://github.com/datadrivenconstruction/cad2data-Revit-IFC-DWG-DGN) under the hood — no Revit license required.

## Architecture

```
Client → Caddy (HTTPS) → Bun API → Azure Storage Queue → Worker VM → RVT2IFCconverter.exe
                                  → Azure Blob (SAS URL uploads/downloads)
```

- **API VM**: Linux B2s, always on (~$7/mo). Serves UI, manages jobs, issues SAS URLs.
- **Worker VM**: Windows B2s, starts on demand, deallocates after 15 min idle. Runs converter.
- **Storage**: Azure Blob + Queue. Files upload/download directly via SAS URLs (bypass API).

## How it works

1. `POST /jobs` — creates a job, returns a SAS upload URL
2. Client uploads `.rvt` directly to Azure Blob via SAS URL
3. `POST /jobs/:id/submit` — queues the conversion, starts the worker VM
4. Worker downloads input, runs converter, uploads `.ifc` result
5. `GET /jobs/:id` — poll for status and real-time progress (0-100%)
6. Download the `.ifc` via SAS URL when complete

## Local development (macOS)

The converter is Windows-only, but the full system runs locally using a mock converter and [Azurite](https://github.com/Azure/Azurite) (Azure Storage emulator).

### Prerequisites

- [Bun](https://bun.sh) v1.0+

### Setup

```bash
bun install
bun run dev
```

This starts Azurite + API server + worker with auto-reload. Open http://localhost:8000.

### Testing

```bash
bun test           # all tests (39 tests)
bun test tests/unit/          # unit tests only
bun test tests/integration/   # integration tests
bun test tests/e2e/           # end-to-end flow
```

### Simulating failure modes

Edit `.env.local` and set `MOCK_CONVERTER_FAIL_MODE`:
- `none` (default) — normal success
- `exit-code` — converter fails at 50%
- `timeout` — converter hangs forever
- `missing-output` — converter produces no output file

## Deploy to Azure

### Prerequisites

- [Terraform](https://www.terraform.io/downloads)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli)
- `datadrivenlibs/` directory with the DDC converter in the project root
- A domain name you control

### Deploy

```bash
az login
cd infra
terraform init
terraform apply
```

After deploy, create a DNS A record pointing your domain to the API VM IP (shown in outputs). Caddy will provision a Let's Encrypt certificate automatically.

### Configuration

| Variable                      | Default           | Description                           |
| ----------------------------- | ----------------- | ------------------------------------- |
| `domain`                      | _required_        | Domain for HTTPS                      |
| `admin_password`              | _required_        | VM admin password                     |
| `location`                    | `eastus`          | Azure region                          |
| `api_vm_size`                 | `Standard_B2s`    | API server VM size                    |
| `worker_vm_size`              | `Standard_B2s`    | Worker VM size                        |
| `worker_idle_timeout_minutes` | `15`              | Minutes before worker auto-deallocates |
| `allowed_ip`                  | `*`               | IP allowed for SSH/RDP access         |
| `resource_prefix`             | `bimconvert`      | Prefix for Azure resource names       |

### Useful commands

```bash
# SSH into API VM
ssh adminuser@<api-ip>

# View API logs
journalctl -u bim-convert -f

# Start/stop worker manually
az vm start -g bimconvert-rg -n bimconvert-wkr
az vm deallocate -g bimconvert-rg -n bimconvert-wkr

# List conversion logs
az storage blob list --account-name bimconvertstor -c logs --output table
```

### Teardown

```bash
cd infra
terraform destroy
```

## API

### `GET /health`
Returns `{"status": "ok"}`.

### `POST /jobs`
Create a new conversion job.

```bash
curl -X POST https://convert.example.com/jobs \
  -H 'Content-Type: application/json' \
  -d '{"fileName":"MyBuilding.rvt"}'
```

Response: `{ "jobId", "uploadUrl", "submitUrl", "statusUrl" }`

### `PUT <uploadUrl>`
Upload the `.rvt` file directly to Azure Blob Storage.

```bash
curl -X PUT "<uploadUrl>" \
  -H "x-ms-blob-type: BlockBlob" \
  --data-binary @MyBuilding.rvt
```

### `POST /jobs/:id/submit`
Submit the job for conversion. Returns `202 Accepted`.

### `GET /jobs/:id`
Poll job status. Returns progress (0-100%), download URL when complete.

| Status      | Meaning                          |
| ----------- | -------------------------------- |
| `created`   | Job created, waiting for upload  |
| `queued`    | Queued for conversion            |
| `running`   | Converting (check `progress`)    |
| `succeeded` | Done — `downloadUrl` available   |
| `failed`    | Failed — `error` has details     |

## Project structure

```
server.ts              API server (Linux VM)
worker.ts              Queue consumer + converter runner (Windows VM)
index.html             Web GUI with progress tracking
lib/
  config.ts            Centralized env parsing
  storage.ts           Azure Blob, Queue, SAS helpers
  jobs.ts              Job types + blob-backed persistence
  vm.ts                Worker VM start/deallocate via az CLI
  converter.ts         Converter execution + progress parsing
dev/
  mock-converter.ts    Simulates converter on macOS
  dev.ts               Dev process orchestrator
  setup.ts             Azurite container/queue init
infra/
  main.tf              Azure resources (2 VMs, storage, queue, IAM)
  variables.tf         Configurable inputs
  outputs.tf           Useful commands and URLs
  api-bootstrap.sh     Linux API VM setup
  worker-bootstrap.ps1 Windows worker VM setup
```

## License

MIT
