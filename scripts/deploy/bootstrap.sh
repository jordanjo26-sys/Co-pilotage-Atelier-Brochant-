#!/usr/bin/env bash
# Mise en place / mise a jour du serveur (section 0 et 16 du cahier des
# charges). Concu pour etre rejoue sans risque a chaque deploiement :
# chaque etape verifie l'etat existant avant d'agir (paquets deja
# installes, base deja creee, .env deja present...). Execute par
# .github/workflows/deploy.yml apres synchronisation du code par rsync.
set -euo pipefail

APP_DIR="/opt/copilote-brochant"
APP_USER="copilote"
ENV_FILE="$APP_DIR/.env"

echo "== Paquets systeme =="
apt-get update -y
apt-get install -y curl git postgresql postgresql-contrib nginx poppler-utils ufw openssl rsync

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | grep -oE '^v[0-9]+' | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== Utilisateur applicatif dedie (jamais d'execution en root) =="
id -u "$APP_USER" >/dev/null 2>&1 || \
  useradd --system --create-home --shell /usr/sbin/nologin --home-dir "$APP_DIR" "$APP_USER"

echo "== Configuration (.env) =="
if [ ! -f "$ENV_FILE" ]; then
  DB_PASSWORD=$(openssl rand -hex 24)
  ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$ENV_FILE" <<EOF
DATABASE_URL="postgresql://copilote:${DB_PASSWORD}@localhost:5432/copilote_brochant"
PORT=3000
ENCRYPTION_KEY=${ENCRYPTION_KEY}
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
EOF
  echo "-- .env cree avec des secrets generes automatiquement (mot de passe base, cle de chiffrement)."
  echo "-- Completer GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI (voir docs/mise-en-service.md) puis relancer ce script ou 'systemctl restart copilote-brochant'."
else
  DB_PASSWORD=$(grep -oP '(?<=copilote:)[^@]+' "$ENV_FILE" | head -1)
fi

echo "== Base de donnees PostgreSQL =="
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='copilote'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER copilote WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='copilote_brochant'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE copilote_brochant OWNER copilote;"
sudo -u postgres psql -d copilote_brochant -c "GRANT ALL ON SCHEMA public TO copilote;" >/dev/null

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 "$ENV_FILE"

echo "== Dependances, build, migrations =="
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci
# npm ci declenche normalement "postinstall" -> "prisma generate", mais on le
# rejoue explicitement par securite : sans client Prisma genere, le serveur
# plante immediatement au demarrage (systemd le redemarre en boucle).
sudo -u "$APP_USER" npx prisma generate
sudo -u "$APP_USER" npm run build
sudo -u "$APP_USER" npx prisma migrate deploy

echo "== Service systemd =="
cp "$APP_DIR/scripts/deploy/copilote-brochant.service" /etc/systemd/system/copilote-brochant.service
systemctl daemon-reload
systemctl enable copilote-brochant
systemctl restart copilote-brochant

echo "== Reverse proxy nginx =="
cp "$APP_DIR/scripts/deploy/nginx-copilote-brochant.conf" /etc/nginx/sites-available/copilote-brochant
ln -sf /etc/nginx/sites-available/copilote-brochant /etc/nginx/sites-enabled/copilote-brochant
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "== Pare-feu =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== Deploiement termine =="
systemctl --no-pager status copilote-brochant || true
echo "== Derniers journaux applicatifs (diagnostic) =="
journalctl -u copilote-brochant --no-pager -n 100 || true
