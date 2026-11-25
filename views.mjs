const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = value => String(value).replace(/[&<>"']/g, char => entities[char]);
const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const when = value => `<time datetime="${value}">${date.format(new Date(value))} UTC</time>`;
const csrfField = value => `<input type="hidden" name="csrf" value="${value}">`;

export function page(title, content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f6f8">
  <title>${escape(title)}</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icons/inbox-180.png">
  <link rel="icon" href="/icons/inbox-192.png">
  <link rel="stylesheet" href="/app.css">
  <script defer src="/app.js"></script>
</head>
<body>${content}</body>
</html>`;
}

const install = `<div class="install">
  <button type="button" id="install-app" hidden>Install app</button>
  <details id="install-help">
    <summary>Install on your phone</summary>
    <p><strong>iPhone</strong> In Safari, use Share → Add to Home Screen. If offered, turn on Open as Web App, then open Agent Inbox from its icon.</p>
    <p><strong>Android</strong> In Chrome, open the menu and choose Install app or Add to Home screen.</p>
  </details>
</div>`;

export function login(next, error = '') {
  return page('Sign in · Agent Inbox', `<main class="sign-in">
    <h1>Agent Inbox</h1>
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escape(next)}">
      <label for="key">Operator access key</label>
      <input id="key" type="password" name="key" autocomplete="current-password" required maxlength="128"
        ${error ? 'aria-invalid="true" aria-describedby="login-error" autofocus' : ''}>
      ${error ? `<p class="error" id="login-error">${escape(error)}</p>` : ''}
      <button type="submit" class="primary">Sign in</button>
    </form>
    ${install}
  </main>`);
}

export function queueFragment(view, items) {
  const pending = view === 'pending';
  return `<h2>${pending ? 'Waiting for your answer' : 'Recent answers'}${items.length ? ` <span class="count">${items.length}</span>` : ''}</h2>
  ${items.length ? `<ul class="queue">
    ${items.map(item => `<li><a href="/questions/${item.id}">
      <span class="row-question">${escape(item.question)}</span>
      <span class="meta"><strong>${escape(item.agent)}</strong> · ${escape(item.run_id)} · ${when(item.answered_at || item.created_at)}</span>
    </a></li>`).join('')}
  </ul>` : `<p class="empty">${pending ? 'There are no pending questions.' : 'There are no answered questions yet.'}</p>`}`;
}

export function inbox(view, content, revision, csrf, key) {
  const current = tab => tab === view ? ' aria-current="page"' : '';
  return page('Agent Inbox', `<main>
    <header class="top">
      <h1>Agent Inbox</h1>
      <form method="post" action="/logout" aria-label="Sign out">
        ${csrfField(csrf)}<button type="submit">Sign out</button>
      </form>
    </header>
    <nav aria-label="Questions" class="tabs">
      <a href="/"${current('pending')}>Pending</a>
      <a href="/channels"${current('channels')}>Channels</a>
      <a href="/?view=answered"${current('answered')}>Answered</a>
    </nav>
    <section data-queue data-revision="${escape(revision)}" aria-label="Question list">
      ${content}
    </section>
    <p class="error" id="queue-status" role="status" hidden></p>
    <section class="settings" aria-labelledby="notification-heading">
      <h2 id="notification-heading">Notifications</h2>
      ${key ? `<button type="button" id="notifications" data-key="${escape(key)}" data-csrf="${csrf}" hidden>Enable notifications</button>
      <p id="notification-status" class="meta" role="status"></p>` :
        '<p class="meta">Push notifications are unavailable on this server address.</p>'}
      ${install}
    </section>
  </main>`);
}

export function questionDetail(item, csrf, error = '', draft = '') {
  const answered = item.status === 'answered';
  const invalid = error && !answered ? ' aria-invalid="true" aria-describedby="answer-error"' : '';
  return page('Question · Agent Inbox', `<main>
    <a href="${answered ? '/?view=answered' : '/'}" class="back">Back to inbox</a>
    <article>
      <p class="meta"><strong>${escape(item.agent)}</strong> · ${escape(item.run_id)} · ${when(item.created_at)}</p>
      <h1 class="question">${escape(item.question)}</h1>
      <p class="channel-link"><a href="/channels/${escape(item.agent)}">Open ${escape(item.agent)} channel</a></p>
      ${error ? `<p class="error" id="answer-error" role="alert">${escape(error)}</p>` : ''}
      ${answered ? `<section class="answer">
        <h2>Answer saved</h2>
        <p class="reply">${escape(item.answer)}</p>
        <p class="meta">${when(item.answered_at)} · ${item.answered_via === 'telegram' ? 'Telegram' : 'Web'}</p>
      </section>` : `<form method="post" action="/questions/${item.id}">
        ${csrfField(csrf)}
        ${item.choices.length ? `<fieldset><legend>Choose an answer</legend>
          ${item.choices.map((choice, i) => `<div class="choice">
            <input id="choice-${i}" type="radio" name="answer" value="${escape(choice)}" required${invalid}
              ${draft === choice ? 'checked' : ''} ${invalid && i === 0 ? 'autofocus' : ''}>
            <label for="choice-${i}">${escape(choice)}</label>
          </div>`).join('')}
        </fieldset>` : `<label for="answer">Your answer</label>
          <textarea id="answer" name="answer" rows="4" required maxlength="2000"${invalid}
            ${invalid ? 'autofocus' : ''}>${escape(draft || '')}</textarea>`}
        <button type="submit" class="primary">Send answer</button>
      </form>`}
    </article>
  </main>`);
}

export function channelList(channels) {
  return `<h2>Agent channels</h2>
  ${channels.length ? `<ul class="queue">
    ${channels.map(item => `<li><a href="/channels/${escape(item.name)}">
      <span class="row-question">${escape(item.name)}</span>
      ${item.text ? `<span class="meta preview">${item.sender === 'operator' ? 'You · ' : ''}${escape(item.text)}</span>
      <span class="meta">${when(item.created_at)}</span>` : '<span class="meta">No messages yet</span>'}
    </a></li>`).join('')}
  </ul>` : '<p class="empty">A channel appears when an agent registers.</p>'}`;
}

export function channelFragment(name, { messages, older }) {
  return `${older ? `<p class="older"><a href="/channels/${escape(name)}?before=${older}">Older messages</a></p>` : ''}
  ${messages.length ? `<ol class="thread">
    ${messages.map(item => `<li class="message ${item.sender === 'operator' ? 'from-you' : ''}">
      <p class="meta"><strong>${item.sender === 'operator' ? 'You' : escape(name)}</strong> · ${when(item.created_at)}</p>
      <p class="message-text">${escape(item.text)}</p>
    </li>`).join('')}
  </ol>` : '<p class="empty">There are no messages in this channel yet.</p>'}`;
}

export function channelDetail(name, content, revision, csrf, messageId, { before, error, draft } = {}) {
  return page(name + ' · Agent Inbox', `<main>
    <a href="/channels" class="back">Back to channels</a>
    <h1 class="channel-title">${escape(name)}</h1>
    ${before ? `<p><a href="/channels/${escape(name)}">Latest messages</a></p>` : ''}
    <section class="chat-scroll" tabindex="0" aria-label="Conversation"
      ${before ? '' : `data-queue data-chat data-revision="${escape(revision)}"`}>${content}</section>
    <p class="error" id="queue-status" role="status" hidden></p>
    ${before ? '' : `<form class="compose" method="post" action="/channels/${escape(name)}" id="latest">
      ${csrfField(csrf)}<input type="hidden" name="id" value="${messageId}">
      <label for="message">Message ${escape(name)}</label>
      ${error ? `<p class="error" id="message-error" role="alert">${escape(error)}</p>` : ''}
      <textarea id="message" name="text" rows="3" required maxlength="4000"
        ${error ? 'aria-invalid="true" aria-describedby="message-error" autofocus' : ''}>${escape(draft || '')}</textarea>
      <button type="submit" class="primary">Send message</button>
    </form>`}
  </main>`);
}
