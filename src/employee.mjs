// Один сотрудник = один Telegram-бот + одна облачная задача Claude Code.
// Принимает задачи только в своих чатах и запускает только свою облачную задачу, поэтому
// сотрудники не пересекаются: из чата одного проекта нельзя запустить работу над другим.
import { createTelegram } from './telegram.mjs';
import { fireRoutine } from './routine.mjs';
import { sttEnabled, transcribe } from './stt.mjs';

/** Картинки сообщения: фото (самый большой размер) и изображения, отправленные файлом. */
function imagesOf(msg) {
  if (!msg) return [];
  const out = [];
  if (msg.photo?.length) out.push(msg.photo[msg.photo.length - 1].file_id);
  if (msg.document?.mime_type?.startsWith('image/')) out.push(msg.document.file_id);
  return out;
}

const MAX_IMAGES = 10;

// Контекст чата: последние сообщения хранятся только в памяти и только для своих чатов.
const HISTORY_KEEP = 50; // сообщений на чат
const HISTORY_SEND = 20; // сколько передавать в задачу
const HISTORY_CHARS = 3000;
const HISTORY_MAX_AGE = 12 * 3600; // секунд
const MAX_VOICE_SECONDS = 300;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function authorOf(msg) {
  const u = msg.from || {};
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'участник';
}

/** Короткое текстовое представление сообщения для истории. */
function describe(msg, voiceText) {
  if (voiceText) return `🎤 ${voiceText}`;
  const text = msg.text || msg.caption || '';
  const kind = msg.photo ? '[фото] ' : msg.document ? '[файл] ' : msg.sticker ? '[стикер] ' : msg.voice ? '[голосовое] ' : msg.video ? '[видео] ' : '';
  return (kind + text).trim();
}

// Короткий номер задачи (5 цифр), без повторов подряд.
let lastId = 0;
function nextTaskId() {
  let n = Math.floor(Date.now() / 1000) % 100000;
  if (n <= lastId && lastId - n < 1000) n = (lastId + 1) % 100000;
  lastId = n;
  return String(n).padStart(5, '0');
}
const uniq = (arr) => [...new Set(arr)].slice(0, MAX_IMAGES);

// Тег «подготовить, но не публиковать».
const NO_DEPLOY_TAG = /#(не_обновлять|не_публиковать|без_деплоя)/gi;

