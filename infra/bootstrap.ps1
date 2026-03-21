$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$logFile = "C:\bim-convert-setup.log"

function Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$timestamp - $Message" | Tee-Object -FilePath $logFile -Append
}

Log "Starting BIM Convert setup..."

$appDir = "C:\bim-convert"
$bunDir = "C:\bun"
$bunExe = "$bunDir\bun.exe"
$nssmDir = "C:\nssm"
$nssmExe = "$nssmDir\nssm-2.24\win64\nssm.exe"

# Stop existing service if running (so we can overwrite files)
if (Test-Path $nssmExe) {
    Log "Stopping existing BIMConvert service..."
    & $nssmExe stop BIMConvert 2>$null
    & $nssmExe remove BIMConvert confirm 2>$null
    Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path "$appDir\temp" -Force | Out-Null
New-Item -ItemType Directory -Path $bunDir -Force | Out-Null

# Copy server.ts
Log "Copying server.ts..."
Copy-Item -Path ".\server.ts" -Destination "$appDir\server.ts" -Force

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

# Install Bun (skip if already present and correct)
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

# Create and start Windows service
Log "Creating BIMConvert service..."
& $nssmExe install BIMConvert $bunExe "run" "$appDir\server.ts"
& $nssmExe set BIMConvert AppDirectory $appDir
& $nssmExe set BIMConvert DisplayName "BIM Convert API"
& $nssmExe set BIMConvert Description "RVT to IFC conversion API"
& $nssmExe set BIMConvert Start SERVICE_AUTO_START
& $nssmExe set BIMConvert AppStdout "$appDir\service-stdout.log"
& $nssmExe set BIMConvert AppStderr "$appDir\service-stderr.log"

Log "Starting BIMConvert service..."
& $nssmExe start BIMConvert

# Open firewall (ignore if rule already exists)
$existingRule = Get-NetFirewallRule -DisplayName "BIM Convert API" -ErrorAction SilentlyContinue
if (-not $existingRule) {
    Log "Opening firewall port 8000..."
    New-NetFirewallRule -DisplayName "BIM Convert API" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
} else {
    Log "Firewall rule already exists, skipping."
}

Log "Setup complete! API should be available on port 8000."
