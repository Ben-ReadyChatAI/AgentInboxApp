import { setTimeout as delay } from 'node:timers/promises';
import { sendNotification } from 'web-push';
import { fail, idPattern } from './store.mjs';

export function subscriptionFrom(value) {
  if (typeof value.endpoint !== 'string') fail(400, 'Invalid push endpoint.');
  let url;
  try { url = new URL(value.endpoint); } catch { fail(400, 'Invalid push endpoint.'); }
  const endpoint = value.endpoint;
  const allowed = url.hostname === 'fcm.googleapis.com' ||
    url.hostname.endsWith('.push.apple.com') ||
    url.hostname === 'updates.push.services.mozilla.com' ||
    url.hostname.endsWith('.notify.windows.com');
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      endpoint.length > 2500) fail(400, 'Unsupported push endpoint.');
  const { p256dh, auth } = value.keys || {};
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(auth)) {
    fail(400, 'Invalid push subscription keys.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

export async function deliverPush(store, vapidDetails, signal, send = sendNotification) {
  while (!signal.aborted) {
    await Promise.all(store.deliveries().map(async job => {
      try {
        await send(JSON.parse(job.subscription), JSON.stringify({ path: job.target }), {
          vapidDetails, TTL: 3600, urgency: 'high', timeout: 8000,
        });
        store.complete(job);
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) store.unsubscribe(job.endpoint);
        else {
          console.error('Push delivery failed:', error.statusCode || error.code || 'network error');
          if (job.attempts >= 5) store.complete(job);
          else store.retry(job);
        }
      }
    }));
    await delay(1500, undefined, { signal });
  }
}

export async function telegramCall(token, method, body = {}, signal) {
  const timeout = AbortSignal.timeout(12000);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error('Telegram API status ' + (data.error_code || response.status));
  return data.result;
}

const marker = new RegExp('^#inbox_(' + idPattern + ')\\n');

export function telegramReply(store, message, config, botId) {
  if (String(message?.chat?.id) !== config.chatId ||
      String(message?.from?.id) !== config.userId ||
      message.sender_chat || message.reply_to_message?.from?.id !== botId ||
      typeof message.text !== 'string') return;
  const id = marker.exec(message.reply_to_message.text || '')?.[1];
  if (!id) return;
  try {
    store.answer(id, message.text, 'telegram');
    return 'Answer saved.';
  } catch (error) {
    if (error.status === 404) return;
    if (error.status === 400 || error.status === 409) return error.message;
    throw error;
  }
}

export async function deliverTelegram(store, config, origin, signal, call = telegramCall) {
  const api = (method, data) => call(config.token, method, data, signal);
  let botId;
  let offset;
  while (!signal.aborted) {
    try {
      botId ??= (await api('getMe')).id;
      for (const item of store.unsent()) {
        const choices = item.choices.length ? '\n\nReply with one of these choices:\n' + item.choices.join('\n') : '';
        const link = origin.startsWith('https:') ? '\n\n' + origin + '/questions/' + item.id : '';
        await api('sendMessage', {
          chat_id: config.chatId,
          text: `#inbox_${item.id}\n${item.agent} · ${item.run_id}\n\n${item.question}${choices}${link}`,
          reply_markup: { force_reply: true, input_field_placeholder: 'Reply to this question' },
          link_preview_options: { is_disabled: true },
        });
        store.markSent(item.id);
      }
    } catch (error) {
      if (!signal.aborted) console.error('Telegram notification failed:', safeTelegramError(error));
    }
    try {
      if (!botId || signal.aborted) {
        await delay(5000, undefined, { signal });
        continue;
      }
      const updates = await api('getUpdates', { offset, timeout: 5, allowed_updates: ['message'] });
      for (const update of updates) {
        const ack = telegramReply(store, update.message, config, botId);
        offset = update.update_id + 1;
        if (ack) {
          await api('sendMessage', {
            chat_id: config.chatId, text: ack,
            reply_parameters: { message_id: update.message.message_id, allow_sending_without_reply: true },
          }).catch(error => {
            if (!signal.aborted) console.error('Telegram confirmation failed:', safeTelegramError(error));
          });
        }
      }
      if (!updates.length) offset = undefined;
    } catch (error) {
      if (!signal.aborted) console.error('Telegram reply polling failed:', safeTelegramError(error));
      await delay(5000, undefined, { signal });
    }
  }
}

function safeTelegramError(error) {
  return /^Telegram API status \d+$/.test(error.message) ? error.message : error.code || 'network or application error';
}
