self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

const question = /^\/questions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const channel = /^\/channels\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const safePath = path => typeof path === 'string' && (question.test(path) || channel.test(path)) ? path : '/';

self.addEventListener('push', event => {
  let path = '/';
  try { path = safePath(event.data?.json()?.path); } catch { /* An empty payload can still open the inbox. */ }
  event.waitUntil(self.registration.showNotification('Agent Inbox', {
    body: question.test(path) ? 'An agent is waiting for your answer.' : 'You have a new agent message.',
    icon: '/icons/inbox-192.png',
    tag: path,
    data: { path },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = new URL(safePath(event.notification.data?.path), self.location.origin);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find(client => client.url === destination.href);
    if (open) await open.focus();
    else await self.clients.openWindow(destination.href);
  })());
});
