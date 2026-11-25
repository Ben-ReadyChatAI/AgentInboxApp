import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const idPattern = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
export const questionPath = new RegExp('^/questions/(' + idPattern + ')$');
export const namePattern = '[A-Za-z0-9][A-Za-z0-9_.-]{0,63}';
export const channelPath = new RegExp('^/channels/(' + namePattern + ')$');
const requestId = new RegExp(`^${idPattern}$`);

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    fail(400, `${label} must be between 1 and ${max} characters.`);
  }
  return value.trim();
}

function question(row) {
  if (!row) return undefined;
  const { id, agent, run_id, prompt, choices, created_at, answer, answered_at, answered_via } = row;
  return {
    id, agent, run_id, question: prompt, choices: JSON.parse(choices), created_at,
    status: answered_at ? 'answered' : 'pending', answer, answered_at, answered_via,
  };
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, run_id TEXT NOT NULL,
      prompt TEXT NOT NULL, choices TEXT NOT NULL, created_at TEXT NOT NULL,
      answer TEXT, answered_at TEXT, answered_via TEXT, telegram_sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS questions_status ON questions(answered_at, created_at);
    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox_agents (
      name TEXT PRIMARY KEY, key_hash TEXT UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, agent TEXT NOT NULL,
      sender TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (agent, id)
    );
    CREATE INDEX IF NOT EXISTS messages_channel ON messages(agent, seq);
    CREATE TABLE IF NOT EXISTS push_jobs (
      id TEXT NOT NULL, target TEXT NOT NULL,
      endpoint TEXT NOT NULL REFERENCES subscriptions(endpoint) ON DELETE CASCADE,
      next_try INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (id, target, endpoint)
    );
    CREATE TRIGGER IF NOT EXISTS question_push AFTER INSERT ON questions
    BEGIN
      INSERT INTO push_jobs (id, target, endpoint)
        SELECT NEW.id, '/questions/' || NEW.id, endpoint FROM subscriptions;
    END;
    CREATE TRIGGER IF NOT EXISTS message_push AFTER INSERT ON messages
    WHEN NEW.sender = 'agent'
    BEGIN
      INSERT INTO push_jobs (id, target, endpoint)
        SELECT NEW.id, '/channels/' || NEW.agent, endpoint FROM subscriptions;
    END;
    CREATE TRIGGER IF NOT EXISTS clear_question_push AFTER UPDATE OF answered_at ON questions
    WHEN NEW.answered_at IS NOT NULL
    BEGIN
      DELETE FROM push_jobs WHERE id = NEW.id AND target = '/questions/' || NEW.id;
    END;
  `);
  const read = db.prepare('SELECT * FROM questions WHERE id = ?');
  const insert = db.prepare(`INSERT INTO questions (id, agent, run_id, prompt, choices, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
  const finish = db.prepare(`UPDATE questions SET answer = ?, answered_at = ?, answered_via = ?
    WHERE id = ? AND answered_at IS NULL`);
  const pending = db.prepare('SELECT * FROM questions WHERE answered_at IS NULL ORDER BY created_at, id');
  const answered = db.prepare('SELECT * FROM questions WHERE answered_at IS NOT NULL ORDER BY answered_at DESC, id LIMIT 50');
  const unsent = db.prepare(`SELECT * FROM questions WHERE answered_at IS NULL
    AND telegram_sent_at IS NULL ORDER BY created_at, id LIMIT 10`);
  const markSent = db.prepare('UPDATE questions SET telegram_sent_at = ? WHERE id = ?');
  const subscribe = db.prepare(`INSERT INTO subscriptions VALUES (?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription`);
  const unsubscribe = db.prepare('DELETE FROM subscriptions WHERE endpoint = ?');
  const delivery = db.prepare(`SELECT d.*, s.subscription FROM push_jobs d JOIN subscriptions s USING (endpoint)
    WHERE next_try <= ? ORDER BY next_try LIMIT 8`);
  const complete = db.prepare('DELETE FROM push_jobs WHERE id = ? AND target = ? AND endpoint = ?');
  const reschedule = db.prepare(`UPDATE push_jobs SET attempts = attempts + 1, next_try = ?
    WHERE id = ? AND target = ? AND endpoint = ?`);
  const createAgent = db.prepare('INSERT INTO inbox_agents VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  const readAgent = db.prepare('SELECT name, key_hash, created_at FROM inbox_agents WHERE name = ?');
  const agentForKey = db.prepare('SELECT name FROM inbox_agents WHERE key_hash = ?');
  const channels = db.prepare(`SELECT a.name, m.text, m.created_at, m.sender
    FROM inbox_agents a LEFT JOIN messages m ON m.seq = (
      SELECT seq FROM messages WHERE agent = a.name ORDER BY seq DESC LIMIT 1
    ) ORDER BY COALESCE(m.created_at, a.created_at) DESC, a.name`);
  const createMessage = db.prepare(`INSERT INTO messages (id, agent, sender, text, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent, id) DO NOTHING`);
  const readMessage = db.prepare('SELECT * FROM messages WHERE agent = ? AND id = ?');
  const messagesAfter = db.prepare('SELECT * FROM messages WHERE agent = ? AND seq > ? ORDER BY seq LIMIT 100');
  const messagesBefore = db.prepare('SELECT * FROM messages WHERE agent = ? AND seq < ? ORDER BY seq DESC LIMIT 51');

  return {
    create(agent, input) {
      const { id, run_id, question: prompt, choices = [] } = input;
      if (typeof id !== 'string' || !requestId.test(id)) fail(400, 'id must be a lowercase UUID.');
      const run = field(run_id, 'Run ID', 120);
      const text = field(prompt, 'Question', 1500);
      if (!Array.isArray(choices) || choices.length === 1 || choices.length > 5) {
        fail(400, 'Supply two to five choices, or omit choices for a written reply.');
      }
      const options = choices.map(value => {
        const option = field(value, 'Choice', 100);
        if (/[\r\n]/.test(option)) fail(400, 'Put each choice on one line.');
        return option;
      });
      if (new Set(options).size !== options.length) fail(400, 'Choices must be distinct.');
      const serialized = JSON.stringify(options);
      const created = insert.run(id, agent, run, text, serialized, new Date().toISOString()).changes === 1;
      const saved = read.get(id);
      if (saved.agent !== agent || saved.run_id !== run || saved.prompt !== text || saved.choices !== serialized) {
        fail(409, 'This request ID is already in use.');
      }
      return { created, question: question(saved) };
    },
    read: id => question(read.get(id)),
    list: view => (view === 'answered' ? answered : pending).all().map(question),
    register(name, keyHash) {
      const created = createAgent.run(name, keyHash, new Date().toISOString()).changes === 1;
      const saved = readAgent.get(name);
      if (saved?.key_hash !== keyHash) fail(409, 'The agent name or key is already in use.');
      return { created, name: saved.name, created_at: saved.created_at };
    },
    agent: name => readAgent.get(name)?.name,
    agentForKey: keyHash => agentForKey.get(keyHash)?.name,
    channels: () => channels.all(),
    message(agent, input, sender) {
      const { id } = input;
      if (typeof id !== 'string' || !requestId.test(id)) fail(400, 'id must be a lowercase UUID.');
      const text = field(input.text, 'Message', 4000);
      const changes = createMessage.run(id, agent, sender, text, new Date().toISOString()).changes;
      const saved = readMessage.get(agent, id);
      if (saved.sender !== sender || saved.text !== text) fail(409, 'This message ID is already in use.');
      return { created: changes === 1, message: saved };
    },
    messagesAfter: (agent, after) => messagesAfter.all(agent, after),
    messagesBefore(agent, before) {
      const rows = messagesBefore.all(agent, before);
      const older = rows.length > 50;
      const messages = rows.slice(0, 50).reverse();
      return { messages, older: older ? messages[0].seq : null };
    },
    answer(id, input, channel) {
      const saved = question(read.get(id));
      if (!saved) fail(404, 'Question not found.');
      if (saved.status === 'answered') fail(409, 'This question already has an answer.');
      const answer = field(input, 'Answer', 2000);
      if (saved.choices.length && !saved.choices.includes(answer)) fail(400, 'Choose one of the listed answers.');
      if (!finish.run(answer, new Date().toISOString(), channel, id).changes) {
        fail(409, 'This question already has an answer.');
      }
      return question(read.get(id));
    },
    unsent: () => unsent.all().map(question),
    markSent: id => markSent.run(new Date().toISOString(), id),
    subscribe: value => subscribe.run(value.endpoint, JSON.stringify(value)),
    unsubscribe: endpoint => unsubscribe.run(endpoint),
    deliveries: () => delivery.all(Date.now()),
    complete: job => complete.run(job.id, job.target, job.endpoint),
    retry: job => reschedule.run(Date.now() + 10_000 * 2 ** job.attempts, job.id, job.target, job.endpoint),
    close: () => db.close(),
  };
}
