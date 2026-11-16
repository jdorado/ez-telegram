// Turns one Telegram update into a chat record and, for a human's group message, an inbox event.
// Groups and supergroups are captured, and private chats only from users the operator allowed;
// channels, bots and service messages are not.
const GROUP = new Set(['group', 'supergroup']);
const MEDIA = ['photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker', 'animation', 'location', 'contact', 'poll'];
const botStatus = status => status === 'creator' ? 'administrator' : status === 'restricted' ? 'member' : status;
const iso = seconds => new Date(seconds * 1000).toISOString();
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null : null;

function chatRecord(chat, extra = {}) {
  return {id: String(chat.id), type: chat.type, title: clean(chat.title, 128), isForum: chat.is_forum === true, ...extra};
}

// The file an agent can be handed: the largest photo size, or the document, voice note or audio.
function file(m) {
  const f = Array.isArray(m.photo) ? m.photo.at(-1) : m.document ?? m.voice ?? m.audio ?? null;
  if (typeof f?.file_id !== 'string') return null;
  return {id: f.file_id, size: Number.isSafeInteger(f.file_size) ? f.file_size : null, name: clean(f.file_name, 200), mime: clean(f.mime_type, 100),
    ...(Number.isSafeInteger(f.duration) ? {duration: f.duration} : {})};
}

export function interpret(update, {dmAllow = []} = {}) {
  const joined = update.my_chat_member;
  if (joined) return GROUP.has(joined.chat?.type) ? {chat: chatRecord(joined.chat, {botStatus: botStatus(joined.new_chat_member?.status)}), event: null} : null;
  const kind = update.message ? 'message' : update.edited_message ? 'edited' : null;
  const m = update.message ?? update.edited_message;
  if (!kind || !m?.chat) return null;
  const direct = m.chat.type === 'private';
  if (direct ? !dmAllow.includes(String(m.from?.id)) || m.from?.id !== m.chat.id : !GROUP.has(m.chat.type)) return null;
  const chat = direct ? {id: String(m.chat.id), type: 'private', title: clean([m.chat.first_name, m.chat.last_name].filter(Boolean).join(' '), 128), isForum: false} : chatRecord(m.chat);
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
    type, text, ...(file(m) ? {file: file(m)} : {})}};
}
