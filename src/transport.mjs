import {Provider} from './provider.mjs';
import {interpret} from './capture.mjs';
import {fail, publicError} from './errors.mjs';
import {sendInput, topicInput, pinInput, deleteInput} from './validation.mjs';
import {hash} from './store.mjs';

export class Transport {
  constructor(store, connection, options = {}) {
    this.store = store;
    this.connection = connection;
    this.now = options.now ?? Date.now;
    this.pollTimeout = options.pollTimeout ?? 25;
    this.provider = options.provider ?? new Provider(connection.botToken);
    this.voice = options.voice ?? null;
  }
  // The bytes of a captured file, for the channel to hand to the agent.
  download(file) { return this.provider.download(file.id); }
  at() { return new Date(this.now()).toISOString(); }
  // One long poll. Updates stay at Telegram until a later poll confirms their offset, so the offset
  // moves only with the transaction that captured them.
  async poll(signal) {
    try {
      const updates = (await this.provider.updates(this.store.meta('offset') || undefined, this.pollTimeout, signal)).filter(update => Number.isSafeInteger(update?.update_id));
      let captured = 0;
      if (updates.length) {
        const items = updates.map(update => interpret(update, {dmAllow: this.store.meta('dmAllow') ?? []})).filter(Boolean);
        captured = this.store.ingest(items, Math.max(...updates.map(update => update.update_id)) + 1, this.at());
      }
      this.store.setMeta('lastPoll', {at: this.at(), error: null, captured});
      return {captured};
    } catch (error) {
      if (!signal?.aborted) this.store.setMeta('lastPoll', {at: this.at(), error: publicError(error).code});
      throw error;
    }
  }
  chats() { return {chats: this.store.chats()}; }
  // Every write shares one contract: reserve the key, call Telegram, record what came back.
  async act(payload, record, args, call, accept) {
    if (args.preview === true) return {preview: true, payload};
    const chat = this.store.chat(payload.chat);
    if (!chat || ['left', 'kicked'].includes(chat.botStatus)) throw fail('CHAT_UNKNOWN', 'The bot is not known in that chat; add it to the group, send a message there and read chats', 4);
    if (chat.migratedTo) throw fail('CHAT_MIGRATED', 'That group became a supergroup under a new id; read chats', 4, {chat: chat.migratedTo});
    const reservation = this.store.reserve(payload, record, this.at());
    if (reservation.existing) return reservation.operation;
    let operation = reservation.operation;
    try {
      const response = await call();
      operation = {...operation, ...accept(response), state: 'accepted', updatedAt: this.at()};
    } catch (error) {
      const details = publicError(error);
      const {code, message, exitCode, definitive, ...rest} = details;
      operation = {...operation, state: definitive === true ? 'rejected' : 'uncertain', error: {code, ...rest}, updatedAt: this.at()};
    }
    this.store.saveOperation(operation);
    return operation;
  }
  async send(args) {
    const payload = sendInput(args), {text, ...rest} = payload;
    if (payload.voice && !this.voice) throw fail('VOICE_NOT_CONFIGURED', 'Configure a voice with voice-init before sending voice notes', 3);
    // A voice note is the text spoken in the configured voice; the audio is rendered only when it is really sent.
    return this.act(payload, {...rest, textSha256: hash(text), textLength: text.length, providerMessageId: null}, args,
      async () => payload.voice ? this.provider.sendVoice(payload, await this.voice.speak(text)) : this.provider.sendMessage(payload), response => {
        if (!Number.isSafeInteger(response?.message_id) || String(response?.chat?.id) !== payload.chat) throw fail('PROVIDER_RESPONSE', 'Telegram did not return a message in that chat', 5);
        return {providerMessageId: response.message_id};
      });
  }
  async topic(args) {
    const payload = topicInput(args);
    return this.act(payload, {...payload, providerTopicId: null}, args, () => this.provider.createTopic(payload), response => {
      if (!Number.isSafeInteger(response?.message_thread_id)) throw fail('PROVIDER_RESPONSE', 'Telegram did not return a topic', 5);
      return {providerTopicId: response.message_thread_id};
    });
  }
  async pin(args) {
    const payload = pinInput(args, key => this.store.operation(key));
    return this.act(payload, {...payload, pinned: false}, args, () => this.provider.pin(payload), response => {
      if (response !== true) throw fail('PROVIDER_RESPONSE', 'Telegram did not confirm the pin', 5);
      return {pinned: true};
    });
  }
  async delete(args) {
    const payload = deleteInput(args, key => this.store.operation(key));
    return this.act(payload, {...payload, deleted: false}, args, () => this.provider.deleteMessage(payload), response => {
      if (response !== true) throw fail('PROVIDER_RESPONSE', 'Telegram did not confirm the deletion', 5);
      return {deleted: true};
    });
  }
  // Read-only: what Telegram says about the bot and the chats it has seen.
  async doctor() {
    const me = await this.provider.me(), webhook = await this.provider.webhook();
    const known = this.store.chats().filter(chat => !chat.migratedTo && !['left', 'kicked'].includes(chat.botStatus)).slice(0, 10);
    const chats = await Promise.all(known.map(async chat => {
      const member = await this.provider.member(chat.id, me.id).catch(() => null);
      return {id: chat.id, type: chat.type, title: chat.title, isForum: chat.isForum, botStatus: member?.status === 'creator' ? 'administrator' : member?.status ?? chat.botStatus,
        ...(member ? {canManageTopics: member.status === 'creator' ? true : member.can_manage_topics ?? false,
          canPinMessages: member.status === 'creator' ? true : member.can_pin_messages ?? false,
          canDeleteMessages: member.status === 'creator' ? true : member.can_delete_messages ?? false} : {})};
    }));
    const warnings = [];
    if (webhook?.url) warnings.push('WEBHOOK_ACTIVE: this bot has a webhook, so polling fails; use a bot nobody else serves');
    if (me.can_read_all_group_messages !== true && chats.some(chat => chat.botStatus !== 'administrator'))
      warnings.push('PRIVACY_MODE_ON: the bot sees only commands, mentions and replies in groups where it is not an admin; turn privacy off in BotFather or make it an admin');
    return {bot: {id: me.id, username: me.username, canReadAllGroupMessages: me.can_read_all_group_messages === true}, webhook: {active: Boolean(webhook?.url)}, chats, warnings};
  }
}
