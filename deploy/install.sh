#!/usr/bin/env bash
# ============================================================================
# Установка Consul на чистый VPS с Ubuntu 22.04 / 24.04 или Debian 12.
#
#   curl -fsSL https://raw.githubusercontent.com/matveykapljr11-alt/consul/main/deploy/install.sh \
#     | sudo bash -s consul.example.com
#
# или, если репозиторий уже склонирован:
#   sudo bash deploy/install.sh consul.example.com
#
# Что делает: ставит Node и Caddy, заводит отдельного пользователя, кладёт код
# в /opt/consul, данные — в /var/lib/consul, поднимает systemd-сервис и
# выпускает HTTPS-сертификат. Повторный запуск ничего не ломает.
#
# Домен обязателен: Telegram открывает мини-апп только по https с настоящим
# сертификатом, самоподписанный не подойдёт. A-запись домена должна уже
# указывать на IP этого сервера.
# ============================================================================
set -euo pipefail

REPO="${CONSUL_REPO:-https://github.com/matveykapljr11-alt/consul.git}"
APP_DIR=/opt/consul
DATA_DIR=/var/lib/consul
SRV_DIR="$APP_DIR/consul-server"
USER=consul
DOMAIN="${1:-}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Запускать от root: sudo bash deploy/install.sh ваш-домен.ru"
[ -n "$DOMAIN" ] || die "Укажите домен: sudo bash deploy/install.sh consul.example.com"

say "Consul — установка на $DOMAIN"

# ---------------------------------------------------------------- пакеты
say "1/7 Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw >/dev/null
ok "базовые пакеты"

# ---------------------------------------------------------------- node
say "2/7 Node.js"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$MAJOR" -ge 18 ] 2>/dev/null && NODE_OK=1 && ok "уже стоит Node $(node -v)"
fi
if [ "$NODE_OK" = "0" ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "установлен Node $(node -v)"
fi

# ---------------------------------------------------------------- caddy
say "3/7 Caddy (HTTPS сам выпустит сертификат)"
if command -v caddy >/dev/null 2>&1; then
  ok "уже стоит"
else
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
  ok "установлен"
fi

# ---------------------------------------------------------------- код
say "4/7 Код и каталоги"
id -u "$USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$USER"
ok "пользователь $USER"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only -q && ok "код обновлён"
else
  rm -rf "$APP_DIR"
  git clone -q "$REPO" "$APP_DIR" && ok "код склонирован"
fi

install -d -o "$USER" -g "$USER" -m 0750 "$DATA_DIR"
chown -R "$USER:$USER" "$APP_DIR"
ok "данные в $DATA_DIR"

# ---------------------------------------------------------------- .env
say "5/7 Настройки"
ENV_FILE="$SRV_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$SRV_DIR/.env.example" "$ENV_FILE"
  {
    echo ""
    echo "PUBLIC_URL=https://$DOMAIN"
    echo "CONSUL_DATA_DIR=$DATA_DIR"
    echo "CONSUL_ENC_KEY=$(openssl rand -hex 32)"
    echo "PLATFORM_WEBHOOK_SECRET=$(openssl rand -hex 16)"
  } >> "$ENV_FILE"
  ok ".env создан, ключ шифрования сгенерирован"
  NEED_KEYS=1
else
  # адрес мог измениться, остальное не трогаем
  grep -q '^PUBLIC_URL=' "$ENV_FILE" || echo "PUBLIC_URL=https://$DOMAIN" >> "$ENV_FILE"
  grep -q '^CONSUL_DATA_DIR=' "$ENV_FILE" || echo "CONSUL_DATA_DIR=$DATA_DIR" >> "$ENV_FILE"
  ok ".env на месте, не трогаю"
  NEED_KEYS=0
fi
chown "$USER:$USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- systemd
say "6/7 Сервис"
cp "$APP_DIR/deploy/consul.service" /etc/systemd/system/consul.service
systemctl daemon-reload
systemctl enable -q consul
ok "systemd-юнит установлен"

# ---------------------------------------------------------------- caddy + firewall
say "7/7 HTTPS и firewall"
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ok "Caddy настроен на $DOMAIN"

ufw allow 22/tcp  >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
yes | ufw enable   >/dev/null 2>&1 || true
ok "открыты порты 22, 80, 443"

# ---------------------------------------------------------------- итог
if [ "$NEED_KEYS" = "1" ]; then
  say "Осталось вписать два ключа"
  cat <<EOF
  nano $ENV_FILE

  GROQ_API_KEY=   ключ с https://console.groq.com/keys
  BOT_TOKEN=      токен бота из @BotFather

  Потом:
    systemctl start consul
    cd $SRV_DIR && sudo -u $USER node setup.js

EOF
else
  systemctl restart consul
  sleep 2
  if curl -fsS --max-time 5 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    ok "сервис работает: https://$DOMAIN"
  else
    warn "сервис не отвечает, смотрите: journalctl -u consul -n 50 --no-pager"
  fi
  echo ""
fi
