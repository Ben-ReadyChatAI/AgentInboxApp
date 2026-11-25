import { telegramCall } from './notifications.mjs';

const token = process.env.TELEGRAM_BOT_TOKEN || '';
if (!/^\d+:[\w-]+$/.test(token)) throw new Error('Set TELEGRAM_BOT_TOKEN in .env first.');
const updates = await telegramCall(token, 'getUpdates', { allowed_updates: ['message'] });
const pairs = updates.map(({ message }) => ({
  chat_id: message?.chat?.id,
  user_id: message?.from?.id,
})).filter(pair => pair.user_id && pair.chat_id);
console.log(pairs.length ? JSON.stringify(pairs, null, 2) : 'Send /start to the bot, or mention the bot in the group, and try again.');
