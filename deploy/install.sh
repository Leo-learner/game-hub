#!/usr/bin/env bash
set -Eeuo pipefail
release="$1"
commit="$2"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "Invalid release identifier" >&2; exit 1; }
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid commit identifier" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run installer through sudo" >&2; exit 1; }
base=/opt/apps/game-hub
dest="$base/releases/$release"
archive="/tmp/game-hub-$release.tar.gz"
previous=""
if [ -L "$base/current" ]; then previous=$(readlink -f "$base/current"); fi
if [ ! -e "$base/current" ] && ss -ltnH | awk '{print $4}' | grep -q ':3220$'; then
    echo "Port 3220 is occupied; refusing to replace another service" >&2; exit 1
fi
[ "$(node -p 'process.versions.node.split(".")[0]')" -eq 22 ] || { echo "Node.js 22 required" >&2; exit 1; }
if [ ! -f /etc/systemd/system/game-hub-mcp.service ] && ss -ltnH | awk '{print $4}' | grep -q ':3221$'; then
    echo "Port 3221 is occupied; refusing to replace another service" >&2; exit 1
fi
id gamehub >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/game-hub --shell /usr/sbin/nologin gamehub
install -d -o gamehub -g www-data -m 2750 /var/lib/game-hub
install -d -o root -g root -m 755 "$base/releases" "$base/frontend"
mkdir "$dest"
tar -xzf "$archive" -C "$dest" --no-same-owner
[ "$(node -p "JSON.parse(require('fs').readFileSync('$dest/RELEASE.json','utf8')).commit")" = "$commit" ] || { echo "Archive commit mismatch" >&2; exit 1; }
chown -R gamehub:www-data "$dest"
cd "$dest"
runuser -u gamehub -g www-data -G gamehub -- npm ci --omit=dev --no-audit --no-fund
runuser -u gamehub -g www-data -G gamehub -- node --input-type=module -e 'import Database from "better-sqlite3"; import argon2 from "argon2"; const db=new Database(":memory:");db.close();await argon2.hash("runtime-self-check",{memoryCost:19456,timeCost:2,parallelism:1});console.log("Linux native dependencies verified");'
chown -R root:root "$dest"
if [ ! -f /etc/game-hub.env ]; then
    cat > /etc/game-hub.env <<'ENV'
NODE_ENV=production
HOST=127.0.0.1
PORT=3220
PUBLIC_ORIGIN=https://games.dkz12345.com
DATA_DIR=/var/lib/game-hub
PUBLIC_DIR=/opt/apps/game-hub/frontend
COOKIE_SECURE=true
TRUST_PROXY=true
X_ACCEL_REDIRECT=true
ALLOW_REGISTRATION=true
API_DOCS=true
SPA_FALLBACK=false
LOG_LEVEL=info
ENV
    chown root:gamehub /etc/game-hub.env
    chmod 640 /etc/game-hub.env
fi
if [ ! -f "$base/frontend/index.html" ]; then install -m 644 "$dest/public/index.html" "$base/frontend/index.html"; fi
if [ -n "$previous" ] && [ -f /var/lib/game-hub/game-hub.sqlite ]; then
    cd "$previous"
    runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js backup
fi
switched=0
stopped=0
rollback() {
    if [ -n "$previous" ]; then
        if [ "$switched" -eq 1 ]; then
            ln -s "$previous" "$base/current.rollback"
            mv -Tf "$base/current.rollback" "$base/current"
        fi
        if [ "$stopped" -eq 1 ]; then systemctl restart game-hub || true; fi
        if [ -f "$previous/dist/src/mcp/server.js" ]; then
            systemctl restart game-hub-mcp || true
        else
            systemctl stop game-hub-mcp || true
        fi
        if [ -f "$base/nginx-before-$release.conf" ]; then
            cp "$base/nginx-before-$release.conf" /etc/nginx/sites-available/games.dkz12345.com
            nginx -t && systemctl reload nginx || true
        fi
        echo "Application symlink restored; inspect database compatibility before further changes." >&2
    fi
}
trap rollback ERR
if systemctl is-active --quiet game-hub-mcp; then systemctl stop game-hub-mcp; fi
if systemctl is-active --quiet game-hub; then systemctl stop game-hub; stopped=1; fi
cd "$dest"
runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/admin.js migrate
runuser -u gamehub -g www-data -G gamehub -- node --env-file=/etc/game-hub.env dist/scripts/mcp-admin.js migrate
install -o root -g root -m 755 deploy/game-hub-control /usr/local/sbin/game-hub-control
visudo -cf deploy/game-hub-mcp.sudoers
install -o root -g root -m 440 deploy/game-hub-mcp.sudoers /etc/sudoers.d/game-hub-mcp
install -m 644 deploy/game-hub.service /etc/systemd/system/game-hub.service
install -m 644 deploy/game-hub-mcp.service /etc/systemd/system/game-hub-mcp.service
install -m 644 deploy/game-hub-backup.service /etc/systemd/system/game-hub-backup.service
install -m 644 deploy/game-hub-backup.timer /etc/systemd/system/game-hub-backup.timer
ln -s "$dest" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
switched=1
systemctl daemon-reload
systemctl enable --now game-hub
systemctl enable --now game-hub-mcp
for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3220/readyz >/dev/null; then break; fi
    sleep 1
done
curl -fsS http://127.0.0.1:3220/readyz
for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3221/healthz >/dev/null; then break; fi
    sleep 1
done
curl -fsS http://127.0.0.1:3221/healthz
install -d -m 755 /var/www/letsencrypt
if [ ! -f /etc/letsencrypt/live/games.dkz12345.com/fullchain.pem ]; then
    if [ -e /etc/nginx/sites-enabled/games.dkz12345.com ]; then
        echo "Existing domain configuration requires review before initial certificate setup" >&2; exit 1
    fi
    cat > /etc/nginx/sites-available/games.dkz12345.com <<'HTTP'
server {
    listen 80;
    listen [::]:80;
    server_name games.dkz12345.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 503; }
}
HTTP
    ln -s /etc/nginx/sites-available/games.dkz12345.com /etc/nginx/sites-enabled/games.dkz12345.com
    nginx -t
    systemctl reload nginx
    certbot certonly --webroot -w /var/www/letsencrypt -d games.dkz12345.com --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring
fi
if [ -f /etc/nginx/sites-available/games.dkz12345.com ]; then
    cp -p /etc/nginx/sites-available/games.dkz12345.com "$base/nginx-before-$release.conf"
fi
install -m 644 "$dest/deploy/nginx.conf" /etc/nginx/sites-available/games.dkz12345.com
ln -sfn /etc/nginx/sites-available/games.dkz12345.com /etc/nginx/sites-enabled/games.dkz12345.com
if ! nginx -t; then
    if [ -f "$base/nginx-before-$release.conf" ]; then cp "$base/nginx-before-$release.conf" /etc/nginx/sites-available/games.dkz12345.com; fi
    rollback
    exit 1
fi
systemctl reload nginx
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -m 755 "$dest/deploy/renew-certificate.sh" /etc/letsencrypt/renewal-hooks/deploy/game-hub-nginx
systemctl enable --now game-hub-backup.timer
curl --resolve games.dkz12345.com:443:127.0.0.1 -fsS https://games.dkz12345.com/readyz
curl --resolve games.dkz12345.com:443:127.0.0.1 -fsS https://games.dkz12345.com/mcp/healthz
rm -f "$archive"
echo
echo "Deployed release $release"
