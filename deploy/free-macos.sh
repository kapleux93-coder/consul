#!/usr/bin/env bash
# ============================================================================
# Бесплатный запуск Consul на своём Mac.
#
#   bash deploy/free-macos.sh ваш-поддомен.ngrok-free.app
#
# Ставит две фоновые службы через launchd: сам сервер и туннель ngrok.
# Обе поднимаются после перезагрузки и перезапускаются, если упали.
#
# Почему это работает бесплатно:
#   • боту публичный адрес не нужен — он забирает сообщения опросом Telegram,
#     поэтому клиенты получают ответы, даже когда туннель лежит;
#   • адрес нужен только чтобы открывать вашу панель из Telegram, а это
#     редкие короткие заходы — в лимиты бесплатного ngrok укладываются.
#
# Что нужно заранее:
#   1. brew install ngrok
#   2. Зарегистрироваться на ngrok.com (бесплатно, без карты),
#      выполнить: ngrok config add-authtoken <ваш токен>
#   3. В панели ngrok → Domains забрать бесплатный статический поддомен.
# ============================================================================
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRV_DIR="$APP_DIR/consul-server"
ENV_FILE="$SRV_DIR/.env"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/consul"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

[ -n "$DOMAIN" ] || die "Укажите свой поддомен: bash deploy/free-macos.sh consul-abc.ngrok-free.app"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"

command -v node >/dev/null || die "Нет Node. Поставьте: brew install node"
command -v ngrok >/dev/null || die "Нет ngrok. Поставьте: brew install ngrok"
[ -f "$ENV_FILE" ] || die "Нет $ENV_FILE — сначала: cp $SRV_DIR/.env.example $ENV_FILE и впишите ключи"

grep -q '^GROQ_API_KEY=.\+' "$ENV_FILE" || die "В .env пустой GROQ_API_KEY"
grep -q '^BOT_TOKEN=.\+'    "$ENV_FILE" || die "В .env пустой BOT_TOKEN"

say "Consul — бесплатный запуск на https://$DOMAIN"

# ---------------------------------------------------------------- .env
say "1/4 Настройки"
set_env() {
  local key="$1" val="$2"
  if grep -q "^$key=" "$ENV_FILE"; then
    # macOS sed требует пустой суффикс у -i
    sed -i '' "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
set_env PUBLIC_URL "https://$DOMAIN"
set_env FORCE_POLLING 1
grep -q '^CONSUL_ENC_KEY=.\+' "$ENV_FILE" || set_env CONSUL_ENC_KEY "$(openssl rand -hex 32)"
chmod 600 "$ENV_FILE"
ok "адрес и режим опроса записаны в .env"

mkdir -p "$LOGS" "$LA"

# ---------------------------------------------------------------- сервер
say "2/4 Служба сервера"
cat > "$LA/com.consul.server.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.consul.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$SRV_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$SRV_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.log</string>
</dict></plist>
PLIST
launchctl unload "$LA/com.consul.server.plist" 2>/dev/null || true
launchctl load "$LA/com.consul.server.plist"
ok "com.consul.server"

# ---------------------------------------------------------------- туннель
say "3/4 Служба туннеля"
cat > "$LA/com.consul.tunnel.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.consul.tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v ngrok)</string>
    <string>http</string>
    <string>--url=$DOMAIN</string>
    <string>8080</string>
    <string>--log=stdout</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOGS/tunnel.log</string>
</dict></plist>
PLIST
launchctl unload "$LA/com.consul.tunnel.plist" 2>/dev/null || true
launchctl load "$LA/com.consul.tunnel.plist"
ok "com.consul.tunnel"

# ---------------------------------------------------------------- проверка
say "4/4 Проверка"
sleep 4
if curl -fsS --max-time 5 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  ok "сервер отвечает на localhost:8080"
else
  warn "сервер молчит — смотрите $LOGS/server.log"
fi
if curl -fsS --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then
  ok "туннель работает: https://$DOMAIN"
else
  warn "снаружи недоступно — смотрите $LOGS/tunnel.log (часто: не добавлен authtoken)"
fi

cat <<EOF

  Осталось:
    cd $SRV_DIR && node setup.js
    В @BotFather укажите Web App URL: https://$DOMAIN

  Управление:
    Логи        tail -f $LOGS/server.log
    Стоп        launchctl unload $LA/com.consul.server.plist
    Старт       launchctl load $LA/com.consul.server.plist

  Важно: пока Mac спит, панель недоступна, но бот продолжит отвечать
  клиентам, как только машина проснётся — сообщения забираются опросом
  и не теряются. Чтобы не засыпал: Системные настройки → Экономия энергии.

EOF
