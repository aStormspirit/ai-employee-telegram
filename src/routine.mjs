// Запуск облачной сессии Claude Code через API-триггер облачной задачи (routine).
// Работа идёт на подписке владельца в облаке Anthropic, сервер только передаёт задачу.
import { config } from './config.mjs';

/**
 * Создаёт новую облачную сессию. `fields` превращаются в текст вида «KEY: value»,
 * который разбирает промпт облачной задачи (ROUTINE_PROMPT.md).
 * Возвращает ссылку на сессию.
 */
export async function fireRoutine(fields) {
  const text = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => (String(v).includes('\n') ? `${k}:\n<<<\n${v}\n>>>` : `${k}: ${v}`))
    .join('\n');
  const body = JSON.stringify({ text: text.slice(0, 60_000) });
  // Сервис облачных задач иногда временно недоступен (5xx) — повторяем с паузой.
  // Неудачный запуск сессию не создаёт, поэтому повтор не плодит дубли.
  const delays = [5_000, 20_000, 60_000];
  for (let attempt = 0; ; attempt++) {
    let res;
    let data = {};
    try {
      res = await fetch(config.routineFireUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.routineToken}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body,
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      res = null;
      data = { error: { message: e.message } };
    }
    if (res?.ok) return data.claude_code_session_url || '';
    const status = res?.status ?? 0;
    const why = `HTTP ${status || 'network'}: ${data?.error?.message || ''}`.trim();
    const retryable = !res || status >= 500 || status === 429;
    console.warn(`routine fire failed (attempt ${attempt + 1}): ${why}`);
    if (!retryable || attempt >= delays.length) throw new Error(why);
    const retryAfter = Number(res?.headers.get('retry-after')) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(delays[attempt], retryAfter || 0)));
  }
}
