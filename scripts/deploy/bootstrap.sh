#!/usr/bin/env bash
# Mise en place / mise a jour du serveur (section 0 et 16 du cahier des
# charges). Concu pour etre rejoue sans risque a chaque deploiement :
# chaque etape verifie l'etat existant avant d'agir (paquets deja
# installes, base deja creee, .env deja present...). Execute par
# .github/workflows/deploy.yml apres synchronisation du code par rsync.
set -euo pipefail

# Identifiants OAuth Google, transmis en argument (jamais commis dans le
# depot ni ecrits dans les journaux) : voir .github/workflows/deploy.yml,
# qui les passe depuis les secrets GitHub GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.
GOOGLE_CLIENT_ID_ARG="${1:-}"
GOOGLE_CLIENT_SECRET_ARG="${2:-}"

APP_DIR="/opt/copilote-brochant"
APP_USER="copilote"
ENV_FILE="$APP_DIR/.env"
DOMAIN="copilotage-brochant.fr"
WWW_DOMAIN="www.copilotage-brochant.fr"
ADMIN_EMAIL="jordan.jo26@icloud.com"
CERTBOT_WEBROOT="$APP_DIR/certbot-webroot"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
# Transfert automatique des factures vers Dext : "false" = en pause (mis en
# place a la demande de l'utilisateur le temps d'observer prudemment le
# systeme sur le mois de septembre) — repasser a "true" ici puis redeployer
# pour reactiver l'envoi automatique.
DEXT_AUTO_FORWARD="false"

echo "== Paquets systeme =="
apt-get update -y
apt-get install -y curl git postgresql postgresql-contrib nginx poppler-utils ufw openssl rsync certbot

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
DEXT_AUTO_FORWARD=${DEXT_AUTO_FORWARD}
EOF
  echo "-- .env cree avec des secrets generes automatiquement (mot de passe base, cle de chiffrement)."
  echo "-- Completer GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (voir docs/mise-en-service.md) puis relancer ce script ou 'systemctl restart copilote-brochant'."
else
  DB_PASSWORD=$(grep -oP '(?<=copilote:)[^@]+' "$ENV_FILE" | head -1)
fi

# GOOGLE_REDIRECT_URI depend uniquement du domaine (pas un secret) : on peut
# le renseigner automatiquement des que le nom de domaine est connu.
if grep -q '^GOOGLE_REDIRECT_URI=$' "$ENV_FILE" 2>/dev/null; then
  sed -i "s#^GOOGLE_REDIRECT_URI=.*#GOOGLE_REDIRECT_URI=https://${DOMAIN}/auth/google/callback#" "$ENV_FILE"
fi

# Interrupteur de transfert automatique vers Dext (pas un secret, controle
# depuis ce script) : "false" pour observer prudemment le systeme avant de
# reactiver l'envoi automatique. Mis a jour a chaque deploiement pour
# refleter la valeur voulue ici, meme sur un .env deja existant.
if grep -q '^DEXT_AUTO_FORWARD=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s#^DEXT_AUTO_FORWARD=.*#DEXT_AUTO_FORWARD=${DEXT_AUTO_FORWARD}#" "$ENV_FILE"
else
  echo "DEXT_AUTO_FORWARD=${DEXT_AUTO_FORWARD}" >> "$ENV_FILE"
fi

# Identifiants OAuth Google : mis a jour a chaque deploiement si transmis
# (permet aussi de les faire tourner plus tard en changeant simplement le
# secret GitHub, sans toucher au serveur a la main).
if [ -n "$GOOGLE_CLIENT_ID_ARG" ]; then
  sed -i "s#^GOOGLE_CLIENT_ID=.*#GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID_ARG}#" "$ENV_FILE"
fi
if [ -n "$GOOGLE_CLIENT_SECRET_ARG" ]; then
  sed -i "s#^GOOGLE_CLIENT_SECRET=.*#GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET_ARG}#" "$ENV_FILE"
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

echo "== Reverse proxy nginx (HTTP, provisoire tant qu'aucun certificat n'existe) =="
mkdir -p "$CERTBOT_WEBROOT"
# Conf HTTP minimale : necessaire avant meme d'avoir un certificat, a la fois
# pour servir l'appli en attendant et pour repondre au defi HTTP de Let's
# Encrypt (chemin /.well-known/acme-challenge/) lors de la toute premiere
# demande de certificat ci-dessous.
cat > /etc/nginx/sites-available/copilote-brochant <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${DOMAIN} ${WWW_DOMAIN} _;

    client_max_body_size 25M;

    location /.well-known/acme-challenge/ {
        root ${CERTBOT_WEBROOT};
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/copilote-brochant /etc/nginx/sites-enabled/copilote-brochant
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "== Certificat HTTPS (Let's Encrypt) =="
# www n'est inclus dans le certificat que si son DNS pointe deja vers ce
# serveur (sinon le defi ACME echouerait pour ce nom et ferait echouer toute
# la demande, y compris pour le domaine principal). --expand permet
# d'ajouter www au certificat existant plus tard, des que son DNS sera bon,
# sans intervention manuelle : ce bloc est rejoue a chaque deploiement et
# certbot ne fait rien si le certificat couvre deja les bons noms et n'est
# pas proche de l'expiration (pas de risque de heurter les limites de taux).
MY_IP=$(curl -fs -4 https://ifconfig.me || true)
WWW_IP=$(getent hosts "$WWW_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)
CERT_DOMAINS=(-d "$DOMAIN")
if [ -n "$MY_IP" ] && [ "$WWW_IP" = "$MY_IP" ]; then
  CERT_DOMAINS+=(-d "$WWW_DOMAIN")
else
  echo "-- www.${DOMAIN} ne pointe pas encore vers ce serveur (DNS: ${WWW_IP:-aucun}, attendu: ${MY_IP:-inconnu}) : exclu du certificat pour l'instant."
fi
certbot certonly --webroot -w "$CERTBOT_WEBROOT" "${CERT_DOMAINS[@]}" --expand \
  --non-interactive --agree-tos -m "$ADMIN_EMAIL" --no-eff-email \
  || echo "-- Echec de l'obtention du certificat (DNS pas encore propage ?). L'appli reste servie en HTTP, on reessaiera au prochain deploiement."

echo "== Reverse proxy nginx (HTTPS si le certificat est disponible) =="
if [ -f "$CERT_DIR/fullchain.pem" ]; then
  cat > /etc/nginx/sites-available/copilote-brochant <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${DOMAIN} ${WWW_DOMAIN} _;

    location /.well-known/acme-challenge/ {
        root ${CERTBOT_WEBROOT};
    }

    location / {
        return 301 https://${DOMAIN}\$request_uri;
    }
}

server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    ssl_certificate ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;

    client_max_body_size 25M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  nginx -t
  systemctl reload nginx
fi

echo "== Pare-feu =="
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== Deploiement termine =="
systemctl --no-pager status copilote-brochant || true
echo "== Derniers journaux applicatifs (diagnostic) =="
journalctl -u copilote-brochant --no-pager -n 100 || true
