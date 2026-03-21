param(
    [string]$Domain
)

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
$caddyDir = "C:\caddy"
$caddyExe = "$caddyDir\caddy.exe"
$nssmDir = "C:\nssm"
$nssmExe = "$nssmDir\nssm-2.24\win64\nssm.exe"

# Stop existing services if running (so we can overwrite files)
if (Test-Path $nssmExe) {
    Log "Stopping existing services..."
    try { & $nssmExe stop BIMConvert } catch {}
    try { & $nssmExe remove BIMConvert confirm } catch {}
    try { & $nssmExe stop Caddy } catch {}
    try { & $nssmExe remove Caddy confirm } catch {}
    Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
New-Item -ItemType Directory -Path "$appDir\temp" -Force | Out-Null
New-Item -ItemType Directory -Path $bunDir -Force | Out-Null
New-Item -ItemType Directory -Path $caddyDir -Force | Out-Null

# Copy app files
Log "Copying app files..."
Copy-Item -Path ".\server.ts" -Destination "$appDir\server.ts" -Force
Copy-Item -Path ".\index.html" -Destination "$appDir\index.html" -Force

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

# Install Caddy (skip if already present)
if (-not (Test-Path $caddyExe)) {
    Log "Installing Caddy..."
    $caddyZip = "$env:TEMP\caddy.zip"
    Invoke-WebRequest -Uri "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_windows_amd64.zip" -OutFile $caddyZip
    Expand-Archive -Path $caddyZip -DestinationPath $caddyDir -Force
    Log "Caddy installed."
} else {
    Log "Caddy already installed, skipping."
}

# Write Caddyfile
Log "Writing Caddyfile for domain: $Domain"
@"
$Domain {
    reverse_proxy localhost:8000
}
"@ | Set-Content -Path "$caddyDir\Caddyfile" -Force

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

# Create BIMConvert service
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

# Create Caddy service
Log "Creating Caddy service..."
& $nssmExe install Caddy $caddyExe "run" "--config" "$caddyDir\Caddyfile"
& $nssmExe set Caddy AppDirectory $caddyDir
& $nssmExe set Caddy DisplayName "Caddy Reverse Proxy"
& $nssmExe set Caddy Description "HTTPS reverse proxy for BIM Convert API"
& $nssmExe set Caddy Start SERVICE_AUTO_START
& $nssmExe set Caddy AppStdout "$caddyDir\caddy-stdout.log"
& $nssmExe set Caddy AppStderr "$caddyDir\caddy-stderr.log"

Log "Starting Caddy service..."
& $nssmExe start Caddy

# Open firewall
$rules = @(
    @{ Name = "BIM Convert HTTPS"; Port = 443 },
    @{ Name = "BIM Convert HTTP"; Port = 80 }
)
foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if (-not $existing) {
        Log "Opening firewall port $($rule.Port)..."
        New-NetFirewallRule -DisplayName $rule.Name -Direction Inbound -LocalPort $rule.Port -Protocol TCP -Action Allow
    }
}

Log "Setup complete! API available at https://$Domain"
