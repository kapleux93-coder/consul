# Consul

Telegram mini app: превращает вашего бота в AI-менеджера. Он отвечает клиентам
по вашим материалам, собирает контакты и передаёт сложные диалоги живому человеку.

* `consul.html` — само приложение, один файл. Без сервера открывается как демо.
* `consul-server/` — бэкенд: подключение бота, ответы через Groq, передача менеджерам.

Запуск и деплой — в [consul-server/README.md](consul-server/README.md).

## Быстро

```bash
cd consul-server
cp .env.example .env      # вписать GROQ_API_KEY и BOT_TOKEN
npm run setup
npm start
```

Тесты: `cd consul-server && npm test` (119 тестов, без сети).
