import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {Store} from '../src/store.mjs';
import {Transport} from '../src/transport.mjs';
import {Provider} from '../src/provider.mjs';
import {serve} from '../src/service.mjs';
import {main} from '../src/cli.mjs';
import {config} from '../src/validation.mjs';

const TOKEN = '123456789:AAFakeTokenForOfflineTestsOnly_0123456789abc';
const group = {id: -1001, type: 'supergroup', title: 'Partner handoff', is_forum: true};
const ana = {id: 42, is_bot: false, first_name: 'Ana', last_name: 'B', username: 'ana'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(10)) { const value = await check(); if (value) return value; }
  throw new Error('condition not met');
}
let uid = 1;
const message = (text, extra = {}, chat = group, from = ana) => ({update_id: uid++, message: {message_id: 500 + uid, date: 1792000000, chat, from, text, ...extra}});

// A Bot API stand-in over real HTTP, so the provider's own request building is what the tests exercise.
async function telegram(t, {canRead = true} = {}) {
  const state = {updates: [], requests: [], webhook: '', members: {}, failure: null, next: 100};
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const [, token, method] = request.url.match(/^\/bot([^/]+)\/(\w+)$/) ?? [];
    const reply = (status, payload) => { response.statusCode = status; response.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
    if (token !== TOKEN) return reply(401, {ok: false, error_code: 401, description: 'Unauthorized'});
    const input = body ? JSON.parse(body) : {};
    state.requests.push({method, input});
    if (state.failure?.method === method) { const failure = state.failure; state.failure = null; return reply(failure.status, failure.body); }
    const ok = result => reply(200, {ok: true, result});
    if (method === 'getMe') return ok({id: 777, is_bot: true, username: 'example_group_bot', can_read_all_group_messages: canRead});
    if (method === 'getWebhookInfo') return ok({url: state.webhook});
    if (method === 'getUpdates') {
      if (input.offset) state.updates = state.updates.filter(update => update.update_id >= input.offset);
      if (!state.updates.length) await sleep(15);
      return ok(state.updates.slice(0, input.limit));
    }
    if (method === 'getChatMember') return ok(state.members[input.chat_id] ?? {status: 'member'});
    if (method === 'sendMessage') return ok({message_id: state.next++, chat: {id: Number(input.chat_id)}});
    if (method === 'pinChatMessage' || method === 'deleteMessage') return ok(true);
    if (method === 'createForumTopic') return ok({message_thread_id: 900 + state.requests.filter(r => r.method === method).length, name: input.name});
    return reply(404, {ok: false, error_code: 404, description: 'Not Found'});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.sent = () => state.requests.filter(request => request.method === 'sendMessage');
  return state;
}
async function fixture(t, options) {
  const api = await telegram(t, options);
  const directory = await mkdtemp(join(tmpdir(), 'ez-telegram-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const store = new Store(directory);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const transport = new Transport(store, config({botToken: TOKEN}), {pollTimeout: 0, provider: new Provider(TOKEN, {base: api.base})});
  return {api, store, transport};
}
const known = async (api, transport, ...updates) => { api.updates.push(...updates); await transport.poll(); };

test('captures human group messages and ignores everything else', async t => {
  const {api, store, transport} = await fixture(t);
  api.updates.push(
    message('Reached him', {is_topic_message: true, message_thread_id: 7, reply_to_message: {message_id: 7}}),
    message('Answer', {reply_to_message: {message_id: 55}}),
    message(undefined, {photo: [{}], caption: 'The lot'}),
    message('private', {}, {id: 42, type: 'private'}),
    message('bot talk', {}, group, {id: 9, is_bot: true, first_name: 'Other'}),
    message(undefined, {new_chat_members: [ana]}),
    {update_id: uid++, edited_message: {message_id: 506, date: 1792000000, edit_date: 1792000100, chat: group, from: ana, text: 'Reached him twice'}});
  const {captured} = await transport.poll();
  assert.equal(captured, 4);
  const {events, head} = store.inbox(0, 20);
  assert.deepEqual(events.map(event => [event.kind, event.type, event.text, event.topicId, event.replyTo]), [
    ['message', 'text', 'Reached him', 7, null], ['message', 'text', 'Answer', null, 55],
    ['message', 'photo', 'The lot', null, null], ['edited', 'text', 'Reached him twice', null, null]]);
  assert.deepEqual(events[0].from, {id: 42, username: 'ana', name: 'Ana B'});
  assert.deepEqual(store.chats().map(chat => [chat.id, chat.type, chat.botStatus]), [['-1001', 'supergroup', 'member']]);
  // Telegram redelivering updates before their offset is confirmed adds nothing.
  store.setMeta('offset', 0);
  api.updates.push(message('Reached him'));
  assert.equal((await transport.poll()).captured, 1);
  assert.equal(store.head(), head + 1);
});

test('the bot leaving or the group migrating stops sends', async t => {
  const {api, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  await known(api, transport, {update_id: uid++, my_chat_member: {chat: group, new_chat_member: {status: 'left'}}});
  await assert.rejects(transport.send({chat: '-1001', text: 'x', key: 'k1'}), {code: 'CHAT_UNKNOWN', exitCode: 4});
  await known(api, transport, {update_id: uid++, my_chat_member: {chat: group, new_chat_member: {status: 'administrator'}}});
  assert.equal((await transport.send({chat: '-1001', text: 'x', key: 'k1'})).state, 'accepted');
  await known(api, transport, message(undefined, {migrate_to_chat_id: -1002}));
  await assert.rejects(transport.send({chat: '-1001', text: 'y', key: 'k2'}), {code: 'CHAT_MIGRATED', details: {chat: '-1002'}});
});

test('send posts once per key and keeps no text', async t => {
  const {api, store, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  const args = {chat: '-1001', text: 'Did you reach the owner? @partner', key: 'pa-thread-1', topic: 7, 'reply-to': 55};
  assert.deepEqual(await transport.send({...args, preview: true}), {preview: true, payload: {kind: 'send', key: 'pa-thread-1', chat: '-1001', text: args.text, topic: 7, replyTo: 55}});
  assert.equal(api.sent().length, 0);
  const first = await transport.send(args);
  assert.equal(first.state, 'accepted'); assert.equal(first.providerMessageId, 100);
  assert.deepEqual(api.sent()[0].input, {chat_id: '-1001', text: args.text, link_preview_options: {is_disabled: true}, message_thread_id: 7, reply_parameters: {message_id: 55, allow_sending_without_reply: true}});
  assert.deepEqual(await transport.send(args), first);
  assert.equal(api.sent().length, 1);
  await assert.rejects(transport.send({...args, text: 'different'}), {code: 'KEY_CONFLICT', exitCode: 4});
  await assert.rejects(transport.send({...args, chat: '-999', key: 'other'}), {code: 'CHAT_UNKNOWN'});
  assert.equal(JSON.stringify(store.operation('pa-thread-1')).includes('reach the owner'), false);
});

test('a refused send may be tried again; an unanswered one stays uncertain', async t => {
  const {api, store, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  const args = {chat: '-1001', text: 'ping', key: 'ping-1'};
  api.failure = {method: 'sendMessage', status: 400, body: {ok: false, error_code: 400, description: 'Bad Request: not enough rights'}};
  const refused = await transport.send(args);
  assert.deepEqual([refused.state, refused.error.providerCode, refused.error.description], ['rejected', 400, 'Bad Request: not enough rights']);
  const retried = await transport.send(args);
  assert.deepEqual([retried.state, retried.providerMessageId, api.sent().length], ['accepted', 100, 2]);
  api.failure = {method: 'sendMessage', status: 429, body: {ok: false, error_code: 429, description: 'Too Many Requests', parameters: {retry_after: 7}}};
  const limited = await transport.send({...args, key: 'ping-2'});
  assert.deepEqual([limited.state, limited.error.code, limited.error.retryAfter], ['rejected', 'RATE_LIMITED', 7]);
  api.failure = {method: 'sendMessage', status: 502, body: 'bad gateway'};
  const unsure = await transport.send({...args, key: 'ping-3'});
  assert.equal(unsure.state, 'uncertain');
  const count = api.sent().length;
  assert.equal((await transport.send({...args, key: 'ping-3'})).state, 'uncertain');
  assert.equal(api.sent().length, count);
  assert.equal(store.operation('ping-3').state, 'uncertain');
});

test('topic create makes one topic per key', async t => {
  const {api, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  const topic = await transport.topic({chat: '-1001', name: '12 Example Street', key: 'pa-thread-1'});
  assert.deepEqual([topic.state, topic.providerTopicId], ['accepted', 901]);
  assert.deepEqual(await transport.topic({chat: '-1001', name: '12 Example Street', key: 'pa-thread-1'}), topic);
  assert.equal(api.requests.filter(request => request.method === 'createForumTopic').length, 1);
  assert.equal((await transport.send({chat: '-1001', text: 'in topic', key: 'k', topic: topic.providerTopicId})).state, 'accepted');
});

test('pin pins a sent message once per key, silently by default', async t => {
  const {api, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  const pins = () => api.requests.filter(request => request.method === 'pinChatMessage');
  const sent = await transport.send({chat: '-1001', text: 'Dossier', key: 'dossier-1', topic: 7});
  assert.deepEqual(await transport.pin({'send-key': 'dossier-1', key: 'pin-1', preview: true}),
    {preview: true, payload: {kind: 'pin', key: 'pin-1', chat: '-1001', messageId: sent.providerMessageId, notify: false}});
  const pin = await transport.pin({'send-key': 'dossier-1', key: 'pin-1'});
  assert.deepEqual([pin.state, pin.pinned, pin.messageId], ['accepted', true, sent.providerMessageId]);
  assert.deepEqual(pins()[0].input, {chat_id: '-1001', message_id: sent.providerMessageId, disable_notification: true});
  assert.deepEqual(await transport.pin({chat: '-1001', message: sent.providerMessageId, key: 'pin-1'}), pin);
  assert.equal(pins().length, 1);
  assert.equal((await transport.pin({chat: '-1001', message: 55, key: 'pin-2', notify: true})).state, 'accepted');
  assert.equal(pins()[1].input.disable_notification, false);
  await assert.rejects(transport.pin({'send-key': 'missing', key: 'pin-3'}), {code: 'NOT_FOUND', exitCode: 4});
  await assert.rejects(transport.pin({'send-key': 'dossier-1', chat: '-999', key: 'pin-3'}), {code: 'INVALID_INPUT'});
  await assert.rejects(transport.pin({message: 55, key: 'pin-3'}), {code: 'INVALID_INPUT'});
  api.failure = {method: 'pinChatMessage', status: 400, body: {ok: false, error_code: 400, description: 'Bad Request: not enough rights to manage pinned messages in the chat'}};
  assert.equal((await transport.pin({chat: '-1001', message: 56, key: 'pin-4'})).state, 'rejected');
});

test('delete removes a sent message once per key', async t => {
  const {api, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  const deletes = () => api.requests.filter(request => request.method === 'deleteMessage');
  const sent = await transport.send({chat: '-1001', text: 'Alert', key: 'alert-1', topic: 12});
  const gone = await transport.delete({'send-key': 'alert-1', key: 'delete-1'});
  assert.deepEqual([gone.state, gone.deleted, gone.messageId], ['accepted', true, sent.providerMessageId]);
  assert.deepEqual(deletes()[0].input, {chat_id: '-1001', message_id: sent.providerMessageId});
  assert.deepEqual(await transport.delete({'send-key': 'alert-1', key: 'delete-1'}), gone);
  assert.equal(deletes().length, 1);
  api.failure = {method: 'deleteMessage', status: 400, body: {ok: false, error_code: 400, description: "Bad Request: message can't be deleted"}};
  assert.equal((await transport.delete({chat: '-1001', message: 55, key: 'delete-2'})).state, 'rejected');
  await assert.rejects(transport.delete({'send-key': 'missing', key: 'delete-3'}), {code: 'NOT_FOUND'});
});

test('a consumer reads after its acknowledged cursor, never backward or ahead', async t => {
  const api = await telegram(t);
  const directory = await mkdtemp(join(tmpdir(), 'ez-telegram-cur-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const service = await serve({directory, socketPath: join(directory, 's.sock'), pollTimeout: 0, idleMs: 10,
    provider: connection => new Provider(connection.botToken, {base: api.base})});
  t.after(() => service.close());
  const socketPath = service.socketPath;
  await main(['init'], {socketPath, stdin: Readable.from([JSON.stringify({botToken: TOKEN})])});
  api.updates.push(message('one'), message('two'), message('three'));
  await until(async () => (await main(['inbox', '--consumer', 'pa'], {socketPath})).events.length === 3);
  const first = await main(['inbox', '--consumer', 'pa', '--limit', '2'], {socketPath});
  assert.deepEqual(first.events.map(event => event.text), ['one', 'two']);
  await main(['acknowledge', '--consumer', 'pa', '--cursor', String(first.nextCursor)], {socketPath});
  assert.deepEqual((await main(['inbox', '--consumer', 'pa'], {socketPath})).events.map(event => event.text), ['three']);
  await assert.rejects(main(['acknowledge', '--consumer', 'pa', '--cursor', '1'], {socketPath}), {code: 'CURSOR_MISMATCH'});
  await assert.rejects(main(['acknowledge', '--consumer', 'pa', '--cursor', '99'], {socketPath}), {code: 'CURSOR_AHEAD'});
  assert.deepEqual((await main(['inbox', '--after', '0', '--chat', '-1001', '--limit', '1'], {socketPath})).events.map(event => event.text), ['one']);
});

test('doctor reads the bot and warns about privacy mode and a webhook', async t => {
  const {api, transport} = await fixture(t, {canRead: false});
  await known(api, transport, message('hello'));
  api.webhook = 'https://example.test/hook';
  const report = await transport.doctor();
  assert.deepEqual(report.bot, {id: 777, username: 'example_group_bot', canReadAllGroupMessages: false});
  assert.equal(report.warnings.length, 2);
  api.webhook = ''; api.members['-1001'] = {status: 'administrator', can_manage_topics: true};
  const fixed = await transport.doctor();
  assert.deepEqual([fixed.warnings, fixed.chats[0].canManageTopics, fixed.chats[0].canPinMessages, fixed.chats[0].canDeleteMessages], [[], true, false, false]);
  assert.equal(api.requests.every(request => ['getMe', 'getWebhookInfo', 'getUpdates', 'getChatMember'].includes(request.method)), true);
});

test('the service answers the CLI and never shows the token', async t => {
  const api = await telegram(t);
  const directory = await mkdtemp(join(tmpdir(), 'ez-telegram-svc-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const service = await serve({directory, socketPath: join(directory, 's.sock'), pollTimeout: 0, idleMs: 10, backoffMs: 5,
    provider: connection => new Provider(connection.botToken, {base: api.base})});
  t.after(() => service.close());
  const socketPath = service.socketPath, run = (argv, stdin) => main(argv, {socketPath, ...(stdin === undefined ? {} : {stdin: Readable.from([stdin])})});
  await assert.rejects(run(['chats']), {code: 'NOT_CONFIGURED', exitCode: 3});
  await assert.rejects(run(['init'], JSON.stringify({botToken: `1${TOKEN}`})), {code: 'AUTH_FAILED', exitCode: 3});
  await assert.rejects(run(['init'], JSON.stringify({botToken: 'nope'})), {code: 'INVALID_INPUT'});
  assert.deepEqual((await run(['init'], JSON.stringify({botToken: TOKEN}))).bot, {botId: 777, username: 'example_group_bot'});
  api.updates.push(message('hello'));
  await until(async () => (await run(['chats'])).chats.length === 1);
  assert.equal((await run(['send', '--chat', '-1001', '--text-stdin', '--key', 'm1'], 'line one\nline two\n')).state, 'accepted');
  assert.equal(api.sent()[0].input.text, 'line one\nline two');
  assert.deepEqual((await run(['topic', 'create', '--chat', '-1001', '--name', 'Owner follow-up', '--key', 't1'])).providerTopicId, 901);
  assert.equal((await run(['pin', '--send-key', 'm1', '--key', 'p1'])).pinned, true);
  api.failure = {method: 'pinChatMessage', status: 400, body: {ok: false, error_code: 400, description: 'Bad Request: message to pin not found'}};
  await assert.rejects(run(['pin', '--chat', '-1001', '--message', '9', '--key', 'p2']), {code: 'SEND_REJECTED', exitCode: 4});
  assert.equal((await run(['delete', '--chat', '-1001', '--message', '9', '--key', 'd1'])).deleted, true);
  api.failure = {method: 'sendMessage', status: 400, body: {ok: false, error_code: 400, description: 'Bad Request: chat not found'}};
  await assert.rejects(run(['send', '--chat', '-1001', '--text', 'x', '--key', 'm2']),
    error => error.code === 'SEND_REJECTED' && error.exitCode === 4 && error.details.providerCode === 400 && error.details.reason === 'PROVIDER_REJECTED');
  api.failure = {method: 'sendMessage', status: 500, body: 'down'};
  await assert.rejects(run(['send', '--chat', '-1001', '--text', 'x', '--key', 'm3']), {code: 'UNCERTAIN_SEND', exitCode: 5});
  assert.equal((await run(['operation', '--key', 'm3'])).state, 'uncertain');
  await assert.rejects(run(['send', '--chat', '-1001', '--key', 'm4']), {code: 'INVALID_INPUT'});
  await assert.rejects(run(['send', '--chat', '-1001', '--text', 'x', '--text-stdin', '--key', 'm4'], 'y'), {code: 'INVALID_INPUT'});
  const outputs = JSON.stringify([await run(['status']), await run(['doctor']), await run(['inbox']), await run(['--help'])]);
  assert.equal(outputs.includes(TOKEN) || outputs.includes('AAFakeToken'), false);
  assert.equal((await run(['status'])).configured, true);
});

test('a profile is bound to one bot and the token must be well formed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ez-telegram-bind-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const store = new Store(directory);
  t.after(() => store.close());
  store.binding({botId: 1, username: 'a'});
  assert.throws(() => store.binding({botId: 2, username: 'b'}), {code: 'ACCOUNT_MISMATCH', exitCode: 3});
  assert.throws(() => config({botToken: 'abc'}), {code: 'INVALID_INPUT'});
  assert.throws(() => config({botToken: TOKEN, extra: 1}), {code: 'INVALID_INPUT'});
});
