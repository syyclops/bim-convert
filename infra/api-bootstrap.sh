#!/bin/bash
set -eo pipefail

export HOME="/root"
export DEBIAN_FRONTEND=noninteractive

DOMAIN="$1"
STORAGE_CONNECTION_STRING="$2"
QUEUE_NAME="$3"
WORKER_VM_NAME="$4"
RESOURCE_GROUP="$5"
SUBSCRIPTION_ID="$6"

LOG="/var/log/bim-convert-setup.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG"; }

APP_DIR="/opt/bim-convert"

log "Starting BIM Convert API setup..."

# Prerequisites
log "Installing prerequisites..."
apt-get update -qq
apt-get install -y -qq unzip curl

# Install Bun
if ! command -v bun &>/dev/null; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
log "Bun: $(bun --version)"

# Install Caddy
if ! command -v caddy &>/dev/null; then
  log "Installing Caddy..."
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi
log "Caddy: $(caddy version)"

# Install Azure CLI
if ! command -v az &>/dev/null; then
  log "Installing Azure CLI..."
  curl -sL https://aka.ms/InstallAzureCLIDeb | bash
fi
log "Azure CLI: $(az version --query '\"azure-cli\"' -o tsv)"

# Extract app
log "Extracting app.zip..."
mkdir -p "$APP_DIR"
unzip -o app.zip -d "$APP_DIR"

# Install dependencies
log "Installing dependencies..."
cd "$APP_DIR"
bun install --production

# Write env file
log "Writing .env..."
cat > "$APP_DIR/.env" <<EOF
BIM_ENV=production
AZURE_STORAGE_CONNECTION_STRING=${STORAGE_CONNECTION_STRING}
QUEUE_NAME=${QUEUE_NAME}
WORKER_VM_NAME=${WORKER_VM_NAME}
AZURE_RESOURCE_GROUP=${RESOURCE_GROUP}
AZURE_SUBSCRIPTION_ID=${SUBSCRIPTION_ID}
PORT=8000
EOF

# Write Caddyfile
log "Writing Caddyfile for domain: $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy localhost:8000
}
EOF

# Create systemd service
log "Creating systemd service..."
cat > /etc/systemd/system/bim-convert.service <<EOF
[Unit]
Description=BIM Convert API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/local/bin/bun run ${APP_DIR}/server.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bim-convert
systemctl restart bim-convert
systemctl restart caddy

# Firewall
log "Configuring firewall..."
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

log "Setup complete! API available at https://$DOMAIN"
