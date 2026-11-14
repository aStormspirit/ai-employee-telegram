# AGENTS.md

Нейросотрудники в Telegram: один процесс на сервере обслуживает несколько ботов. Бот принимает сообщения и кнопки и запускает облачную задачу Claude Code (API-триггер); работу и ответы в чат делает облачная сессия по `ROUTINE_PROMPT.md` и скиллу `.claude/skills/task`. Node 22, без зависимостей, ESM.

- `src/index.mjs` — запуск всех сотрудников; `src/config.mjs` — сотрудники из env / `BOT_EMPLOYEES`, проверка непересечения чатов и токенов; `src/employee.mjs` — бот одного сотрудника: сообщения, картинки, кнопки, `/task`, `parsePlan` (формат первой строки плана задан в скилле task — менять вместе); `src/routine.mjs` — запуск облачной сессии с повторами; `src/telegram.mjs` — Bot API.
- `employees.yml` + `scripts/employees.py` — при деплое собирают `BOT_EMPLOYEES` из файла и секретов (`ENV_FILE` или отдельных), маскируют токены в логе.
- Проверка: `npm run check`. Деплой: `.github/workflows/deploy.yml`.
- Секреты не коммитить. Force-push запрещён.
