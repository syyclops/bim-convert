param(
    [string]$StorageConnectionString,
    [string]$QueueName,
    [string]$VMName,
    [string]$ResourceGroup,
    [string]$SubscriptionId,
    [int]$IdleTimeoutMinutes = 15
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$logFile = "C:\bim-convert-setup.log"

function Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp - $Message" | Tee-Object -FilePath $logFile -Append
}

Log "Starting BIM Convert Worker setup..."

$appDir = "C:\bim-convert"
$bunDir = "C:\bun"
$bunExe = "$bunDir\bun.exe"
$nssmDir = "C:\nssm"
$nssmExe = "$nssmDir\nssm-2.24\win64\nssm.exe"

# Stop existing services if running
if (Test-Path $nssmExe) {
    Log "Stopping existing services..."
    try { & $nssmExe stop BIMConvertWorker } catch {}
    try { & $nssmExe remove BIMConvertWorker confirm } catch {}
    Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path "$appDir\temp" -Force | Out-Null
New-Item -ItemType Directory -Path $bunDir -Force | Out-Null

# Extract app files
Log "Extracting app.zip..."
Expand-Archive -Path ".\app.zip" -DestinationPath $appDir -Force

# Extract datadrivenlibs
Log "Extracting datadrivenlibs..."
Expand-Archive -Path ".\datadrivenlibs.zip" -DestinationPath $appDir -Force

# Install VC++ Redistributable (skip if already installed)
$vcInstalled = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" -ErrorAction SilentlyContinue
if (-not $vcInstalled) {
    Log "Installing VC++ Redistributable..."
    $vcRedistPath = "$env:TEMP\vc_redist.x64.exe"
    Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $vcRedistPath
    Start-Process -FilePath $vcRedistPath -ArgumentList "/install", "/quiet", "/norestart" -Wait
    Log "VC++ Redistributable installed."
} else {
    Log "VC++ Redistributable already installed, skipping."
}

# Install Bun (skip if already present)
if (-not (Test-Path $bunExe)) {
    Log "Installing Bun..."
    $bunZip = "$env:TEMP\bun.zip"
    Invoke-WebRequest -Uri "https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip" -OutFile $bunZip
    Expand-Archive -Path $bunZip -DestinationPath "$env:TEMP\bun-extract" -Force
    Copy-Item -Path "$env:TEMP\bun-extract\bun-windows-x64\*" -Destination $bunDir -Force
    Log "Bun installed."
} else {
    Log "Bun already installed, skipping."
}

if (-not (Test-Path $bunExe)) {
    Log "ERROR: bun.exe not found at $bunExe"
    exit 1
}

# Install Azure CLI (for managed identity VM operations)
$azPath = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd"
if (-not (Test-Path $azPath)) {
    Log "Installing Azure CLI..."
    $azCliMsi = "$env:TEMP\AzureCLI.msi"
    Invoke-WebRequest -Uri "https://aka.ms/installazurecliwindowsx64" -OutFile $azCliMsi
    Start-Process msiexec.exe -ArgumentList "/I", $azCliMsi, "/quiet" -Wait
    Log "Azure CLI installed."
} else {
    Log "Azure CLI already installed, skipping."
}

# Install npm dependencies
Log "Installing dependencies..."
Set-Location $appDir
& $bunExe install --production

# Install NSSM (skip if already present)
if (-not (Test-Path $nssmExe)) {
    Log "Installing NSSM..."
    $nssmZip = "$env:TEMP\nssm.zip"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip
    Expand-Archive -Path $nssmZip -DestinationPath $nssmDir -Force
    Log "NSSM installed."
} else {
    Log "NSSM already installed, skipping."
}

# Write env file
Log "Writing .env..."
$idleShutdownMs = $IdleTimeoutMinutes * 60 * 1000
@"
BIM_ENV=production
AZURE_STORAGE_CONNECTION_STRING=$StorageConnectionString
QUEUE_NAME=$QueueName
WORKER_VM_NAME=$VMName
AZURE_RESOURCE_GROUP=$ResourceGroup
AZURE_SUBSCRIPTION_ID=$SubscriptionId
IDLE_SHUTDOWN_MS=$idleShutdownMs
CONVERTER_CMD=RVT2IFCconverter.exe
CONVERTER_DIR=$appDir\datadrivenlibs
"@ | Set-Content -Path "$appDir\.env" -Force

# Create BIMConvertWorker service
Log "Creating BIMConvertWorker service..."
& $nssmExe install BIMConvertWorker $bunExe "run" "$appDir\worker.ts"
& $nssmExe set BIMConvertWorker AppDirectory $appDir
& $nssmExe set BIMConvertWorker DisplayName "BIM Convert Worker"
& $nssmExe set BIMConvertWorker Description "RVT to IFC conversion worker"
& $nssmExe set BIMConvertWorker Start SERVICE_AUTO_START
& $nssmExe set BIMConvertWorker AppStdout "$appDir\worker-stdout.log"
& $nssmExe set BIMConvertWorker AppStderr "$appDir\worker-stderr.log"

Log "Starting BIMConvertWorker service..."
& $nssmExe start BIMConvertWorker

Log "Worker setup complete!"
