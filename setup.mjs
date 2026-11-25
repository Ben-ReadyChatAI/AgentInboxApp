import { createECDH, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const origin = new URL(process.argv[2] || 'http://localhost:8788');
if (origin.href !== origin.origin + '/' ||
    (origin.protocol !== 'https:' && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin.origin))) {
  throw new Error('Use an HTTPS origin or a local loopback origin.');
}
const key = () => randomBytes(32).toString('hex');
const vapid = createECDH('prime256v1');
const publicKey = vapid.generateKeys('base64url');
const privateKey = Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()]).subarray(-32).toString('base64url');
try {
  writeFileSync('.env', [
    'INBOX_ORIGIN=' + origin.origin,
    'OPERATOR_KEY=' + key(),
    'AGENT_ENROLL_KEY=' + key(),
    'VAPID_PUBLIC_KEY=' + publicKey,
    'VAPID_PRIVATE_KEY=' + privateKey,
    '# Optional push contact. Defaults to the HTTPS origin. To use email, use mailto:you@example.com.',
    'VAPID_SUBJECT=',
    '',
    '# Optional dedicated Telegram bot and approved human responder',
    'TELEGRAM_BOT_TOKEN=',
    'TELEGRAM_CHAT_ID=',
    'TELEGRAM_USER_ID=',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with an operator key, an agent enrollment key, and Web Push keys.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('.env already exists. Edit it to change settings and keep the existing keys.');
  process.exitCode = 1;
}
