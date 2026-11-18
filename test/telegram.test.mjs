import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {Transport} from '../src/transport.mjs';
import {Provider} from '../src/provider.mjs';
import {serve} from '../src/service.mjs';
import {main} from '../src/cli.mjs';
import {config} from '../src/validation.mjs';
import {runText} from '../src/channel.mjs';

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
  const state = {updates: [], requests: [], webhook: '', members: {}, failure: null, next: 100, files: {}};
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks), body = raw.toString();
    const reply = (status, payload) => { response.statusCode = status; response.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
    const download = request.url.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (download) return download[1] === TOKEN && state.files[download[2]] ? response.end(state.files[download[2]]) : reply(404, 'missing');
    const [, token, method] = request.url.match(/^\/bot([^/]+)\/(\w+)$/) ?? [];
    if (token !== TOKEN) return reply(401, {ok: false, error_code: 401, description: 'Unauthorized'});
    const multipart = request.headers['content-type']?.startsWith('multipart/');
    const input = multipart ? Object.fromEntries(await new Response(raw, {headers: {'content-type': request.headers['content-type']}}).formData()) : body ? JSON.parse(body) : {};
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
    if (method === 'pinChatMessage' || method === 'deleteMessage' || method === 'editForumTopic') return ok(true);
    if (method === 'getFile') return ok({file_id: input.file_id, file_path: `files/${input.file_id}`});
    if (method === 'sendVoice') return ok({message_id: state.next++, chat: {id: Number(input.chat_id)}, voice: {file_id: 'v'}});
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
  const bold = await transport.send({chat: '-1001', text: '<b>CALL 555 · CODE 12</b>', key: 'bold-1', html: true});
  assert.deepEqual([bold.state, bold.html, api.sent().at(-1).input.parse_mode], ['accepted', true, 'HTML']);
  await assert.rejects(transport.send({chat: '-1001', text: '<b>CALL 555 · CODE 12</b>', key: 'bold-1'}), {code: 'KEY_CONFLICT'});
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

test('a message in a topic the bot created carries its key and current name', async t => {
  const {api, store, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  const topic = await transport.topic({chat: '-1001', name: '12 Example Street', key: 'pa-topic-L1'});
  await transport.topicRename({chat: '-1001', topic: topic.providerTopicId, name: '🔴 12 Example Street', key: 'name-1'});
  await known(api, transport, message('comps?', {is_topic_message: true, message_thread_id: topic.providerTopicId}));
  const event = store.inbox(0, 10).events.at(-1);
  assert.deepEqual(event.topic, {key: 'pa-topic-L1', name: '🔴 12 Example Street'});
  assert.match(runText(event, null), /topic 901 "🔴 12 Example Street", which you created under key pa-topic-L1/);
});

test('topic rename gives a topic a new name once per key', async t => {
  const {api, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  const args = {chat: '-1001', topic: 901, name: '🔴 Today 2pm · 12 Example Street', key: 'name-1'};
  assert.deepEqual(await transport.topicRename({...args, preview: true}),
    {preview: true, payload: {kind: 'topic-rename', key: 'name-1', chat: '-1001', topic: 901, name: args.name}});
  const renamed = await transport.topicRename(args);
  assert.deepEqual([renamed.state, renamed.renamed, renamed.name], ['accepted', true, args.name]);
  assert.deepEqual(await transport.topicRename(args), renamed);
  assert.deepEqual(api.requests.filter(request => request.method === 'editForumTopic').map(request => request.input),
    [{chat_id: '-1001', message_thread_id: 901, name: args.name}]);
  await assert.rejects(transport.topicRename({...args, key: 'name-2', topic: undefined}), {code: 'INVALID_INPUT'});
  await assert.rejects(transport.topicRename({...args, key: 'name-2', name: ''}), {code: 'INVALID_INPUT'});
  api.failure = {method: 'editForumTopic', status: 400, body: {ok: false, error_code: 400, description: 'Bad Request: TOPIC_NOT_MODIFIED'}};
  assert.equal((await transport.topicRename({...args, key: 'name-3'})).state, 'rejected');
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

// An Ez application-channel stand-in: admits runs by requestId and returns the agent's messages.
async function ezCore(t) {
  const state = {runs: new Map(), requests: [], token: 'a'.repeat(43)};
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const reply = (status, payload) => { response.statusCode = status; response.end(JSON.stringify(payload)); };
    if (request.headers.authorization !== `Bearer ${state.token}`) return reply(401, {error: 'unauthorized'});
    state.requests.push({method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined});
    if (request.url === '/v1/registration') return reply(200, {bindingId: 'binding-1'});
    if (request.method === 'POST' && request.url === '/v1/runs') {
      const input = JSON.parse(body), id = `r_app_${createHash('sha256').update(input.requestId).digest('hex')}`;
      if (!state.runs.has(id)) state.runs.set(id, {id, scope: input.scope, status: 'queued', messages: [], input});
      return reply(202, state.runs.get(id));
    }
    if (request.method === 'GET' && request.url === '/v1/runs') return reply(200, {runs: [...state.runs.values()]});
    const run = state.runs.get(request.url.replace('/v1/runs/', ''));
    return run ? reply(200, run) : reply(404, {error: 'not found'});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  state.url = `http://127.0.0.1:${server.address().port}`;
  return state;
}

test('a group message starts an agent run per topic and the reply is posted back into the topic', async t => {
  const api = await telegram(t), ez = await ezCore(t);
  const directory = await mkdtemp(join(tmpdir(), 'ez-telegram-chan-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const heard = fakeVoice();
  const service = await serve({directory, socketPath: join(directory, 's.sock'), pollTimeout: 0, idleMs: 10, channelMs: 10, voice: () => heard,
    provider: connection => new Provider(connection.botToken, {base: api.base})});
  t.after(() => service.close());
  const run = (argv, stdin) => main(argv, {socketPath: service.socketPath, ...(stdin === undefined ? {} : {stdin: Readable.from([stdin])})});
  await run(['init'], JSON.stringify({botToken: TOKEN}));
  assert.deepEqual(await run(['voice-init'], JSON.stringify({elevenlabsApiKey: 'k'.repeat(32), voiceId: 'ySMglbMCoF5uHwNM8c9v'})), {voice: true, voiceId: 'ySMglbMCoF5uHwNM8c9v', model: 'eleven_multilingual_v2'});
  assert.deepEqual(await run(['dms', '--allow', '42']), {dmAllow: ['42']});
  api.updates.push(message('before the channel'));
  await until(async () => (await run(['status'])).head === 1);
  await assert.rejects(run(['connect'], JSON.stringify({url: ez.url, token: 'b'.repeat(43), privateHttp: true})), {code: 'CORE_AUTH'});
  await assert.rejects(run(['connect'], JSON.stringify({url: ez.url, token: ez.token})), {code: 'INVALID_INPUT'});
  assert.deepEqual(await run(['connect'], JSON.stringify({url: ez.url, token: ez.token, privateHttp: true})), {connected: true, bindingId: 'binding-1', admitted: 1});
  api.updates.push(message('@example_group_bot when did it enter BoldTrail?', {is_topic_message: true, message_thread_id: 12}));
  await until(() => ez.runs.size === 1);
  const [admitted] = ez.runs.values();
  assert.equal(admitted.scope, 'telegram:-1001:12');
  assert.equal(admitted.input.text, `Telegram group "Partner handoff" (-1001), topic 12, message ${admitted.input.context.telegram.messageId}, from Ana B @ana:\n@example_group_bot when did it enter BoldTrail?\n\n(Your text replies in this run are posted here. To reply with a voice note instead: ez telegram send --voice --chat -1001 --topic 12 --reply-to ${admitted.input.context.telegram.messageId} --key NEW_KEY --text "...", and send no text reply.)`);
  assert.deepEqual(admitted.input.context.telegram.topicId, 12);
  Object.assign(admitted, {status: 'completed', messages: [{id: 'm1', text: 'It entered BoldTrail on Nov 15 at 6:18 am ET.'}]});
  await until(() => api.sent().length === 1);
  assert.deepEqual(api.sent()[0].input, {chat_id: '-1001', text: 'It entered BoldTrail on Nov 15 at 6:18 am ET.', link_preview_options: {is_disabled: true},
    message_thread_id: 12, reply_parameters: {message_id: admitted.input.context.telegram.messageId, allow_sending_without_reply: true}});
  await until(async () => (await run(['status'])).channel.openRuns === 0);
  await sleep(50);
  assert.equal(api.sent().length, 1);
  assert.equal(ez.requests.filter(request => request.method === 'POST' && request.url === '/v1/runs').length, 1);
  assert.deepEqual((await run(['status'])).channel.runs, {completed: 1});
  // A photo is attached to the run; a voice note arrives as its transcript; an oversized file becomes a note.
  api.files['files/photo-big'] = Buffer.from('JPEGDATA');
  api.files['files/voice-1'] = Buffer.from('OGGVOICE');
  api.updates.push(message(undefined, {photo: [{file_id: 'photo-small'}, {file_id: 'photo-big', file_size: 8}], caption: 'the lot', is_topic_message: true, message_thread_id: 12}),
    message(undefined, {voice: {file_id: 'voice-1', duration: 4, mime_type: 'audio/ogg'}, is_topic_message: true, message_thread_id: 12}),
    message(undefined, {document: {file_id: 'doc-huge', file_name: 'deed.pdf', file_size: 20 * 1024 * 1024}, is_topic_message: true, message_thread_id: 12}));
  await until(() => ez.runs.size === 4);
  const [, photo, voice, huge] = [...ez.runs.values()].map(item => item.input);
  assert.match(photo.text, /\n\[photo attached\] the lot\n\n\(Your text replies/);
  assert.equal(photo.attachment.name.startsWith('photo-'), true);
  assert.equal(Buffer.from(photo.attachment.data, 'base64').toString(), 'JPEGDATA');
  assert.match(voice.text, /\n\[voice 4s, transcript\] call the owner back at noon\n\n\(Your text replies/);
  assert.equal(voice.attachment, undefined);
  assert.match(huge.text, /\n\[document of 20.0 MB not passed on: over 10 MB\]\n\n\(Your text replies/);
});

test('scheduled results post only to their authorized Telegram scope and keep one receipt per send', async t => {
  const api = await telegram(t), ez = await ezCore(t);
  const directory = await mkdtemp(join(tmpdir(), 'ez-telegram-scheduled-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const service = await serve({directory, socketPath: join(directory, 's.sock'), pollTimeout: 0, idleMs: 10,
    channelMs: 10, scheduledSweepMs: 20, provider: connection => new Provider(connection.botToken, {base: api.base})});
  t.after(() => service.close());
  const run = (argv, stdin) => main(argv, {socketPath: service.socketPath, ...(stdin === undefined ? {} : {stdin: Readable.from([stdin])})});
  await run(['init'], JSON.stringify({botToken: TOKEN}));
  await run(['dms', '--allow', '42']);
  api.updates.push(message('Known direct chat', {}, {id: 42, type: 'private'}));
  await until(async () => (await run(['status'])).head === 1);
  const connect = options => run(['connect'], JSON.stringify({url: ez.url, token: ez.token, privateHttp: true, ...options}));
  const register = (id, scope, text) => ez.runs.set(id, {id, scope, status: 'completed', messages: [{id: 'm1', text}]});
  const scheduled = `r_schedule_${'a'.repeat(64)}`;
  register(scheduled, 'telegram:42:17', 'Scheduled brief');
  register(`r_schedule_${'b'.repeat(64)}`, 'telegram:43:main', 'Disallowed recipient');
  register(`r_schedule_${'c'.repeat(64)}`, 'slack:team:channel', 'Different channel');
  register(`r_app_${'d'.repeat(64)}`, 'telegram:42:main', 'Foreground result without an admitted message');
  await connect();
  await sleep(50);
  assert.equal(api.sent().length, 0);
  await connect({scheduledReplies: true, directMessagesOnly: true});
  api.updates.push(message('Group message cannot start a run on this binding'));
  register(`r_schedule_${'e'.repeat(64)}`, 'telegram:-1001:main', 'Groups cannot receive scheduled replies on this binding');
  await until(() => api.sent().length === 1);
  assert.deepEqual(api.sent()[0].input, {chat_id: '42', text: 'Scheduled brief', link_preview_options: {is_disabled: true}, message_thread_id: 17});
  const key = `run-${createHash('sha256').update(`${scheduled}:m1:0`).digest('hex').slice(0, 40)}`;
  await until(async () => (await run(['operation', '--key', key])).state === 'accepted');
  await sleep(80);
  assert.equal(api.sent().length, 1);
  assert.equal(ez.requests.filter(request => request.method === 'POST').length, 0);
});

const fakeVoice = () => ({spoken: [], heard: [],
  async speak(text) { this.spoken.push(text); return Buffer.concat([Buffer.from('OggS'), Buffer.from(text)]); },
  async transcribe(bytes) { this.heard.push(bytes.toString()); return 'call the owner back at noon'; }});

test('direct messages reach the journal only from allowed users', async t => {
  const {api, store, transport} = await fixture(t);
  const juan = {id: 42, type: 'private', first_name: 'Ana'};
  api.updates.push(message('not yet allowed', {}, juan));
  await transport.poll();
  assert.equal(store.head(), 0);
  store.setMeta('dmAllow', ['42']);
  api.updates.push(message('echo test 2', {}, juan), message('stranger', {}, {id: 7, type: 'private'}, {id: 7, is_bot: false, first_name: 'X'}));
  await transport.poll();
  assert.deepEqual(store.inbox(0, 10).events.map(event => [event.chat, event.text]), [['42', 'echo test 2']]);
  assert.equal(store.chat('42').type, 'private');
  assert.equal((await transport.send({chat: '42', text: 'echo', key: 'dm-1'})).state, 'accepted');
});

test('send --voice speaks the text in the configured voice and posts a voice note once', async t => {
  const {api, transport} = await fixture(t);
  await known(api, transport, message('hello'));
  await assert.rejects(transport.send({chat: '-1001', text: 'hi', key: 'v1', voice: true}), {code: 'VOICE_NOT_CONFIGURED'});
  transport.voice = fakeVoice();
  await assert.rejects(transport.send({chat: '-1001', text: '<b>x</b>', key: 'v1', voice: true, html: true}), {code: 'INVALID_INPUT'});
  const sent = await transport.send({chat: '-1001', text: 'It entered BoldTrail yesterday.', key: 'v1', voice: true, topic: 12, 'reply-to': 55});
  assert.deepEqual([sent.state, sent.voice], ['accepted', true]);
  const request = api.requests.find(item => item.method === 'sendVoice');
  assert.deepEqual([request.input.chat_id, request.input.message_thread_id, JSON.parse(request.input.reply_parameters).message_id], ['-1001', '12', 55]);
  assert.equal(Buffer.from(await request.input.voice.arrayBuffer()).subarray(0, 4).toString(), 'OggS');
  assert.deepEqual(await transport.send({chat: '-1001', text: 'It entered BoldTrail yesterday.', key: 'v1', voice: true, topic: 12, 'reply-to': 55}), sent);
  assert.deepEqual(transport.voice.spoken, ['It entered BoldTrail yesterday.']);
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
  assert.equal((await run(['send', '--chat', '-1001', '--text', '<b>x</b>', '--html', '--key', 'h1'])).html, true);
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
