// Нейросотрудники: один процесс обслуживает несколько Telegram-ботов.
// Сервер только принимает сообщения и кнопки; код, проверки, публикацию и ответы в чат
// делает облачная сессия Claude Code своего сотрудника (см. ROUTINE_PROMPT.md).
import { employees } from './config.mjs';
import { runEmployee } from './employee.mjs';

if (!employees.length) {
  console.error('Нет ни одного сотрудника: задайте TELEGRAM_BOT_TOKEN + ROUTINE_* или BOT_EMPLOYEES');
  process.exit(1);
}
console.log(`Сотрудников: ${employees.length} (${employees.map((e) => e.name).join(', ')})`);

// Сбой одного бота (например, неверный токен) не останавливает остальных: перезапуск через минуту.
for (const emp of employees) {
  (async function loop() {
    for (;;) {
      try {
        await runEmployee(emp);
      } catch (e) {
        console.error(`[${emp.name}] остановлен: ${e.message}; перезапуск через 60 с`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  })();
}
