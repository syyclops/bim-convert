# bim-convert

HTTP API that converts Revit (.rvt) files to IFC. Upload a file, get the IFC back. One-command deploy to Azure.

Uses [DDC RVT2IFC Converter](https://github.com/nickvdwielen/cad2data-Revit-IFC-DWG-DGN-pipeline-with-conversion-validation-qto) under the hood — no Revit license required.

## How it works

```
POST /convert  →  upload .rvt  →  get .ifc back
```

The API is a single `server.ts` file running on [Bun](https://bun.sh) with zero dependencies. It shells out to `RVT2IFCconverter.exe` which must run on Windows.

## Quick start (local on Windows)

```powershell
# Install Bun
powershell -c "irm bun.sh/install.ps1 | iex"

# Place converter files
# Copy datadrivenlibs/ from DDC converter into this directory

# Run
bun run server.ts
```

## Deploy to Azure

Terraform provisions a Windows VM, uploads everything, and starts the service automatically.

### Prerequisites

- [Terraform](https://www.terraform.io/downloads) installed
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed
- `datadrivenlibs/` directory with the DDC converter in the project root

### Deploy

```bash
az login

cd infra
terraform init
terraform apply
```

Terraform will prompt for `admin_password`. Once complete, it outputs the API URL.

### Configuration

| Variable          | Default           | Description                     |
| ----------------- | ----------------- | ------------------------------- |
| `location`        | `eastus`          | Azure region                    |
| `vm_size`         | `Standard_D2s_v3` | VM size (2 vCPU, 8GB RAM)       |
| `admin_password`  | _required_        | VM admin password               |
| `allowed_ip`      | `*`               | IP allowed for RDP access       |
| `resource_prefix` | `bimconvert`      | Prefix for Azure resource names |

### Teardown

```bash
cd infra
terraform destroy
```

## API

### `GET /health`

Returns `{"status": "ok"}`.

### `POST /convert`

Upload a `.rvt` file as multipart form data. Returns the `.ifc` file.

```bash
curl -X POST http://<ip>:8000/convert \
  -F "file=@MyBuilding.rvt" \
  --output MyBuilding.ifc
```

| Status | Meaning                                  |
| ------ | ---------------------------------------- |
| 200    | Success — IFC file in response body      |
| 400    | Bad request — missing file or not `.rvt` |
| 413    | File too large (max 500MB)               |
| 500    | Conversion failed                        |

## Project structure

```
server.ts              API server (single file, zero dependencies)
infra/
  main.tf              Azure resources (VM, networking, storage)
  variables.tf         Configurable inputs
  outputs.tf           API URL and VM IP
  bootstrap.ps1        VM setup script (Bun, NSSM service, firewall)
datadrivenlibs/        DDC converter exe + DLLs (not in repo — bring your own)
```
