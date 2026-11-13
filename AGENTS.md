# AGENTS.md

Нейросотрудник в Telegram: бот на сервере принимает задачи и запускает облачную задачу Claude Code (API-триггер); работу и ответы в чат делает облачная сессия по `ROUTINE_PROMPT.md`. Node 22, без зависимостей, ESM.

- `src/index.mjs` — сообщения, кнопки, `parsePlan` (формат первой строки плана задан в `ROUTINE_PROMPT.md`, менять вместе); `src/routine.mjs` — запуск сессии с повторами; `src/telegram.mjs` — Bot API; `src/config.mjs` — переменные окружения.
- Проверка: `npm run check`. Деплой: `.github/workflows/deploy.yml`.
- Секреты не коммитить. Force-push запрещён.
