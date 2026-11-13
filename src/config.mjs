// Настройки бота читаются из переменных окружения (см. .env.example).
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Не задана переменная окружения ${name}`);
    process.exit(1);
  }
  return v;
}

export const config = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  // Личные сообщения принимаются только от этих пользователей (необязательно).
  allowedUserIds: list(process.env.BOT_ALLOWED_USER_IDS),
  // Чаты, где задачи может давать любой участник. Пусто — бот отвечает только на /id.
  allowedChatIds: list(process.env.BOT_ALLOWED_CHAT_IDS),
  // Облачная задача Claude Code (claude.ai/code/routines) с API-триггером.
  routineFireUrl: required('ROUTINE_FIRE_URL'),
  routineToken: required('ROUTINE_TOKEN'),
  // Одна фраза о себе для приветствия: «Я помогаю команде с …».
  botAbout: process.env.BOT_ABOUT || 'Я помогаю команде с её проектами — могу что-то поменять или добавить.',
};