export async function runEmployee(emp) {
  const log = {
    log: (...a) => console.log(`[${emp.name}]`, ...a),
    warn: (...a) => console.warn(`[${emp.name}]`, ...a),
    error: (...a) => console.error(`[${emp.name}]`, ...a),
  };
  const { tg, send, dropButtons, poll, download } = createTelegram(emp.telegramToken, log);

  const me = await tg('getMe');
  // Long polling не работает, пока у бота задан вебхук.
  await tg('deleteWebhook', { drop_pending_updates: false });
  const username = me.username.toLowerCase();
  log.log(`бот @${me.username} запущен, чатов: ${emp.chatIds.length}`);
  if (!emp.chatIds.length) log.warn('чаты не заданы — бот отвечает только на /id');

  /** Задачи — от любого участника своих чатов и в личке — от userIds. */
  const canUse = (chat, userId) =>
    chat.type === 'private' ? emp.userIds.includes(userId) : emp.chatIds.includes(chat.id);

  const HELP = [
    `Привет! ${emp.about}`,
    '',
    'Чтобы дать мне задачу, отметьте меня и напишите, что нужно сделать. Например:',
    `@${me.username} поменяй текст на главной`,
    '',
    'Сначала я расскажу, что собираюсь сделать. Если всё верно — нажмите «Делать», если нет — ответьте на моё сообщение и напишите, что поправить.',
    'Когда закончу, опубликую изменения и напишу, что получилось.',
    '',
    'Если публиковать пока не нужно, добавьте к задаче #не_обновлять.',
    'Задачи может давать любой участник этого чата.',
  ].join('\n');

  // Картинки задач — чтобы передать их и в работу после «Делать» (в памяти; после перезапуска
  // берутся из сообщения, на которое ответил план).
  const taskImages = new Map();
  const rememberImages = (id, images) => {
    if (!images.length) return;
    taskImages.set(id, images);
    if (taskImages.size > 500) taskImages.delete(taskImages.keys().next().value);
  };

  // Альбом приходит отдельными сообщениями с общим media_group_id; подпись — только у одного.
  const albums = new Map();
  function collectAlbum(msg) {
    const key = `${msg.chat.id}:${msg.media_group_id}`;
    let album = albums.get(key);
    if (!album) {
      album = { messages: [] };
      albums.set(key, album);
    }
    album.messages.push(msg);
    clearTimeout(album.timer);
    album.timer = setTimeout(() => {
      albums.delete(key);
      const main = album.messages.find((m) => m.caption) || album.messages[0];
      const images = album.messages.flatMap(imagesOf);
      onMessage(main, images).catch((e) => log.error('album error', e));
    }, 1500);
  }

  // Обращение по имени: «Имя, …» / «Имя …» в начале или «…, Имя?» в конце сообщения.
  const namesRe = emp.names.length ? emp.names.map(escapeRe).join('|') : null;
  const nameStart = namesRe ? new RegExp(`^\\s*(?:эй\\s*,?\\s*)?(?:${namesRe})(?=$|[\\s,.!?:;])[\\s,.!?:;]*`, 'i') : null;
  const nameEnd = namesRe ? new RegExp(`[\\s,]+(?:${namesRe})[\\s.!?]*$`, 'i') : null;
  const calledByName = (t) => Boolean(t && ((nameStart && nameStart.test(t)) || (nameEnd && nameEnd.test(t))));
  const stripName = (t) => (nameStart ? t.replace(nameStart, '') : t).replace(nameEnd || /$^/, '').trim();

  const history = new Map(); // chatId → [{ id, t, who, text }]
  function remember(msg, voiceText) {
    const text = describe(msg, voiceText);
    if (!text) return;
    const list = history.get(msg.chat.id) || [];
    list.push({ id: msg.message_id, t: msg.date, who: authorOf(msg), text: text.slice(0, 500) });
    if (list.length > HISTORY_KEEP) list.splice(0, list.length - HISTORY_KEEP);
    history.set(msg.chat.id, list);
  }
  function historyFor(chatId, excludeId) {
    const now = Date.now() / 1000;
    const items = (history.get(chatId) || []).filter((m) => m.id !== excludeId && now - m.t < HISTORY_MAX_AGE).slice(-HISTORY_SEND);
    const lines = items.map((m) => {
      const d = new Date(m.t * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${hh}:${mm} UTC ${m.who}: ${m.text}`;
    });
    while (lines.join('\n').length > HISTORY_CHARS) lines.shift();
    return lines.join('\n');
  }

  async function start(chatId, replyTo, note, fields) {
    const status = await send(chatId, note, { replyTo });
    try {
      const url = await fireRoutine(emp, fields, log);
      log.log(`task ${fields.TASK_ID} ${fields.MODE}: ${url}`);
    } catch (e) {
      log.error(e.message);
      await send(chatId, 'Не получилось взяться за задачу — попробуйте, пожалуйста, ещё раз чуть позже.', {
        replyTo: status.message_id,
      });
    }
  }

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
    // План — ответ на сообщение с задачей (или с правками): картинки берём оттуда и из памяти.
    const images = uniq([...(taskImages.get(info.id) || []), ...imagesOf(q.message.reply_to_message)]);
    return start(chatId, msgId, 'Отлично, приступаю! Напишу, когда закончу.', {
      IMAGES: images.join(','),
      MODE: 'work',
      TASK_ID: info.id,
      CHAT_ID: chatId,
      REPLY_TO: msgId,
      NO_DEPLOY: info.noDeploy ? 'yes' : '',
      TASK: info.task,
      APPROVED_PLAN: info.plan,
    });
  }

  async function onMessage(msg, albumImages) {
    if (!msg?.from) return;
    if (msg.media_group_id && !albumImages) return collectAlbum(msg);
    const allowed = canUse(msg.chat, msg.from.id);

    // Голосовые в своих чатах расшифровываем (если настроен STT): так бот слышит своё имя и помнит сказанное.
    let voiceText = '';
    const voice = msg.voice || msg.audio || msg.video_note;
    if (voice && allowed && sttEnabled && (voice.duration || 0) <= MAX_VOICE_SECONDS) {
      try {
        const { data, path } = await download(voice.file_id);
        voiceText = await transcribe(data, path.split('/').pop() || 'voice.ogg');
        log.log(`voice chat=${msg.chat.id} ${voice.duration || '?'}s → ${voiceText.length} симв.`);
      } catch (e) {
        log.warn(`voice: ${e.message}`);
      }
    }
    if (allowed) remember(msg, voiceText);

    const text = voiceText || msg.text || msg.caption || '';
    const entities = msg.entities || msg.caption_entities || [];
    const isPrivate = msg.chat.type === 'private';
    const mentioned = entities.some(
      (e) =>
        (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${username}`) ||
        (e.type === 'text_mention' && e.user?.id === me.id) ||
        (e.type === 'bot_command' && text.slice(e.offset, e.offset + e.length).toLowerCase().endsWith(`@${username}`)) ||
        // /task без @бот: в чате работает один сотрудник, команда адресована ему.
        (e.type === 'bot_command' && e.offset === 0 && /^\/task(@|$)/i.test(text.slice(0, e.length))),
    );
    const replyToBot = msg.reply_to_message?.from?.id === me.id;
    const byName = calledByName(text);
    if (!isPrivate && !mentioned && !replyToBot && !byName) return;
    log.log(`msg chat=${msg.chat.id} type=${msg.chat.type}`);

    const clean = stripName(text.replace(new RegExp(`@${username}`, 'gi'), '').trim());
    const cmd = clean.split(/\s+/)[0].toLowerCase();
    // /id отвечает везде — чтобы узнать номер чата до подключения.
    if (cmd === '/id') return send(msg.chat.id, `chat_id: ${msg.chat.id}\nuser_id: ${msg.from.id}`, { replyTo: msg.message_id });

    if (!allowed) {
      log.log(`ignored: chat ${msg.chat.id} не закреплён за этим сотрудником`);
      return send(
        msg.chat.id,
        isPrivate
          ? 'Я принимаю задачи только в общем чате команды.'
          : `Я пока не работаю в этом чате. Чтобы подключить меня, передайте администратору номер чата: ${msg.chat.id}`,
        { replyTo: msg.message_id },
      );
    }
    // Картинки: из самого сообщения (или альбома) и из сообщения, на которое ответили упоминанием бота.
    // Также цитата/ответ на сообщение из другого чата (external_reply + quote).
    const images = uniq([
      ...(albumImages || imagesOf(msg)),
      ...(replyToBot ? [] : imagesOf(msg.reply_to_message)),
      ...imagesOf(msg.external_reply),
    ]);
    const replyText = [
      replyToBot ? '' : msg.reply_to_message?.text || msg.reply_to_message?.caption || '',
      msg.quote?.text || '',
    ]
      .filter(Boolean)
      .join('\n');

    if (cmd === '/start' || cmd === '/help' || (!clean && !images.length)) return send(msg.chat.id, HELP, { replyTo: msg.message_id });

    // Ответ на план — правки к плану.
    const planInfo = replyToBot ? parsePlan(msg.reply_to_message.text || '') : null;
    if (planInfo) {
      const all = uniq([...(taskImages.get(planInfo.id) || []), ...images]);
      rememberImages(planInfo.id, all);
      return start(msg.chat.id, msg.message_id, 'Понял, учту и пришлю обновлённый план.', {
        MODE: 'plan',
        TASK_ID: planInfo.id,
        CHAT_ID: msg.chat.id,
        REPLY_TO: msg.message_id,
        NO_DEPLOY: planInfo.noDeploy ? 'yes' : '',
        TASK: planInfo.task,
        PREVIOUS_PLAN: planInfo.plan,
        FEEDBACK: clean,
        IMAGES: all.join(','),
        VOICE: voiceText ? 'yes' : '',
        HISTORY: historyFor(msg.chat.id, msg.message_id),
      });
    }

    const id = nextTaskId();
    rememberImages(id, images);
    const noDeploy = new RegExp(NO_DEPLOY_TAG.source, 'i').test(clean);
    // Задача (/task, «выполни/сделай/поставь задачу») — обещаем план; иначе это вопрос — обещаем ответ.
    const isTask = /^\/task\b|^(выполни|сделай|поставь)\s+задач/i.test(clean.replace(/^\/task@\S+/i, '/task'));
    const note = isTask ? 'Принял! Разберусь и напишу, что планирую сделать.' : 'Сейчас посмотрю и отвечу.';
    return start(msg.chat.id, msg.message_id, note, {
      // Вопрос — без MODE: промпт отвечает одним сообщением, без плана и кнопок.
      MODE: isTask ? 'plan' : undefined,
      TASK_ID: id,
      CHAT_ID: msg.chat.id,
      REPLY_TO: msg.message_id,
      NO_DEPLOY: noDeploy ? 'yes' : '',
      TASK: clean.replace(NO_DEPLOY_TAG, '').replace(/\s+/g, ' ').trim() || 'посмотри картинку',
      CONTEXT: replyText,
      IMAGES: images.join(','),
      VOICE: voiceText ? 'yes' : '',
      HISTORY: historyFor(msg.chat.id, msg.message_id),
    });
  }

  await poll(async (u) => (u.callback_query ? onButton(u.callback_query) : onMessage(u.message)));
}

/**
 * Сообщение с планом присылает облачная сессия (формат задан в ROUTINE_PROMPT.md):
 *   📋 Задача №<id>[ · не обновлять игру | · без публикации]: <задача одной строкой>
 *   (пустая строка)
 *   <план>
 * Прежний формат «План #<id>…\nЗадача: …» тоже понимаем.
 */
export function parsePlan(text) {
  let m = text.match(/^📋 Задача №([a-z0-9]+)( · (?:не обновлять игру|без публикации))?: ([^\n]*)\n\n([\s\S]*)$/);
  if (!m) m = text.match(/^План #([a-z0-9]+)( · без деплоя)?\nЗадача: ([\s\S]*?)\n\n([\s\S]*)$/);
  if (!m) return null;
  const plan = m[4].replace(/\n*(Если всё верно|Ответьте на это сообщение)[\s\S]*$/, '').trim();
  return { id: m[1], noDeploy: Boolean(m[2]), task: m[3].trim(), plan };
}
