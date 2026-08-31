#!/usr/bin/env bash
# Обновление на VPS: забрать код и перезапустить.
#   sudo bash /opt/consul/deploy/update.sh
set -euo pipefail
cd /opt/consul
git pull --ff-only
chown -R consul:consul /opt/consul
systemctl restart consul
sleep 2
systemctl --no-pager --lines=15 status consul || true
curl -fsS --max-time 5 http://127.0.0.1:8080/health && echo " — сервис отвечает"
