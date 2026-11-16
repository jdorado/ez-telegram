import {fail} from './errors.mjs';

export function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fail('INVALID_INPUT', `Invalid ${label}`);
  return value;
}
export function key(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:.-]{1,160}$/.test(value)) throw fail('INVALID_INPUT', 'Use a stable operation key of 1..160 letters, digits, _, :, . or -');
  return value;
}
export function chatId(value) {
  if (typeof value !== 'string' || !/^-?[1-9]\d{0,19}$/.test(value)) throw fail('INVALID_INPUT', 'Use a Telegram chat id such as -1001234567890; read chats');
  return value;
}
const messageNumber = (value, label) => integer(value, 1, 2 ** 31 - 1, label);

export function config(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => name !== 'botToken')) throw fail('INVALID_INPUT', 'Invalid configuration fields');
  if (typeof input.botToken !== 'string' || !/^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(input.botToken)) throw fail('INVALID_INPUT', 'Supply the BotFather token privately on stdin');
  return {version: 1, botToken: input.botToken};
}
export function sendInput(args) {
  const text = args.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 4096 || /[\u0000\ud800-\udfff]/u.test(text)) throw fail('INVALID_INPUT', 'Text must contain 1..4096 valid characters');
  return {kind: 'send', key: key(args.key), chat: chatId(args.chat), text,
    ...(args.topic === undefined ? {} : {topic: messageNumber(args.topic, 'topic id')}),
    ...(args['reply-to'] === undefined ? {} : {replyTo: messageNumber(args['reply-to'], 'reply message id')})};
}
export function topicInput(args) {
  const name = args.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\u0000-\u001f\ud800-\udfff]/u.test(name)) throw fail('INVALID_INPUT', 'Topic name must be 1..128 printable characters');
  return {kind: 'topic', key: key(args.key), chat: chatId(args.chat), name};
}
// A message is named by the send key the bot posted it under, or by its chat and id.
function target(args, sent) {
  const chat = args.chat === undefined ? undefined : chatId(args.chat);
  if ((args['send-key'] === undefined) === (args.message === undefined)) throw fail('INVALID_INPUT', 'Name the message with --send-key or --message');
  if (args.message !== undefined) {
    if (chat === undefined) throw fail('INVALID_INPUT', 'Give --chat with --message');
    return {chat, messageId: messageNumber(args.message, 'message id')};
  }
  const operation = sent(key(args['send-key']));
  if (operation?.kind !== 'send' || operation.state !== 'accepted') throw fail('NOT_FOUND', 'No accepted send under that key; read operation --key', 4);
  if (chat !== undefined && chat !== operation.chat) throw fail('INVALID_INPUT', 'That send was posted in a different chat');
  return {chat: operation.chat, messageId: operation.providerMessageId};
}
export function pinInput(args, sent) { return {kind: 'pin', key: key(args.key), ...target(args, sent), notify: args.notify === true}; }
export function deleteInput(args, sent) { return {kind: 'delete', key: key(args.key), ...target(args, sent)}; }
