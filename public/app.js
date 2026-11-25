const installButton = document.querySelector('#install-app');
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (standalone) document.querySelector('#install-help')?.setAttribute('hidden', '');
if (installButton && !standalone) {
  let prompt;
  if (typeof navigator.install === 'function') installButton.hidden = false;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    installButton.hidden = false;
  });
  installButton.addEventListener('click', async () => {
    installButton.disabled = true;
    try {
      if (typeof navigator.install === 'function') await navigator.install();
      else if (prompt) {
        const event = prompt;
        prompt = undefined;
        await event.prompt();
        await event.userChoice;
      }
    } catch {
      document.querySelector('#install-help').open = true;
    } finally {
      installButton.disabled = false;
      installButton.hidden = !prompt && typeof navigator.install !== 'function';
    }
  });
  window.addEventListener('appinstalled', () => { installButton.hidden = true; });
}

const queue = document.querySelector('[data-queue]');
if (queue) {
  const status = document.querySelector('#queue-status');
  const chat = queue.hasAttribute('data-chat');
  if (chat) queue.scrollTop = queue.scrollHeight;
  const holdingFocus = () => queue.contains(document.activeElement) && queue !== document.activeElement;
  async function refresh() {
    if (!document.hidden && !holdingFocus()) {
      try {
        const response = await fetch(location.href, {
          headers: { 'X-Inbox-Fragment': 'queue', 'If-None-Match': queue.dataset.revision },
          signal: AbortSignal.timeout?.(4500),
        });
        if (response.status === 200) {
          const next = new DOMParser().parseFromString(await response.text(), 'text/html');
          if (!holdingFocus()) {
            const pinned = chat && queue.scrollHeight - queue.scrollTop - queue.clientHeight < 40;
            queue.replaceChildren(...next.body.childNodes);
            if (pinned) queue.scrollTop = queue.scrollHeight;
            queue.dataset.revision = response.headers.get('ETag');
          }
        } else if (response.status !== 304) throw new Error(response.status);
        status.hidden = true;
      } catch (error) {
        status.hidden = false;
        status.textContent = error.message === '401' ? 'Sign in again to see new questions.' : 'Inbox could not refresh. Retrying…';
      }
    }
    setTimeout(refresh, 5000);
  }
  setTimeout(refresh, 5000);
}

const notifications = document.querySelector('#notifications');
const supportsWorker = 'serviceWorker' in navigator;
const worker = supportsWorker
  ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null)
  : Promise.resolve(null);

if (notifications) {
  const status = document.querySelector('#notification-status');
  const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isAppleMobile && !standalone) {
    status.textContent = 'Install Agent Inbox and open it from your Home Screen to enable notifications.';
  } else if (!supportsWorker || !('PushManager' in window) || !('Notification' in window)) {
    status.textContent = 'Notifications are unavailable in this browser.';
  } else {
    configureNotifications().catch(() => {
      status.textContent = 'Notifications could not start. Reload the app to try again.';
    });
  }

  async function configureNotifications() {
    const registration = await worker;
    if (!registration) throw new Error('Service worker registration failed.');
    const push = registration.pushManager;
    let subscription = await push.getSubscription();
    function showState() {
      notifications.hidden = false;
      notifications.textContent = subscription ? 'Disable notifications' : 'Enable notifications';
      status.textContent = subscription ? 'Notifications are on for this device.' : 'Notifications are off for this device.';
    }

    async function save(body) {
      const response = await fetch('/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Inbox-CSRF': notifications.dataset.csrf },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Could not update push subscription.');
    }

    showState();
    if (subscription) {
      try { await save(subscription); } catch { status.textContent = 'Could not sync notifications for this device.'; }
    }

    notifications.addEventListener('click', async () => {
      notifications.disabled = true;
      try {
        if (subscription) {
          await save({ remove: true, endpoint: subscription.endpoint });
          await subscription.unsubscribe();
          subscription = null;
        } else {
          if (await Notification.requestPermission() !== 'granted') {
            status.textContent = 'Allow notifications in your browser or phone settings, then try again.';
            return;
          }
          const encoded = notifications.dataset.key.replace(/-/g, '+').replace(/_/g, '/');
          const applicationServerKey = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
          const candidate = await push.subscribe({ userVisibleOnly: true, applicationServerKey });
          try {
            await save(candidate);
          } catch (error) {
            await candidate.unsubscribe().catch(() => {});
            throw error;
          }
          subscription = candidate;
        }
        showState();
      } catch {
        status.textContent = 'Could not update notifications. Try again.';
      } finally {
        notifications.disabled = false;
      }
    });
  }
}
