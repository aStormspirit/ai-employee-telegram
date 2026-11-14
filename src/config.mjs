// Сотрудники (Telegram-боты) читаются из переменных окружения (см. .env.example).
//
// BOT_EMPLOYEES — JSON-массив, по объекту на сотрудника:
//   [{ "name": "shop", "telegramToken": "...", "chatIds": [-100...], "userIds": [],
//      "routineFireUrl": "https://api.anthropic.com/v1/claude_code/routines/trig_.../fire",
//      "routineToken": "...", "about": "Я помогаю команде с интернет-магазином." }]
// Плюс прежние одиночные переменные (TELEGRAM_BOT_TOKEN, ROUTINE_*, BOT_ALLOWED_*) — сотрудник «main».
//
// Изоляция: у каждого сотрудника свой бот, свои чаты и своя облачная задача (свои проекты).
// Один чат не может принадлежать двум сотрудникам — такой сотрудник не запускается.

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const ids = (v) => (Array.isArray(v) ? v.map(Number) : list(String(v ?? '')));

const DEFAULT_ABOUT = 'Я помогаю команде с её проектами — могу что-то поменять или добавить.';

function fromEnv() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return [];
  return [
    {
      name: 'main',
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      chatIds: list(process.env.BOT_ALLOWED_CHAT_IDS),
      userIds: list(process.env.BOT_ALLOWED_USER_IDS),
      routineFireUrl: process.env.ROUTINE_FIRE_URL,
      routineToken: process.env.ROUTINE_TOKEN,
      about: process.env.BOT_ABOUT,
    },
  ];
}

function fromJson() {
  const raw = process.env.BOT_EMPLOYEES;
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('ожидается JSON-массив');
    return arr.map((e, i) => ({ ...e, name: e.name || `employee${i + 1}` }));
  } catch (e) {
    console.error(`BOT_EMPLOYEES: не удалось разобрать JSON (${e.message})`);
    return [];
  }
}

function load() {
  const result = [];
  const chatOwner = new Map();
  const tokens = new Set();
  for (const e of [...fromEnv(), ...fromJson()]) {
    const emp = {
      name: String(e.name),
      telegramToken: e.telegramToken,
      chatIds: ids(e.chatIds),
      userIds: ids(e.userIds),
      routineFireUrl: e.routineFireUrl,
      routineToken: e.routineToken,
      about: e.about || DEFAULT_ABOUT,
    };
    const missing = ['telegramToken', 'routineFireUrl', 'routineToken'].filter((k) => !emp[k]);
    if (missing.length) {
      console.error(`[${emp.name}] не запущен: не заданы ${missing.join(', ')}`);
      continue;
    }
    if (tokens.has(emp.telegramToken)) {
      console.error(`[${emp.name}] не запущен: этот Telegram-бот уже используется другим сотрудником`);
      continue;
    }
    const taken = emp.chatIds.filter((c) => chatOwner.has(c));
    if (taken.length) {
      console.error(
        `[${emp.name}] не запущен: чаты ${taken.join(', ')} уже закреплены за ${taken.map((c) => chatOwner.get(c)).join(', ')}`,
      );
      continue;
    }
    tokens.add(emp.telegramToken);
    emp.chatIds.forEach((c) => chatOwner.set(c, emp.name));
    result.push(emp);
  }
  return result;
}

export const employees = load();
