// Turns one Telegram update into a chat record and, for a human's group message, an inbox event.
// Only groups and supergroups are captured: private chats, channels, bots and service messages are not.
const GROUP = new Set(['group', 'supergroup']);
const MEDIA = ['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker', 'animation', 'location', 'contact', 'poll'];
const botStatus = status => status === 'creator' ? 'administrator' : status === 'restricted' ? 'member' : status;
const iso = seconds => new Date(seconds * 1000).toISOString();
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null : null;

function chatRecord(chat, extra = {}) {
  return {id: String(chat.id), type: chat.type, title: clean(chat.title, 128), isForum: chat.is_forum === true, ...extra};
}

export function interpret(update) {
  const joined = update.my_chat_member;
  if (joined) return GROUP.has(joined.chat?.type) ? {chat: chatRecord(joined.chat, {botStatus: botStatus(joined.new_chat_member?.status)}), event: null} : null;
  const kind = update.message ? 'message' : update.edited_message ? 'edited' : null;
  const m = update.message ?? update.edited_message;
  if (!kind || !GROUP.has(m?.chat?.type)) return null;
  const chat = chatRecord(m.chat);
  // A group that becomes a supergroup (for example by enabling Topics) continues under a new id.
  if (m.migrate_to_chat_id) return {chat: {...chat, migratedTo: String(m.migrate_to_chat_id)}, event: null};
  if (!m.from || m.from.is_bot || !Number.isSafeInteger(m.message_id)) return {chat, event: null};
  const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : null;
  const type = typeof m.text === 'string' ? 'text' : MEDIA.find(name => name in m) ?? null;
  if (!text && !type) return {chat, event: null};
  const topic = m.is_topic_message ? m.message_thread_id ?? null : null;
  const reply = m.reply_to_message?.message_id ?? null;
  const name = clean([m.from.first_name, m.from.last_name].filter(Boolean).join(' '), 128);
  return {chat, event: {
    id: `${chat.id}:${m.message_id}:${kind === 'edited' ? `edit:${m.edit_date}` : 'message'}`, kind, chat: chat.id, chatTitle: chat.title,
    messageId: m.message_id, topicId: topic, replyTo: reply && reply !== topic ? reply : null,
    from: {id: m.from.id, username: clean(m.from.username, 64), name}, date: iso(m.date), ...(kind === 'edited' ? {editedAt: iso(m.edit_date)} : {}),
    type, text}};
}
