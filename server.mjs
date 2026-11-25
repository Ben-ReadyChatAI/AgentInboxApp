import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { deliverPush, deliverTelegram, subscriptionFrom } from './notifications.mjs';
import { channelPath, fail, namePattern, openStore, questionPath } from './store.mjs';
import { channelDetail, channelFragment, channelList, inbox, login, page, questionDetail, queueFragment } from './views.mjs';

const hash = value => createHash('sha256').update(value).digest();
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
const agentName = new RegExp('^' + namePattern + '$');
const validNext = path => questionPath.test(path || '') || channelPath.test(path || '') || path === '/channels';
const sessionAge = 30 * 24 * 3600;
const publicFiles = new Map(Object.entries({
  '/app.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/manifest.webmanifest': 'application/manifest+json',
  '/icons/inbox-180.png': 'image/png',
  '/icons/inbox-192.png': 'image/png',
  '/icons/inbox-512.png': 'image/png',
}).map(([path, type]) => [path, { type, content: readFileSync(new URL('./public' + path, import.meta.url)) }]));

export function createApp(env) {
  const origin = new URL(env.INBOX_ORIGIN || 'http://localhost:8788').origin;
  if ((env.INBOX_ORIGIN && env.INBOX_ORIGIN !== origin) ||
      (!origin.startsWith('https:') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
    throw new Error('INBOX_ORIGIN must be an HTTPS origin or an HTTP loopback origin.');
  }
  if (!secret(env.OPERATOR_KEY)) throw new Error('Set OPERATOR_KEY to a generated key. Run npm run setup.');
  const operator = hash(env.OPERATOR_KEY);
  let agentConfig;
  try { agentConfig = JSON.parse(env.AGENT_KEYS || '{}'); } catch { throw new Error('AGENT_KEYS must be a JSON object.'); }
  if (!agentConfig || typeof agentConfig !== 'object' || Array.isArray(agentConfig)) throw new Error('AGENT_KEYS must be a JSON object.');
  const agents = Object.entries(agentConfig);
  const enrollment = env.AGENT_ENROLL_KEY || '';
  if (enrollment && (!secret(enrollment) || enrollment === env.OPERATOR_KEY)) {
    throw new Error('AGENT_ENROLL_KEY must be a distinct generated key.');
  }
  if (agents.some(([name, token]) => !agentName.test(name) || !secret(token) || token === env.OPERATOR_KEY || token === enrollment) ||
      new Set(agents.map(([, token]) => token)).size !== agents.length) {
    throw new Error('AGENT_KEYS must map agent names to distinct generated keys.');
  }
  const agentHashes = agents.map(([name, token]) => [name, hash(token)]);
  const enrollmentHash = enrollment ? hash(enrollment) : null;
  const subject = env.VAPID_SUBJECT || (origin.startsWith('https:') ? origin : '');
  const vapid = subject && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? {
    subject, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY,
  } : null;
  const telegram = {
    token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, userId: env.TELEGRAM_USER_ID,
  };
  if (Object.values(telegram).some(Boolean) &&
      (!/^\d+:[\w-]+$/.test(telegram.token || '') || !/^-?\d+$/.test(telegram.chatId || '') ||
        !/^\d+$/.test(telegram.userId || ''))) {
    throw new Error('Set all three Telegram settings or leave them empty.');
  }

  const store = openStore(env.DATABASE_PATH || './data/inbox.sqlite');
  for (const [name] of agents) store.register(name, null);
  const abort = new AbortController();
  const mac = (type, value) => createHmac('sha256', operator).update(type + ':' + value).digest('base64url');
  const cookieName = origin.startsWith('https:') ? '__Host-inbox_session' : 'inbox_session';
  const makeCookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
  function session(req) {
    const raw = req.headers.cookie?.split(';').map(value => value.trim())
      .find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    const match = /^(\d{10}\.[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(raw || '');
    if (!match || Number(match[1].split('.')[0]) <= Math.floor(Date.now() / 1000)) return;
    if (timingSafeEqual(Buffer.from(match[2]), Buffer.from(mac('session', match[1])))) return raw;
  }
  function bearerHash(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) fail(401, 'Send an agent key as a Bearer token.');
    return hash(header.slice(7));
  }
  function authenticateAgent(req) {
    const value = bearerHash(req);
    const agent = agentHashes.find(([, candidate]) => timingSafeEqual(candidate, value))?.[0] ||
      store.agentForKey(value.toString('hex'));
    if (!agent) fail(401, 'Agent key is invalid.');
    return agent;
  }
  function renderFragment(req, res, content, render) {
    const revision = '"' + hash(content).toString('hex') + '"';
    if (req.headers['x-inbox-fragment'] === 'queue') {
      res.setHeader('ETag', revision);
      return req.headers['if-none-match'] === revision ? res.writeHead(304).end() : html(res, 200, content);
    }
    return html(res, 200, render(revision));
  }

  async function handle(req, res) {
    const url = new URL(req.url, origin);
    const { pathname: path } = url;
    const get = req.method === 'GET';
    const post = req.method === 'POST';
    if (get && publicFiles.has(path)) {
      const { content, type } = publicFiles.get(path);
      return write(res, 200, type, content);
    }
    if (get && path === '/health') return json(res, 200, { ok: true });
    if (path.startsWith('/api/')) {
      if (post && path === '/api/agents') {
        if (!enrollmentHash || !timingSafeEqual(bearerHash(req), enrollmentHash)) fail(401, 'Enrollment key is invalid.');
        const { name, key } = await readJson(req);
        if (typeof name !== 'string' || !agentName.test(name)) fail(400, 'Use up to 64 letters, digits, dots, dashes or underscores. Start with a letter or digit.');
        if (!secret(key) || key === enrollment || key === env.OPERATOR_KEY) fail(400, 'Generate a distinct agent key.');
        const keyHash = hash(key);
        if (agentHashes.some(([, candidate]) => timingSafeEqual(candidate, keyHash))) fail(409, 'The agent name or key is already in use.');
        const { created, ...channel } = store.register(name, keyHash.toString('hex'));
        return json(res, created ? 201 : 200, channel);
      }
      const agent = authenticateAgent(req);
      if (post && path === '/api/questions') {
        const input = await readJson(req);
        const result = store.create(agent, input);
        return json(res, result.created ? 201 : 200, result.question);
      }
      if (post && path === '/api/messages') {
        const result = store.message(agent, await readJson(req), 'agent');
        return json(res, result.created ? 201 : 200, result.message);
      }
      if (get && path === '/api/messages') {
        const after = cursor(url.searchParams.get('after'), 0);
        const messages = store.messagesAfter(agent, after);
        return json(res, 200, { messages, cursor: messages.at(-1)?.seq ?? after });
      }
      const id = path.startsWith('/api/questions/') ? questionPath.exec(path.slice(4))?.[1] : null;
      if (get && id) {
        const item = store.read(id);
        if (!item || item.agent !== agent) fail(404, 'Question not found.');
        return json(res, 200, item);
      }
      fail(404, 'API endpoint not found.');
    }

    if (post && req.headers.origin !== origin) fail(403, 'Open the inbox at its configured address.');
    const token = session(req);
    if (path === '/login' && post) {
      const form = await readForm(req);
      const next = validNext(form.get('next')) ? form.get('next') : '/';
      if (!timingSafeEqual(hash(form.get('key') || ''), operator)) {
        return html(res, 401, login(next, 'The access key is incorrect.'));
      }
      const payload = `${Math.floor(Date.now() / 1000) + sessionAge}.${randomBytes(16).toString('hex')}`;
      res.setHeader('Set-Cookie', makeCookie(payload + '.' + mac('session', payload), sessionAge));
      return redirect(res, next);
    }

    const fragment = req.headers['x-inbox-fragment'] === 'queue';
    if (!token) {
      if (fragment || path === '/push') return json(res, 401, { error: 'Sign in again.' });
      if (get) return html(res, 200, login(validNext(path) ? path : '/'));
      fail(401, 'Sign in to continue.');
    }

    const csrf = mac('csrf', token);
    if (post && path === '/push') {
      if (req.headers['x-inbox-csrf'] !== csrf) fail(403, 'Refresh and try again.');
      const body = await readJson(req);
      if (body.remove === true && typeof body.endpoint === 'string') store.unsubscribe(body.endpoint);
      else {
        if (!vapid) fail(503, 'Push notifications are not configured.');
        store.subscribe(subscriptionFrom(body));
      }
      return json(res, 200, { ok: true });
    }

    if (post && path === '/logout') {
      if ((await readForm(req)).get('csrf') !== csrf) fail(403, 'Refresh and try again.');
      res.setHeader('Set-Cookie', makeCookie('', 0));
      return redirect(res, '/');
    }

    if (get && (path === '/' || path === '/login')) {
      const view = url.searchParams.get('view') === 'answered' ? 'answered' : 'pending';
      const content = queueFragment(view, store.list(view));
      return renderFragment(req, res, content, revision => inbox(view, content, revision, csrf, vapid?.publicKey));
    }

    if (get && path === '/channels') {
      const content = channelList(store.channels());
      return renderFragment(req, res, content, revision => inbox('channels', content, revision, csrf, vapid?.publicKey));
    }

    const name = channelPath.exec(path)?.[1];
    if (name && (get || post)) {
      if (!store.agent(name)) fail(404, 'Channel not found.');
      const before = cursor(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
      const history = store.messagesBefore(name, before);
      const content = channelFragment(name, history);
      if (get) {
        return renderFragment(req, res, content, revision =>
          channelDetail(name, content, revision, csrf, randomUUID(), { before: url.searchParams.has('before') }));
      }
      const form = await readForm(req);
      if (form.get('csrf') !== csrf) fail(403, 'Refresh and try again.');
      try {
        store.message(name, { id: form.get('id'), text: form.get('text') }, 'operator');
      } catch (error) {
        if (error.status !== 400 && error.status !== 409) throw error;
        return html(res, error.status, channelDetail(name, content, '', csrf, randomUUID(), {
          error: error.message, draft: form.get('text'),
        }));
      }
      return redirect(res, path + '#latest');
    }

    const id = questionPath.exec(path)?.[1];
    if (id && (get || post)) {
      const item = store.read(id);
      if (!item) fail(404, 'Question not found.');
      if (get) return html(res, 200, questionDetail(item, csrf));
      const form = await readForm(req);
      if (form.get('csrf') !== csrf) fail(403, 'Refresh and try again.');
      try {
        store.answer(id, form.get('answer'), 'web');
      } catch (error) {
        if (error.status !== 400 && error.status !== 409) throw error;
        return html(res, error.status, questionDetail(store.read(id), csrf, error.message, form.get('answer')));
      }
      return redirect(res, path);
    }
    fail(404, 'Page not found.');
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    if (origin.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    handle(req, res).catch(error => {
      if (!error.status) console.error('Request failed:', error.code || error.message);
      const message = error.status ? error.message : 'Something went wrong. Please try again.';
      const status = error.status || 500;
      if (req.url?.startsWith('/api/') || req.url === '/push') return json(res, status, { error: message });
      html(res, status, page('Agent Inbox', `<main><h1>${status}</h1><p>${message}</p><p><a href="/">Open inbox</a></p></main>`));
    });
  });

  const workers = [];
  return {
    server, store,
    startNotifications() {
      if (vapid) workers.push(deliverPush(store, vapid, abort.signal));
      if (telegram.token) workers.push(deliverTelegram(store, telegram, origin, abort.signal));
      for (const worker of workers) worker.catch(error => {
        if (error.name !== 'AbortError') console.error('Notification worker stopped:', error.code || error.message);
      });
    },
    async close() {
      abort.abort();
      await Promise.allSettled(workers);
      await new Promise(resolve => server.close(resolve));
      store.close();
    },
  };
}

function write(res, status, type, content) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    // Same-origin form posts need an Origin header for CSRF validation.
    'Referrer-Policy': 'same-origin',
  });
  res.end(content);
}

const html = (res, status, body) => write(res, status, 'text/html; charset=utf-8', body);
const json = (res, status, body) => write(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
const redirect = (res, path) => res.writeHead(303, { Location: path, 'Cache-Control': 'no-store' }).end();

async function readBody(req, type) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== type) fail(415, 'Unsupported request format.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 32_768) {
      req.resume();
      fail(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req) {
  const body = await readBody(req, 'application/json');
  let input;
  try { input = JSON.parse(body); } catch { fail(400, 'Send valid JSON.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Send a JSON object.');
  return input;
}

async function readForm(req) {
  return new URLSearchParams(await readBody(req, 'application/x-www-form-urlencoded'));
}

function cursor(value, fallback) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, 'Use an integer cursor.');
  return Number(value);
}

if (import.meta.main) {
  process.umask(0o077);
  const app = createApp(process.env);
  const port = Number(process.env.PORT || 8788);
  app.server.listen(port, process.env.BIND_ADDRESS || '127.0.0.1', () => {
    console.log('Agent Inbox listening on port ' + port + '.');
    app.startNotifications();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().catch(error => {
    console.error(error);
    process.exitCode = 1;
  }));
}
