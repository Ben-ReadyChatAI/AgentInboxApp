#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const configuration = process.env.AGENT_INBOX_CONFIG_DIR ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agent-inbox');
const agentName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const defaultUrl = 'http://localhost:8788';

const usage = `Agent Inbox
  register <name>                       Claim a persistent channel
  send [--id <uuid>] "<message>"         Message the operator
  read [cursor]                         Fetch channel history
  wait-message [cursor]                 Wait for the next operator message
  ask [<uuid>] <run-id> "<question>" [choices...]
  answer <uuid>                         Check a question once
  wait <uuid>                           Wait for the answer

Set AGENT_INBOX_AGENT to select a registered name, or AGENT_INBOX_KEY for a provisioned key.
Set AGENT_INBOX_URL explicitly if the inbox is not on localhost.
Registration uses AGENT_INBOX_ENROLL_KEY or the private _enrollment.json configuration.`;

function resolveOrigin(value) {
  const url = new URL(value);
  if (url.href !== url.origin + '/' ||
      (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use an HTTPS inbox origin or a local loopback address.');
  }
  return url.origin;
}

function readConfigFile(filename) {
  try { return JSON.parse(readFileSync(join(configuration, filename), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function readConfig(name) {
  if (!agentName.test(name)) throw new Error('Enter an agent name using letters, digits, dots, dashes or underscores.');
  return readConfigFile(name + '.json');
}

function persistConfig(name, config) {
  mkdirSync(configuration, { recursive: true, mode: 0o700 });
  writeFileSync(join(configuration, name + '.json'), JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
}

async function request(base, key, path, body) {
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Inbox returned HTTP ' + response.status);
  return result;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') return console.log(usage);
  const print = value => console.log(JSON.stringify(value));
  if (command === 'register') {
    const [name] = args;
    if (!name) throw new Error('Run register <name>.');
    const envEnrollment = process.env.AGENT_INBOX_ENROLL_KEY;
    const profile = envEnrollment ? undefined : readConfigFile('_enrollment.json');
    const enrollment = envEnrollment || profile?.key;
    if (!enrollment) throw new Error('Set AGENT_INBOX_ENROLL_KEY or configure _enrollment.json.');
    let config = readConfig(name);
    const url = resolveOrigin(process.env.AGENT_INBOX_URL || config?.url || profile?.url || defaultUrl);
    if (profile && resolveOrigin(profile.url) !== url) throw new Error('The private enrollment key is linked to a different inbox.');
    if (config && config.url !== url) throw new Error('This local agent name is already linked to another inbox.');
    if (!config) {
      config = { url, key: randomBytes(32).toString('hex') };
      persistConfig(name, config);
    }
    return print(await request(url, enrollment, '/api/agents', { name, key: config.key }));
  }

  const config = process.env.AGENT_INBOX_AGENT ? readConfig(process.env.AGENT_INBOX_AGENT) : undefined;
  const key = process.env.AGENT_INBOX_KEY || config?.key;
  if (!key) throw new Error('Set AGENT_INBOX_AGENT to a registered name, or set AGENT_INBOX_KEY.');
  const base = resolveOrigin(process.env.AGENT_INBOX_URL || config?.url || defaultUrl);
  if (config && config.url !== base && !process.env.AGENT_INBOX_KEY) {
    throw new Error('This local agent key is linked to a different inbox.');
  }
  const call = (path, body) => request(base, key, path, body);

  if (command === 'ask') {
    const id = uuid.test(args[0] || '') ? args.shift() : randomUUID();
    const [runId, question, ...choices] = args;
    if (!runId || !question) throw new Error('Run ask [<uuid>] <run-id> "<question>" [choices...].');
    return print(await call('/api/questions', { id, run_id: runId, question, choices }));
  }
  if (command === 'send') {
    let id = randomUUID();
    if (args[0] === '--id') {
      args.shift();
      id = args.shift();
      if (!uuid.test(id || '')) throw new Error('Pass a lowercase UUID to --id.');
    }
    const text = args.join(' ');
    if (!text) throw new Error('Run send "<message>".');
    return print(await call('/api/messages', { id, text }));
  }
  if (command === 'answer' || command === 'wait') {
    const [id] = args;
    if (!uuid.test(id || '')) throw new Error('Pass the question ID returned by ask.');
    for (;;) {
      const item = await call('/api/questions/' + id);
      if (command === 'answer' || item.status === 'answered') return print(item);
      await delay(2000);
    }
  }
  if (command === 'read' || command === 'wait-message') {
    let after = args[0] || '0';
    if (!/^\d+$/.test(after)) throw new Error('Pass the cursor returned by a previous read.');
    for (;;) {
      const result = await call('/api/messages?after=' + after);
      if (command === 'read') return print(result);
      const messages = result.messages.filter(message => message.sender === 'operator');
      if (messages.length) return print({ messages, cursor: result.cursor });
      after = result.cursor;
      await delay(2000);
    }
  }
  throw new Error('Unknown command. Run agent-inbox --help.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
