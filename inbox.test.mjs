import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createApp } from './server.mjs';
import { deliverPush, telegramReply } from './notifications.mjs';
import { openStore } from './store.mjs';

const run = promisify(execFile);
const operator = 'a'.repeat(64);
const writer = 'b'.repeat(64);
const reviewer = 'c'.repeat(64);
const input = (question, fields = {}) => ({ id: randomUUID(), run_id: 'run-1', question, ...fields });

test('two CLI agents get their own replies, ownership survives restart, retries are idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-inbox-'));
  const origin = 'https://inbox.example.test';
  const env = {
    INBOX_ORIGIN: origin, OPERATOR_KEY: operator,
    AGENT_KEYS: JSON.stringify({ writer, reviewer }), DATABASE_PATH: join(dir, 'test.sqlite'),
  };
  let app;
  async function start() {
    app = createApp(env);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + app.server.address().port;
  }
  try {
    let url = await start();
    const first = input('Publish <our draft>?', { choices: ['Yes', 'No'] });
    const second = input('Which logs should I collect?', { run_id: 'run-2' });
    const cli = (key, ...args) => run(process.execPath, ['agent.mjs', ...args], {
      env: { ...process.env, AGENT_INBOX_URL: url, AGENT_INBOX_KEY: key }, timeout: 8000,
    }).then(result => JSON.parse(result.stdout));
    const api = (path, key, body) => fetch(url + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const ask = (key, item) => cli(key, 'ask', item.id, item.run_id, item.question, ...(item.choices || []));
    const submitted = await Promise.all([ask(writer, first), ask(reviewer, second)]);
    assert.deepEqual(submitted.map(item => item.status), ['pending', 'pending']);
    assert.equal((await api('/api/questions', writer, first)).status, 200);
    assert.equal((await api('/api/questions', writer, { ...first, question: 'A different question' })).status, 409);
    assert.equal((await api('/api/questions', reviewer, first)).status, 409);
    assert.equal((await api('/api/questions/' + first.id, reviewer)).status, 404);
    assert.equal((await api('/api/questions/' + first.id, operator)).status, 401);

    await app.close();
    url = await start();
    assert.equal((await (await api('/api/questions/' + second.id, reviewer)).json()).status, 'pending');
    const response = await fetch(url + '/login', {
      method: 'POST', redirect: 'manual', headers: { Origin: origin },
      body: new URLSearchParams({ key: operator, next: '/questions/' + first.id }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/questions/' + first.id);
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const pending = await fetch(url + '/', { headers: { Cookie: cookie } });
    assert.equal(pending.headers.get('referrer-policy'), 'same-origin');
    assert.match(await pending.text(), /Publish &lt;our draft&gt;\?/);
    const fragment = await fetch(url + '/', { headers: { Cookie: cookie, 'X-Inbox-Fragment': 'queue' } });
    assert.equal((await fetch(url + '/', {
      headers: { Cookie: cookie, 'X-Inbox-Fragment': 'queue', 'If-None-Match': fragment.headers.get('etag') },
    })).status, 304);
    const responder = async (item, answer, options = {}) => {
      const path = '/questions/' + item.id;
      const detail = await (await fetch(url + path, { headers: { Cookie: cookie } })).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(detail)?.[1];
      return fetch(url + path, {
        method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: options.origin || origin },
        body: new URLSearchParams({ csrf: options.csrf || csrf, answer }),
      });
    };

    const waiting = cli(writer, 'wait', first.id);
    const alsoWaiting = cli(reviewer, 'wait', second.id);
    assert.equal((await responder(first, 'Not a choice')).status, 400);
    assert.equal((await responder(first, 'Yes', { origin: 'https://another.example' })).status, 403);
    assert.equal((await responder(first, 'Yes', { csrf: 'invalid-token' })).status, 403);
    assert.equal((await responder(first, 'Yes')).status, 303);

    const chat = { chatId: '-55', userId: '10' };
    const reply = {
      chat: { id: -55 }, from: { id: 10 }, text: 'The router logs.',
      reply_to_message: { from: { id: 99 }, text: '#inbox_' + second.id + '\nreviewer' },
    };
    assert.equal(telegramReply(app.store, { ...reply, from: { id: 11 } }, chat, 99), undefined);
    assert.equal(telegramReply(app.store, { ...reply, reply_to_message: undefined }, chat, 99), undefined);
    assert.equal(app.store.read(second.id).status, 'pending');
    assert.equal(telegramReply(app.store, reply, chat, 99), 'Answer saved.');
    assert.equal(telegramReply(app.store, reply, chat, 99), 'This question already has an answer.');

    const answers = await Promise.all([waiting, alsoWaiting]);
    assert.deepEqual(answers.map(({ id, agent, run_id, answer, answered_via }) => ({ id, agent, run_id, answer, answered_via })), [
      { id: first.id, agent: 'writer', run_id: first.run_id, answer: 'Yes', answered_via: 'web' },
      { id: second.id, agent: 'reviewer', run_id: second.run_id, answer: 'The router logs.', answered_via: 'telegram' },
    ]);
    const replay = await ask(writer, first);
    assert.equal(replay.answer, 'Yes');
    assert.match(await (await fetch(url + '/', { headers: { Cookie: cookie } })).text(), /There are no pending questions/);
  } finally {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('push jobs route to the exact question or agent channel without message text', async () => {
  const store = openStore(':memory:');
  const controller = new AbortController();
  const device = { endpoint: 'https://fcm.googleapis.com/fcm/send/device', keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) } };
  try {
    store.subscribe(device);
    const first = input('Sensitive question');
    const canceled = input('Already answered');
    store.create('writer', first);
    store.create('writer', canceled);
    store.answer(canceled.id, 'Done', 'web');
    store.message('writer', { id: randomUUID(), text: 'Sensitive message' }, 'agent');
    store.message('writer', { id: randomUUID(), text: 'Operator reply' }, 'operator');
    assert.equal(store.deliveries().length, 2);
    const deliveries = [];
    await assert.rejects(deliverPush(store, {}, controller.signal, async (...args) => {
      deliveries.push(args);
      controller.abort();
    }), { name: 'AbortError' });
    assert.deepEqual(deliveries.map(([subscription, payload]) => [subscription, JSON.parse(payload)]), [
      [device, { path: '/questions/' + first.id }],
      [device, { path: '/channels/writer' }],
    ]);
    assert.equal(store.deliveries().length, 0);
    store.create('writer', input('Another question'));
    store.unsubscribe(device.endpoint);
    assert.equal(store.deliveries().length, 0);
  } finally {
    store.close();
  }
});

test('a service worker notification click opens the matching question', async () => {
  const handlers = new Map();
  let notification;
  let opened;
  const self = {
    addEventListener: (name, fn) => handlers.set(name, fn),
    registration: { showNotification: async (title, options) => { notification = { title, ...options }; } },
    clients: { matchAll: async () => [], openWindow: async url => { opened = url; } },
    location: { origin: 'https://inbox.example.test' },
  };
  runInNewContext(readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8'), { self, URL });
  const id = randomUUID();
  await new Promise(resolve => handlers.get('push')({ data: { json: () => ({ path: '/questions/' + id }) }, waitUntil: resolve }));
  assert.equal(notification.data.path, '/questions/' + id);
  await new Promise(resolve => handlers.get('notificationclick')({
    notification: { ...notification, close() {} }, waitUntil: resolve,
  }));
  assert.equal(opened, self.location.origin + '/questions/' + id);
});

test('registered CLI agents independently send, read, and resume their conversation after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-channel-'));
  const enrollment = 'd'.repeat(64);
  const origin = 'https://inbox.example.test';
  const env = {
    INBOX_ORIGIN: origin, OPERATOR_KEY: operator, AGENT_ENROLL_KEY: enrollment,
    DATABASE_PATH: join(dir, 'test.sqlite'),
  };
  let app;
  async function start() {
    app = createApp(env);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + app.server.address().port;
  }
  try {
    let url = await start();
    const config = join(dir, 'credentials');
    mkdirSync(config, { mode: 0o700 });
    writeFileSync(join(config, '_enrollment.json'), JSON.stringify({ url, key: enrollment }), { mode: 0o600 });
    const cli = (agent, ...args) => run(process.execPath, ['agent.mjs', ...args], {
      env: {
        ...process.env, AGENT_INBOX_URL: url, AGENT_INBOX_AGENT: agent, AGENT_INBOX_CONFIG_DIR: config,
        AGENT_INBOX_ENROLL_KEY: agent === 'codex' ? enrollment : '', AGENT_INBOX_KEY: '',
      }, timeout: 8000,
    }).then(result => JSON.parse(result.stdout));
    await Promise.all([cli('claude', 'register', 'claude'), cli('codex', 'register', 'codex')]);
    await assert.rejects(run(process.execPath, ['agent.mjs', 'register', 'other'], {
      env: { ...process.env, AGENT_INBOX_URL: 'https://different.example.test', AGENT_INBOX_CONFIG_DIR: config, AGENT_INBOX_ENROLL_KEY: '' },
      timeout: 8000,
    }), /private enrollment key is linked to a different inbox/);
    assert.equal(statSync(join(config, 'claude.json')).mode & 0o777, 0o600);
    assert.equal((await cli('claude', 'register', 'claude')).name, 'claude');
    const badRegistration = await fetch(url + '/api/agents', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + enrollment, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'claude', key: 'e'.repeat(64) }),
    });
    assert.equal(badRegistration.status, 409);
    const headers = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/api/messages', { headers: { ...headers, Authorization: 'Bearer ' + enrollment } })).status, 401);
    const id = randomUUID();
    const first = await cli('claude', 'send', '--id', id, 'From <Claude>');
    await cli('claude', 'send', '--id', id, 'From <Claude>');
    assert.equal((await cli('codex', 'send', 'From Codex')).agent, 'codex');

    const login = await fetch(url + '/login', {
      method: 'POST', redirect: 'manual', headers: { Origin: origin },
      body: new URLSearchParams({ key: operator }),
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const listing = await (await fetch(url + '/channels', { headers: { Cookie: cookie } })).text();
    assert.match(listing, /From &lt;Claude&gt;/);
    assert.match(listing, /From Codex/);
    const page = await (await fetch(url + '/channels/claude', { headers: { Cookie: cookie } })).text();
    assert.match(page, /From &lt;Claude&gt;/);
    assert.doesNotMatch(page, /From Codex/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
    const replyId = /name="id" value="([^"]+)"/.exec(page)?.[1];
    const waiting = cli('claude', 'wait-message', String(first.seq));
    const answer = await fetch(url + '/channels/claude', {
      method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: cookie },
      body: new URLSearchParams({ csrf, id: replyId, text: 'Continue the task.' }),
    });
    assert.equal(answer.status, 303);
    assert.deepEqual((await waiting).messages.map(item => item.text), ['Continue the task.']);
    assert.deepEqual((await cli('codex', 'read')).messages.map(item => item.text), ['From Codex']);
    await app.close();
    app = createApp({ ...env, AGENT_ENROLL_KEY: '' });
    const savedClaude = JSON.parse(readFileSync(join(config, 'claude.json'), 'utf8'));
    const previousPort = Number(new URL(url).port);
    await new Promise(resolve => app.server.listen(previousPort, '127.0.0.1', resolve));
    assert.deepEqual((await cli('claude', 'read')).messages.map(item => item.text), ['From <Claude>', 'Continue the task.']);
    assert.equal(app.store.agentForKey((await import('node:crypto')).createHash('sha256').update(savedClaude.key).digest('hex')), 'claude');
  } finally {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
