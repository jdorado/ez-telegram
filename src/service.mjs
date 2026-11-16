import {createServer} from 'node:http';
import {mkdir, readFile, open, rename, unlink, chmod} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store} from './store.mjs';
import {Transport} from './transport.mjs';
import {Provider} from './provider.mjs';
import {Channel, core} from './channel.mjs';
import {config, integer, key, chatId} from './validation.mjs';
import {fail, publicError} from './errors.mjs';

export async function serve(options = {}) {
  const directory = options.directory ?? '/state/telegram', socketPath = options.socketPath ?? '/plugins/telegram/service.sock';
  const connectionFile = join(directory, 'connection.json'), coreFile = join(directory, 'core.json');
  await mkdir(directory, {recursive: true, mode: 0o700});
  // A held SQLite lock is released by the OS when the container dies, so no stale lock file exists.
  const writer = new DatabaseSync(join(directory, '.writer.sqlite'), {timeout: 0});
  try { writer.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS writer (id INTEGER);'); }
  catch { writer.close(); throw fail('ALREADY_RUNNING', 'Another plugin service owns this profile'); }
  let store, server;
  try {
    store = new Store(directory);
    let transport, closed = false, initializing = false, abort = new AbortController(), inflight = null, loop;
    const active = new Set();
    const now = options.now ?? Date.now;
    const make = connection => new Transport(store, connection, {now, pollTimeout: options.pollTimeout,
      ...(options.provider ? {provider: options.provider(connection)} : {})});
    const sleep = ms => new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
    });
    try {
      const {version, ...fields} = JSON.parse(await readFile(connectionFile, 'utf8'));
      if (version !== 1) throw fail('CORRUPT_STATE', 'Unsupported configuration schema');
      transport = make(config(fields));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error.exitCode ? error : fail('CORRUPT_STATE', 'Configuration is unreadable; preserve it and investigate');
    }
    let channel = null;
    const makeChannel = connection => new Channel(store, connection, {fetch: options.fetch});
    try { channel = makeChannel(core(JSON.parse(await readFile(coreFile, 'utf8')))); }
    catch (error) { if (error.code !== 'ENOENT') throw error.exitCode ? error : fail('CORRUPT_STATE', 'Ez connection is unreadable; preserve it and investigate'); }
    // Admit new messages to Ez and post the agent's replies, every couple of seconds.
    async function pump() {
      while (!closed) {
        if (channel && transport && !initializing) {
          try {
            const admitted = await channel.admit(), posted = await channel.deliver(args => transport.send(args));
            store.setMeta('channelPass', {at: new Date(now()).toISOString(), error: null, admitted, posted});
          } catch (error) { if (!closed) store.setMeta('channelPass', {at: new Date(now()).toISOString(), error: publicError(error).code}); }
        }
        await sleep(options.channelMs ?? 2000);
      }
    }
    const required = () => { if (!transport) throw fail('NOT_CONFIGURED', 'Initialize the plugin privately before provider operations', 3); return transport; };
    async function run() {
      let errors = 0;
      while (!closed) {
        if (!transport || initializing) { await sleep(options.idleMs ?? 500); continue; }
        try { inflight = transport.poll(abort.signal); await inflight; errors = 0; }
        catch (error) {
          if (closed || abort.signal.aborted) continue;
          errors++;
          await sleep(Math.min(60000, (error.details?.retryAfter ?? 0) * 1000 || (options.backoffMs ?? 1000) * 2 ** Math.min(errors, 6)));
        } finally { inflight = null; }
      }
    }
    async function call(command, args = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('INVALID_INPUT', 'Expected command arguments');
      if (initializing && !['health', 'status', 'inbox', 'operation'].includes(command)) throw fail('BUSY', 'Configuration is being updated');
      if (command === 'health') return {service: 'ready'};
      if (command === 'status') return {configured: Boolean(transport), channelConnected: Boolean(channel), ...store.status()};
      if (command === 'init') {
        initializing = true; abort.abort(); await inflight?.catch(() => {});
        try {
          const connection = config(args.configuration);
          const provider = options.provider ? options.provider(connection) : new Provider(connection.botToken);
          const me = await provider.me();
          const identity = {botId: me.id, username: me.username};
          store.binding(identity, false);
          // A crash after the file commit resumes with the saved token on the next start.
          await atomicPrivate(connectionFile, connection);
          store.binding(identity);
          transport = make(connection);
          return {configured: true, bot: identity};
        } finally { abort = new AbortController(); initializing = false; }
      }
      if (command === 'connect') {
        const connection = core(args.configuration), candidate = makeChannel(connection);
        const registration = await candidate.registration();
        // Start at the current head: messages captured before the channel was connected are not replayed.
        if (store.meta('admitted') === null) store.setMeta('admitted', store.head());
        await atomicPrivate(coreFile, connection);
        channel = candidate;
        return {connected: true, bindingId: registration.bindingId ?? null, admitted: store.meta('admitted')};
      }
      if (command === 'inbox') {
        const consumer = args.consumer === undefined ? undefined : key(args.consumer);
        const after = args.after !== undefined ? integer(args.after, 0, Number.MAX_SAFE_INTEGER, 'cursor') : consumer ? store.consumer(consumer) : 0;
        if (after > store.head()) throw fail('CURSOR_AHEAD', 'Cursor is beyond this journal');
        return store.inbox(after, integer(args.limit ?? 20, 1, 100, 'limit'), args.chat === undefined ? undefined : chatId(args.chat));
      }
      if (command === 'acknowledge') return store.acknowledge(key(args.consumer), integer(args.cursor, 0, Number.MAX_SAFE_INTEGER, 'cursor'));
      if (command === 'operation') {
        const operation = store.operation(key(args.key));
        if (!operation) throw fail('NOT_FOUND', 'Operation not found');
        return operation;
      }
      const current = required();
      if (command === 'doctor') return {...await current.doctor(), configured: true, ...store.status()};
      if (command === 'chats') return current.chats();
      if (command === 'send') return current.send(args);
      if (command === 'topic') return current.topic(args);
      if (command === 'pin') return current.pin(args);
      if (command === 'delete') return current.delete(args);
      throw fail('INVALID_INPUT', 'Unknown command; read --help');
    }
    await mkdir(dirname(socketPath), {recursive: true, mode: 0o700});
    server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      try {
        if (request.method !== 'POST' || request.url !== '/') throw fail('INVALID_INPUT', 'POST / required');
        let body = '';
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 65536) throw fail('INVALID_INPUT', 'Request exceeds size limit'); }
        let input;
        try { input = JSON.parse(body); } catch { throw fail('INVALID_INPUT', 'Expected JSON'); }
        if (Object.keys(input).some(name => !['command', 'args'].includes(name))) throw fail('INVALID_INPUT', 'Invalid request fields');
        const operation = call(input.command, input.args ?? {});
        active.add(operation);
        let data;
        try { data = await operation; } finally { active.delete(operation); }
        response.end(JSON.stringify({ok: true, data}));
      } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ok: false, error: publicError(error)})); }
    });
    server.requestTimeout = 45000;
    // Only the profile's exclusive writer can remove its old socket.
    await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
    loop = Promise.all([run(), pump()]);
    return {store, call, socketPath, close: async () => {
      if (closed) return;
      closed = true; abort.abort();
      server.close(); server.closeAllConnections();
      await loop;
      // A send in progress already has a durable uncertain reservation.
      await Promise.allSettled([...active]);
      store.close();
      writer.exec('ROLLBACK'); writer.close();
      await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }};
  } catch (error) {
    server?.close();
    store?.close();
    writer.close();
    throw error;
  }
}

async function atomicPrivate(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify({...value})); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
