import {fail} from './errors.mjs';

const UPDATES = ['message', 'edited_message', 'my_chat_member'];

// Telegram Bot API over HTTPS. The token appears only in the request path and never in an error.
export class Provider {
  constructor(botToken, options = {}) {
    this.botToken = botToken;
    this.base = options.base ?? 'https://api.telegram.org';
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  async call(method, body = {}, {timeoutMs = 20000, signal} = {}) {
    let response, text;
    try {
      const form = body instanceof FormData;
      response = await this.fetch(`${this.base}/bot${this.botToken}/${method}`, {method: 'POST', ...(form ? {} : {headers: {'content-type': 'application/json'}}),
        body: form ? body : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])});
      text = await response.text();
    } catch { throw fail('PROVIDER_UNAVAILABLE', 'Telegram did not answer', 2, {definitive: false}); }
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON: treated as unavailable below */ }
    if (response.ok && data?.ok === true) return data.result;
    const code = Number(data?.error_code ?? response.status);
    // A 4xx with Telegram's own error body means the request was refused and nothing happened.
    if (data?.ok === false && code >= 400 && code < 500) {
      const description = typeof data.description === 'string' ? data.description.replace(/[^\x20-\x7e]/g, '').slice(0, 120) : '';
      const retryAfter = Number(data.parameters?.retry_after);
      const details = {definitive: true, providerCode: code, ...(description ? {description} : {}), ...(Number.isSafeInteger(retryAfter) ? {retryAfter} : {})};
      if (code === 401) throw fail('AUTH_FAILED', 'Telegram refused the bot token', 3, details);
      if (code === 409) throw fail('POLL_CONFLICT', 'Another poller or a webhook uses this bot token', 2, details);
      if (code === 429) throw fail('RATE_LIMITED', 'Telegram asked to slow down', 2, details);
      throw fail('PROVIDER_REJECTED', 'Telegram rejected the request', 2, details);
    }
    throw fail('PROVIDER_UNAVAILABLE', 'Telegram did not answer', 2, {definitive: false});
  }
  // Downloads a file Telegram holds for the bot (bots may download up to 20 MB).
  async download(fileId) {
    const file = await this.call('getFile', {file_id: fileId});
    if (typeof file?.file_path !== 'string') throw fail('PROVIDER_RESPONSE', 'Telegram returned no file path');
    let response;
    try { response = await this.fetch(`${this.base}/file/bot${this.botToken}/${file.file_path}`, {signal: AbortSignal.timeout(60000)}); }
    catch { throw fail('PROVIDER_UNAVAILABLE', 'Telegram did not answer', 2, {definitive: false}); }
    if (!response.ok) throw fail('PROVIDER_REJECTED', 'Telegram refused the file download', 2, {definitive: true, providerCode: response.status});
    return {bytes: Buffer.from(await response.arrayBuffer()), path: file.file_path};
  }
  async me() {
    const me = await this.call('getMe');
    if (me?.is_bot !== true || !Number.isSafeInteger(me.id) || typeof me.username !== 'string') throw fail('PROVIDER_RESPONSE', 'Telegram returned an unexpected bot identity', 3);
    return me;
  }
  webhook() { return this.call('getWebhookInfo'); }
  async updates(offset, timeout, signal) {
    const result = await this.call('getUpdates', {...(offset ? {offset} : {}), timeout, limit: 100, allowed_updates: UPDATES}, {timeoutMs: (timeout + 15) * 1000, signal});
    if (!Array.isArray(result)) throw fail('PROVIDER_RESPONSE', 'Telegram returned an unexpected update list');
    return result;
  }
  member(chat, userId) { return this.call('getChatMember', {chat_id: chat, user_id: userId}); }
  sendMessage({chat, text, topic, replyTo, html}) {
    return this.call('sendMessage', {chat_id: chat, text, link_preview_options: {is_disabled: true}, ...(html ? {parse_mode: 'HTML'} : {}),
      ...(topic ? {message_thread_id: topic} : {}), ...(replyTo ? {reply_parameters: {message_id: replyTo, allow_sending_without_reply: true}} : {})});
  }
  // A voice note: Ogg Opus audio, shown in Telegram as a playable voice message.
  async sendVoice({chat, topic, replyTo}, audio) {
    const form = new FormData();
    form.set('chat_id', chat);
    form.set('voice', new Blob([audio], {type: 'audio/ogg'}), 'voice.ogg');
    if (topic) form.set('message_thread_id', String(topic));
    if (replyTo) form.set('reply_parameters', JSON.stringify({message_id: replyTo, allow_sending_without_reply: true}));
    return this.call('sendVoice', form, {timeoutMs: 60000});
  }
  createTopic({chat, name}) { return this.call('createForumTopic', {chat_id: chat, name}); }
  // A message in a forum topic is pinned at the top of that topic.
  pin({chat, messageId, notify}) { return this.call('pinChatMessage', {chat_id: chat, message_id: messageId, disable_notification: !notify}); }
  deleteMessage({chat, messageId}) { return this.call('deleteMessage', {chat_id: chat, message_id: messageId}); }
}
