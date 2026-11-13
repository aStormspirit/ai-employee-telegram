// Нейросотрудник: принимает задачи по упоминанию в Telegram и передаёт их в облачную сессию Claude Code.
// Сервер только принимает сообщения и кнопки; код, сборку, push и проверку деплоя делает облачная сессия,
// она же присылает план и отчёт в чат (см. ROUTINE_PROMPT.md).
import { config } from './config.mjs';
import { tg, send, dropButtons, poll } from './telegram.mjs';
import { fireRoutine } from './routine.mjs';

const me = await tg('getMe');
// Long polling не работает, пока у бота задан вебхук (например, от прежнего хостинга бота).
await tg('deleteWebhook', { drop_pending_updates: false });
const username = me.username.toLowerCase();
console.log(`Бот @${me.username} запущен`);
if (config.allowedChatIds.length) console.log(`Чаты для задач: ${config.allowedChatIds.join(', ')}`);
else console.warn('BOT_ALLOWED_CHAT_IDS не задан — бот отвечает только на /id');

/** Задачи принимаются от любого участника разрешённого чата и в личке — от BOT_ALLOWED_USER_IDS. */
const canUse = (chat, userId) =>
  chat.type === 'private' ? config.allowedUserIds.includes(userId) : config.allowedChatIds.includes(chat.id);

// Тег «подготовить, но не публиковать».
const NO_DEPLOY_TAG = /#(не_публиковать|no_deploy)/gi;

const HELP = [
  `Привет! ${config.botAbout}`,
  '',
  'Чтобы дать мне задачу, отметьте меня и напишите, что нужно сделать. Например:',
  `@${me.username} сделай кнопку «Магазин» зелёной`,
  '',
  'Сначала я расскажу, что собираюсь сделать. Если всё верно — нажмите «Делать», если нет — ответьте на моё сообщение и напишите, что поправить.',
  'Когда закончу, опубликую изменения и напишу, что получилось.',
  '',
  'Если публиковать пока не нужно, добавьте к задаче #не_публиковать.',
  'Задачи может давать любой участник этого чата.',
].join('\n');

await poll(async (u) => {
  if (u.callback_query) return onButton(u.callback_query);
  const msg = u.message;
  if (!msg?.from) return;
  const text = msg.text || msg.caption || '';
  const entities = msg.entities || msg.caption_entities || [];
  const isPrivate = msg.chat.type === 'private';
  const mentioned = entities.some(
    (e) =>
      (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username}`) ||
      (e.type === 'text_mention' && e.user?.id === me.id) ||
      (e.type === 'bot_command' && text.slice(e.offset, e.offset + e.length).toLowerCase().endsWith(`@${username}`)),
  );
  const replyToBot = msg.reply_to_message?.from?.id === me.id;
  console.log(`msg chat=${msg.chat.id} type=${msg.chat.type} mentioned=${mentioned} reply=${replyToBot}`);
  if (!isPrivate && !mentioned && !replyToBot) return;

  const clean = text.replace(new RegExp(`@${username}`, 'gi'), '').trim();
  const cmd = clean.split(/\s+/)[0].toLowerCase();
  // /id отвечает везде — чтобы узнать id чата до настройки.
  if (cmd === '/id') return send(msg.chat.id, `chat_id: ${msg.chat.id}\nuser_id: ${msg.from.id}`, { replyTo: msg.message_id });

  if (!canUse(msg.chat, msg.from.id)) {
    console.log(`ignored: chat ${msg.chat.id} is not in BOT_ALLOWED_CHAT_IDS`);
    await send(
      msg.chat.id,
      isPrivate
        ? 'Я принимаю задачи только в общем чате команды.'
        : `Я пока не работаю в этом чате. Чтобы подключить меня, передайте администратору номер чата: ${msg.chat.id}`,
      { replyTo: msg.message_id },
    );
    return;
  }
  if (cmd === '/start' || cmd === '/help' || !clean) return send(msg.chat.id, HELP, { replyTo: msg.message_id });

  // Ответ на план — правки к плану.
  const replied = msg.reply_to_message;
  const planInfo = replyToBot ? parsePlan(replied.text || '') : null;
  if (planInfo) {
    return start(msg.chat.id, msg.message_id, 'Понял, учту и пришлю обновлённый план.', {
      MODE: 'plan',
      TASK_ID: planInfo.id,
      CHAT_ID: msg.chat.id,
      REPLY_TO: msg.message_id,
      NO_DEPLOY: planInfo.noDeploy ? 'yes' : '',
      TASK: planInfo.task,
      PREVIOUS_PLAN: planInfo.plan,
      FEEDBACK: clean,
    });
  }

  const id = String(Math.floor(Date.now() / 1000) % 100000).padStart(5, '0');
  const noDeploy = new RegExp(NO_DEPLOY_TAG.source, 'i').test(clean);
  return start(msg.chat.id, msg.message_id, 'Принял! Разберусь и напишу, что планирую сделать.', {
    MODE: 'plan',
    TASK_ID: id,
    CHAT_ID: msg.chat.id,
    REPLY_TO: msg.message_id,
    NO_DEPLOY: noDeploy ? 'yes' : '',
    TASK: clean.replace(NO_DEPLOY_TAG, '').replace(/\s+/g, ' ').trim(),
  });
});

async function onButton(q) {
  if (!q.message || !canUse(q.message.chat, q.from.id)) {
    return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Эта кнопка здесь не работает.' });
  }
  await tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const chatId = q.message.chat.id;
  const msgId = q.message.message_id;
  await dropButtons(chatId, msgId);
  const [action] = String(q.data || '').split(':');
  const info = parsePlan(q.message.text || '');
  if (!info) return send(chatId, 'Не нашёл задачу в этом сообщении.', { replyTo: msgId });
  if (action !== 'ok') return send(chatId, 'Хорошо, задачу отменил.', { replyTo: msgId });
  return start(chatId, msgId, 'Отлично, приступаю! Напишу, когда закончу.', {
    MODE: 'work',
    TASK_ID: info.id,
    CHAT_ID: chatId,
    REPLY_TO: msgId,
    NO_DEPLOY: info.noDeploy ? 'yes' : '',
    TASK: info.task,
    APPROVED_PLAN: info.plan,
  });
}

/** Сообщает в чат и запускает облачную сессию; ссылку на сессию дописывает в сообщение. */
async function start(chatId, replyTo, note, fields) {
  const status = await send(chatId, note, { replyTo });
  try {
    const url = await fireRoutine(fields);
    console.log(`task ${fields.TASK_ID} ${fields.MODE}: ${url}`);
  } catch (e) {
    console.error(e);
    await send(chatId, 'Не получилось взяться за задачу — попробуйте, пожалуйста, ещё раз чуть позже.', { replyTo: status.message_id });
  }
}

/**
 * Сообщение с планом присылает облачная сессия (формат задан в ROUTINE_PROMPT.md):
 *   📋 Задача №<id>[ · без публикации]: <задача одной строкой>
 *   (пустая строка)
 *   <план>
 */
function parsePlan(text) {
  let m = text.match(/^📋 Задача №([a-z0-9]+)( · без публикации)?: ([^\n]*)\n\n([\s\S]*)$/);
  if (!m) return null;
  const plan = m[4].replace(/\n*(Если всё верно|Ответьте на это сообщение)[\s\S]*$/, '').trim();
  return { id: m[1], noDeploy: Boolean(m[2]), task: m[3].trim(), plan };
}
