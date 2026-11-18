import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync, existsSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fail} from './errors.mjs';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => value === undefined ? null : JSON.stringify(value);
const read = row => row ? JSON.parse(row.value) : null;

export class Store {
  constructor(directory) {
    mkdirSync(directory, {recursive: true, mode: 0o700});
    if (lstatSync(directory).isSymbolicLink()) throw fail('INVALID_STATE', 'State directory cannot be a symlink');
    this.directory = directory;
    this.file = join(directory, 'telegram.sqlite');
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw fail('INVALID_STATE', 'State database cannot be a symlink');
    this.db = new DatabaseSync(this.file, {timeout: 1000});
    chmodSync(this.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, chat TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation (key TEXT PRIMARY KEY, value TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consumer (id TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS run (id TEXT PRIMARY KEY, value TEXT NOT NULL, closed TEXT);`);
    if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('CORRUPT_STATE', 'Database integrity check failed');
    if (!this.meta('schema')) this.setMeta('schema', 1);
    if (this.meta('schema') !== 1) throw fail('CORRUPT_STATE', 'Unsupported state schema');
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  meta(name) { return read(this.db.prepare('SELECT value FROM meta WHERE key=?').get(name)); }
  setMeta(name, value) { this.db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, json(value)); }
  // One profile serves one bot: a different bot gets its own profile, never this journal.
  binding(identity, commit = true) {
    const old = this.meta('binding');
    if (old && old.botId !== identity.botId) throw fail('ACCOUNT_MISMATCH', 'Use a separate plugin profile for a different bot', 3);
    if (commit) this.setMeta('binding', identity);
  }
  chats() { return this.db.prepare('SELECT value FROM chat ORDER BY id').all().map(read); }
  chat(id) { return read(this.db.prepare('SELECT value FROM chat WHERE id=?').get(id)); }
  // Everything a poll learned commits with its offset, so a crash replays updates instead of losing them.
  ingest(items, nextOffset, now) {
    return this.transaction(() => {
      let captured = 0;
      for (const {chat, event} of items) {
        const old = this.chat(chat.id);
        const fields = Object.fromEntries(Object.entries(chat).filter(([, value]) => value !== undefined));
        // A message proves the bot is in the chat; a leave or kick says so explicitly.
        const merged = {...old, ...fields, botStatus: fields.botStatus ?? old?.botStatus ?? 'member', seenAt: now};
        this.db.prepare('INSERT INTO chat VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(chat.id, json(merged));
        // Look first: an ignored insert would still advance the autoincrement counter and leave gaps in the cursor.
        if (event && !this.db.prepare('SELECT 1 FROM event WHERE id=?').get(event.id)) {
          this.db.prepare('INSERT INTO event(id, chat, value) VALUES (?, ?, ?)').run(event.id, event.chat, json(event));
          captured++;
        }
      }
      this.setMeta('offset', nextOffset);
      return captured;
    });
  }
  head() { return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM event').get().seq); }
  inbox(after, limit, chat) {
    const rows = chat === undefined
      ? this.db.prepare('SELECT seq,value FROM event WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit)
      : this.db.prepare('SELECT seq,value FROM event WHERE seq>? AND chat=? ORDER BY seq LIMIT ?').all(after, chat, limit);
    const events = rows.map(row => {
      const event = {seq: Number(row.seq), ...JSON.parse(row.value)}, topic = event.topicId ? this.topic(event.chat, event.topicId) : null;
      return topic ? {...event, topic} : event;
    });
    return {events, nextCursor: rows.length ? Number(rows.at(-1).seq) : after, head: this.head()};
  }
  // A topic this bot created: the key it was created under (which names what the topic is for) and its current name.
  topic(chat, id) {
    const created = read(this.db.prepare(`SELECT value FROM operation WHERE state='accepted' AND json_extract(value,'$.kind')='topic'
      AND json_extract(value,'$.chat')=? AND json_extract(value,'$.providerTopicId')=?`).get(chat, id));
    if (!created) return null;
    const renamed = read(this.db.prepare(`SELECT value FROM operation WHERE state='accepted' AND json_extract(value,'$.kind')='topic-rename'
      AND json_extract(value,'$.chat')=? AND json_extract(value,'$.topic')=? ORDER BY json_extract(value,'$.updatedAt') DESC LIMIT 1`).get(chat, id));
    return {key: created.key, name: renamed?.name ?? created.name};
  }
  consumer(id) { return Number(this.db.prepare('SELECT cursor FROM consumer WHERE id=?').get(id)?.cursor ?? 0); }
  acknowledge(id, cursor) {
    if (cursor > this.head()) throw fail('CURSOR_AHEAD', 'Cursor is beyond this journal');
    if (cursor < this.consumer(id)) throw fail('CURSOR_MISMATCH', 'Acknowledgment cannot move backward');
    this.db.prepare('INSERT INTO consumer VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor').run(id, cursor);
    return {consumer: id, cursor};
  }
  operation(key) { return read(this.db.prepare('SELECT value FROM operation WHERE key=?').get(key)); }
  // A key is one intent. The same key with the same content reads its operation; a refused (`rejected`)
  // one never happened, so the same intent may be tried again. Different content under a key is an error.
  reserve(payload, record, now) {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM operation WHERE key=?').get(payload.key);
      const digest = hash(payload);
      if (old && old.digest !== digest) throw fail('KEY_CONFLICT', 'Operation key is already bound to a different payload', 4);
      if (old && old.state !== 'rejected') return {existing: true, operation: JSON.parse(old.value)};
      const operation = {...record, state: 'uncertain', createdAt: old ? JSON.parse(old.value).createdAt : now, updatedAt: now};
      this.db.prepare('INSERT INTO operation VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, state=excluded.state').run(payload.key, json(operation), digest, operation.state);
      return {existing: false, operation};
    });
  }
  saveOperation(operation) { this.db.prepare('UPDATE operation SET value=?,state=? WHERE key=?').run(json(operation), operation.state, operation.key); }
  // Ez runs this channel admitted; open until their result is posted.
  openRun(record) { this.db.prepare('INSERT INTO run VALUES (?,?,NULL) ON CONFLICT(id) DO NOTHING').run(record.runId, json(record)); }
  openRuns() { return this.db.prepare('SELECT value FROM run WHERE closed IS NULL ORDER BY rowid').all().map(read); }
  saveRun(record) { this.db.prepare('UPDATE run SET value=? WHERE id=?').run(json(record), record.runId); }
  closeRun(id, state) { this.db.prepare('UPDATE run SET closed=? WHERE id=?').run(state, id); }
  status() {
    const states = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM operation GROUP BY state').all().map(row => [row.state, Number(row.n)]));
    return {head: this.head(), binding: this.meta('binding'), offset: this.meta('offset'), lastPoll: this.meta('lastPoll'),
      chatCount: Number(this.db.prepare('SELECT count(*) AS n FROM chat').get().n), operations: states,
      channel: {admitted: this.meta('admitted'), openRuns: Number(this.db.prepare('SELECT count(*) AS n FROM run WHERE closed IS NULL').get().n),
        runs: Object.fromEntries(this.db.prepare('SELECT closed,count(*) AS n FROM run WHERE closed IS NOT NULL GROUP BY closed').all().map(row => [row.closed, Number(row.n)])),
        lastPass: this.meta('channelPass'), scheduledPass: this.meta('scheduledPass')}};
  }
}
