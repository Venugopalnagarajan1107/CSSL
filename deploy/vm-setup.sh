#!/usr/bin/env bash
# =====================================================================
#  Always-on hosting on a free Linux VM (Ubuntu 22.04/24.04).
#  Run ON THE VM as a normal user with sudo:
#       bash deploy/vm-setup.sh yourname.duckdns.org
#  What it does: installs Node.js + Caddy (automatic free HTTPS), runs the app
#  as a locked-down service that restarts itself and starts on boot, opens only
#  ports 22/80/443, and keeps encrypted backups. Safe to run again to update.
# =====================================================================
set -euo pipefail
DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Usage: bash deploy/vm-setup.sh your-domain  (e.g. mysports.duckdns.org)"; exit 1; }
APP_SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR=/opt/tournament
DATA=/var/lib/tournament
ENVF=/etc/tournament.env

echo "==> Installing Node.js, Caddy and tools"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https rsync ufw
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "==> Installing the app into $APP_DIR"
id tournament >/dev/null 2>&1 || sudo useradd --system --home "$DATA" --shell /usr/sbin/nologin tournament
sudo mkdir -p "$APP_DIR" "$DATA"
sudo rsync -a --delete --exclude node_modules --exclude data --exclude test --exclude '*.zip' --exclude .git "$APP_SRC"/ "$APP_DIR"/
( cd "$APP_DIR" && sudo npm ci --omit=dev --no-audit --no-fund )
sudo chown -R tournament:tournament "$DATA"

if [ ! -f "$ENVF" ]; then
  echo "==> Creating the backup password (saved in $ENVF)"
  PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
  printf 'PORT=3000\nHOST=127.0.0.1\nDATA_DIR=%s\nBACKUP_PASSPHRASE=%s\n' "$DATA" "$PASS" | sudo tee "$ENVF" >/dev/null
  sudo chmod 600 "$ENVF"
  echo; echo "   BACKUP PASSWORD (write it down somewhere safe): $PASS"; echo
fi

echo "==> Setting up the service"
sudo tee /etc/systemd/system/tournament.service >/dev/null <<UNIT
[Unit]
Description=Tournament app
After=network.target
[Service]
User=tournament
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENVF
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA
LimitNOFILE=65535
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now tournament
sudo systemctl restart tournament

echo "==> HTTPS with Caddy for $DOMAIN"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
$DOMAIN {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
CADDY
sudo systemctl reload caddy || sudo systemctl restart caddy

echo "==> Firewall (only SSH, HTTP, HTTPS)"
sudo ufw allow OpenSSH >/dev/null; sudo ufw allow 80/tcp >/dev/null; sudo ufw allow 443/tcp >/dev/null
sudo ufw --force enable >/dev/null

sleep 3
echo
echo "=============================================================="
echo "  Done. Open:  https://$DOMAIN"
echo "  (If the page does not load, check that $DOMAIN points to this VM's public IP,"
echo "   and that the cloud provider's firewall allows ports 80 and 443.)"
PIN="$(sudo journalctl -u tournament --no-pager 2>/dev/null | grep -o 'Admin PIN *: *[0-9]*' | tail -1 || true)"
[ -n "$PIN" ] && echo "  $PIN   (first start only – change it in Admin > Setup)"
echo "  Update later:   bash deploy/vm-setup.sh $DOMAIN   (your data is kept)"
echo "  Logs:           sudo journalctl -u tournament -f"
echo "  Forgot PIN:     sudo -u tournament env \$(sudo cat $ENVF | xargs) node $APP_DIR/server.js --reset-pin"
echo "=============================================================="
