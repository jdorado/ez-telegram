import {createHash} from 'node:crypto';
import {fail} from './errors.mjs';

// The Ez application channel: every human message in a group the bot is in (and a direct message from a user
// the operator allowed) becomes an ordinary run of the owner's agent, the way ez-slack treats its channels. Each forum topic (or a group's
// main thread) is one scope, so one native conversation. Adding the bot to a group is what trusts it.
export const scopeFor = (chat, topic) => `telegram:${chat}:${topic ?? 'main'}`;
const STATES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const RUN = /^r_app_[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');

export function core(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).some(name => !['url', 'token', 'privateHttp'].includes(name))) throw fail('INVALID_INPUT', 'Invalid Ez connection fields');
  let url;
  try { url = new URL(input.url); } catch { throw fail('INVALID_INPUT', 'Invalid Ez url'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && input.privateHttp === true))) throw fail('INVALID_INPUT', 'Use HTTPS or an explicitly trusted private Ez network');
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43,200}$/.test(input.token)) throw fail('INVALID_INPUT', 'Invalid Ez credential');
  return {url: url.origin + '/', token: input.token, ...(input.privateHttp === true ? {privateHttp: true} : {})};
}

const MAX_FILE = 10 * 1024 * 1024; // what Ez stages for the agent
const SPOKEN = new Set(['voice', 'audio']);

// The run text says where the message came from, so the agent knows the group, topic and person.
// A voice note arrives as its transcript; a photo or document is attached (`media` says which).
export function runText(event, chat, media = {}) {
  const where = chat?.type === 'private' ? ['Telegram direct message'] :
    [`Telegram group "${chat?.title ?? event.chatTitle ?? event.chat}" (${event.chat})`, event.topicId ? `topic ${event.topicId}` : 'main thread'];
  const who = [event.from.name, event.from.username ? `@${event.from.username}` : null].filter(Boolean).join(' ') || `user ${event.from.id}`;
  const label = media.note ?? (event.type === 'text' ? '' : media.attached ? `[${event.type} attached]` : `[${event.type}]`);
  const body = [label, event.text].filter(Boolean).join(' ');
  // The reply mechanism, which the agent cannot otherwise know: text replies come back here; a voice note is one command.
  const place = `--chat ${event.chat}${event.topicId ? ` --topic ${event.topicId}` : ''} --reply-to ${event.messageId}`;
  return `${where.join(', ')}, message ${event.messageId}${event.kind === 'edited' ? ' (edited)' : ''}, from ${who}:\n${body}\n\n` +
    `(Your text replies in this run are posted here. To reply with a voice note instead: ez telegram send --voice ${place} --key NEW_KEY --text "...", and send no text reply.)`;
}

export class Channel {
  constructor(store, connection, options = {}) {
    this.store = store;
    this.connection = connection;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.files = options.files ?? null;
    this.voice = options.voice ?? null;
  }
  // What a message's file becomes for the agent. A definite refusal (too large, unreadable, rejected) becomes a
  // note so the message still reaches the agent; an outage throws and the message is retried on the next pass.
  async media(event) {
    const file = event.file, kind = event.type;
    if (!file || !this.files || (event.kind === 'edited')) return {};
    if (file.size !== null && file.size > MAX_FILE) return {note: `[${kind} of ${(file.size / 1048576).toFixed(1)} MB not passed on: over 10 MB]`};
    let download;
    try { download = await this.files(file); }
    catch (error) { if (error.details?.definitive) return {note: `[${kind} could not be downloaded]`}; throw error; }
    if (!download.bytes.length || download.bytes.length > MAX_FILE) return {note: `[${kind} not passed on: empty or over 10 MB]`};
    const extension = download.path.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? '';
    const name = file.name ?? `${kind}-${event.messageId}${extension}`;
    if (SPOKEN.has(kind)) {
      const length = file.duration ? ` ${file.duration}s` : '';
      if (!this.voice) return {note: `[${kind}${length}, not transcribed: no voice configured]`};
      try { return {note: `[${kind}${length}, transcript] ${await this.voice.transcribe(download.bytes, name) || '(no speech)'}`}; }
      catch (error) { if (error.details?.definitive) return {note: `[${kind}${length} could not be transcribed]`}; throw error; }
    }
    return {attached: true, attachment: {name, data: download.bytes.toString('base64')}};
  }
  async call(path, body) {
    let response;
    try {
      response = await this.fetch(new URL(path, this.connection.url), {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: {authorization: `Bearer ${this.connection.token}`, 'content-type': 'application/json'},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(30000)});
    } catch { throw fail('CORE_UNAVAILABLE', 'Ez did not answer'); }
    let data = null;
    try { data = await response.json(); } catch { /* checked below */ }
    if (response.status === 401 || response.status === 403) throw fail('CORE_AUTH', 'Ez refused the application credential', 3);
    if (!response.ok || !data || typeof data !== 'object') throw fail('CORE_REJECTED', `Ez answered ${response.status}`);
    return data;
  }
  registration() { return this.call('/v1/registration'); }
  // Admit captured messages in order. A failed admission stops here and is retried on the next pass;
  // the same requestId never creates a second run.
  async admit() {
    let admitted = 0;
    for (;;) {
      const after = this.store.meta('admitted') ?? 0;
      const {events} = this.store.inbox(after, 20);
      if (!events.length) return admitted;
      for (const event of events) {
        const scope = scopeFor(event.chat, event.topicId), media = await this.media(event);
        const run = await this.call('/v1/runs', {requestId: `tg:${event.id}`, scope, text: runText(event, this.store.chat(event.chat), media),
          ...(media.attachment ? {attachment: media.attachment} : {}),
          context: {telegram: {chat: event.chat, topicId: event.topicId, messageId: event.messageId, from: event.from}}});
        if (!RUN.test(run.id ?? '') || run.scope !== scope) throw fail('CORE_RESPONSE', 'Ez admitted a different run');
        this.store.openRun({runId: run.id, scope, chat: event.chat, topic: event.topicId, replyTo: event.messageId, sent: [], seq: event.seq});
        this.store.setMeta('admitted', event.seq);
        admitted++;
      }
    }
  }
  // Post each new message of an open run into its topic, as a reply to the message that started it.
  // A key per message posts it once; an uncertain send stays uncertain and is never retried.
  async deliver(send) {
    let posted = 0;
    for (const record of this.store.openRuns()) {
      const run = await this.call(`/v1/runs/${record.runId}`);
      if (run.id !== record.runId || run.scope !== record.scope || !STATES.has(run.status)) throw fail('CORE_RESPONSE', 'Ez returned a different run');
      for (const message of run.messages ?? []) {
        if (typeof message?.id !== 'string' || typeof message.text !== 'string' || !message.text.trim() || record.sent.includes(message.id)) continue;
        const parts = message.text.match(/[\s\S]{1,4000}/g);
        for (const [index, text] of parts.entries()) {
          await send({chat: record.chat, text, key: `run-${sha(`${record.runId}:${message.id}:${index}`).slice(0, 40)}`,
            ...(record.topic ? {topic: record.topic} : {}), 'reply-to': record.replyTo});
          posted++;
        }
        record.sent.push(message.id);
        this.store.saveRun(record);
      }
      if (['completed', 'failed', 'cancelled'].includes(run.status)) this.store.closeRun(record.runId, run.status);
    }
    return posted;
  }
}
