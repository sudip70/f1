const MAX_CLIENT_MESSAGES = 12;
const CURRENT_YEAR = new Date().getFullYear();
const STORAGE_KEY = 'f1-chat-session-v1';
const STARTER_PROMPTS = [
  'Who won in Canada in 2018?',
  'How many wins did Lewis Hamilton have in 2018?',
  `Who is leading the ${CURRENT_YEAR} drivers championship?`,
];

const SEED_MESSAGE = {
  id: 'seed-message',
  role: 'assistant',
  content:
    'Ask about winners, standings, qualifying, or season totals from 2000 onward. Follow-up questions work inside this chat session.',
  sources: [],
  suggestions: STARTER_PROMPTS,
  seed: true,
};

export function initChatWidget({ supabaseUrl, supabaseKey, getSelectedSeason }) {
  const root = document.getElementById('chat-root');
  if (!root) return;

  root.innerHTML = `
    <div class="chat-widget" data-chat-widget>
      <button
        class="chat-launcher"
        id="chat-launcher"
        type="button"
        aria-haspopup="dialog"
        aria-controls="chat-panel"
        aria-expanded="false"
      >
        <svg class="chat-launcher-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 6.5h14a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 19 17.5H11l-4.5 3v-3H5A2.5 2.5 0 0 1 2.5 15V9A2.5 2.5 0 0 1 5 6.5Z"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.8"
          ></path>
          <path
            d="M8 11h8M8 14h5"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.8"
          ></path>
        </svg>
        Ask F1 AI
      </button>

      <div class="chat-backdrop" id="chat-backdrop" hidden></div>

      <section
        class="chat-panel"
        id="chat-panel"
        role="dialog"
        aria-labelledby="chat-title"
        hidden
      >
        <header class="chat-header">
          <div>
            <p class="chat-eyebrow">Data Assistant</p>
            <h2 class="chat-title" id="chat-title">F1 Chat</h2>
          </div>
          <div class="chat-header-actions">
            <button
              class="chat-header-btn"
              id="chat-reset"
              data-chat-action="reset"
              type="button"
              aria-label="Reset chat"
              title="Reset chat"
            >
              <svg class="chat-header-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M3 12a9 9 0 1 0 3.1-6.8M3 4v5h5"
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.8"
                ></path>
              </svg>
            </button>
            <button
              class="chat-header-btn"
              id="chat-close"
              data-chat-action="close"
              type="button"
              aria-label="Close chat"
              title="Close chat"
            >
              <svg class="chat-header-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.8"
                ></path>
              </svg>
            </button>
          </div>
        </header>

        <div class="chat-status" id="chat-status">
          Archive answers come from Supabase. The live season uses Jolpica.
        </div>

        <div class="chat-messages" id="chat-messages" aria-live="polite"></div>

        <form class="chat-compose" id="chat-form">
          <label class="chat-label" for="chat-input">Ask a question</label>
          <textarea
            id="chat-input"
            class="chat-input"
            rows="3"
            maxlength="500"
            placeholder="Who won in Canada in 2018?"
          ></textarea>
          <div class="chat-compose-footer">
            <p class="chat-compose-hint">Follow-ups stay in context until you reset or close this tab.</p>
            <button class="chat-submit" id="chat-submit" type="submit">ASK</button>
          </div>
        </form>
      </section>
    </div>
  `;

  const launcher = document.getElementById('chat-launcher');
  const panel = document.getElementById('chat-panel');
  const backdrop = document.getElementById('chat-backdrop');
  const closeBtn = document.getElementById('chat-close');
  const resetBtn = document.getElementById('chat-reset');
  const messagesEl = document.getElementById('chat-messages');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const submitBtn = document.getElementById('chat-submit');

  if (!launcher || !panel || !backdrop || !closeBtn || !resetBtn || !messagesEl || !form || !input || !submitBtn) {
    return;
  }

  const state = loadPersistedState() || defaultState();
  let focusRestoreSerial = 0;
  let requestSerial = 0;
  let resetAnimationTimer = 0;

  function persist() {
    try {
      const messages = state.messages
        .filter(message => !message.pending)
        .map(serializePersistedMessage)
        .filter(Boolean)
        .slice(-MAX_CLIENT_MESSAGES);

      const nextContext = normalizeResolvedContext(state.resolvedContext);
      const isDefaultSession = messages.length === 1
        && messages[0].seed
        && !nextContext.year
        && !nextContext.driverName
        && !nextContext.raceName
        && !nextContext.teamName
        && !nextContext.round
        && nextContext.source === 'unknown';

      if (isDefaultSession) {
        clearPersistedState();
        return;
      }

      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        messages,
        resolvedContext: nextContext,
      }));
    } catch (_error) {
      // Ignore storage errors in private browsing or restricted environments.
    }
  }

  function setOpen(nextOpen) {
    state.isOpen = nextOpen;
    panel.hidden = !nextOpen;
    backdrop.hidden = true;
    panel.style.display = nextOpen ? 'grid' : 'none';
    backdrop.style.display = 'none';
    launcher.setAttribute('aria-expanded', String(nextOpen));

    if (nextOpen) {
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    } else {
      focusRestoreSerial += 1;
      requestAnimationFrame(() => launcher.focus({ preventScroll: true }));
    }
  }

  function canRestoreInputFocus(expectedSerial) {
    if (expectedSerial !== focusRestoreSerial) return false;
    if (!state.isOpen || panel.hidden || panel.style.display === 'none') return false;
    if (input.disabled || !root.contains(input)) return false;
    if (document.visibilityState && document.visibilityState !== 'visible') return false;
    return true;
  }

  function renderMessages() {
    messagesEl.innerHTML = state.messages
      .map(message => renderMessage(message))
      .join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function renderMessage(message) {
    const roleClass = message.role === 'user' ? 'is-user' : 'is-assistant';
    const sourceHtml = message.sources?.length ? `
      <div class="chat-sources">
        ${message.sources.map(source => `
          <span class="chat-source-pill" title="${escapeHtml(source.detail || source.label)}">
            ${escapeHtml(source.label)}
          </span>
        `).join('')}
      </div>
    ` : '';

    const suggestionHtml = message.suggestions?.length ? `
      <div class="chat-suggestions">
        ${message.suggestions.map(suggestion => `
          <button
            type="button"
            class="chat-suggestion"
            data-chat-suggestion="${escapeAttribute(suggestion)}"
          >
            ${escapeHtml(suggestion)}
          </button>
        `).join('')}
      </div>
    ` : '';

    return `
      <article class="chat-message ${roleClass}">
        <div class="chat-bubble ${message.pending ? 'is-pending' : ''}">
          <div class="chat-message-role">${message.role === 'user' ? 'You' : 'F1 Chat'}</div>
          <div class="chat-message-body">${formatMessageBody(message.content)}</div>
          ${sourceHtml}
          ${suggestionHtml}
        </div>
      </article>
    `;
  }

  function render() {
    renderMessages();
    submitBtn.disabled = state.pending;
    input.disabled = state.pending;
  }

  function pushMessage(message) {
    state.messages.push(message);
    state.messages = state.messages.slice(-MAX_CLIENT_MESSAGES);
    persist();
    render();
  }

  function replacePendingMessage(nextMessage) {
    const index = state.messages.findIndex(message => message.pending);
    if (index === -1) return false;
    state.messages[index] = nextMessage;
    persist();
    render();
    return true;
  }

  function resetSession() {
    requestSerial += 1;
    state.messages = [{ ...SEED_MESSAGE }];
    state.resolvedContext = defaultResolvedContext();
    state.pending = false;
    persist();
    render();
    if (shouldRefocusInputAfterReset()) {
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }
  }

  function shouldRefocusInputAfterReset() {
    if (typeof window.matchMedia !== 'function') return true;
    return !window.matchMedia('(pointer: coarse)').matches;
  }

  function playResetAnimation() {
    resetBtn.classList.remove('is-animating');
    if (resetAnimationTimer) {
      clearTimeout(resetAnimationTimer);
    }
    void resetBtn.offsetWidth;
    resetBtn.classList.add('is-animating');
    resetAnimationTimer = window.setTimeout(() => {
      resetBtn.classList.remove('is-animating');
      resetAnimationTimer = 0;
    }, 480);
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || state.pending) return;
    const requestId = ++requestSerial;
    const expectedFocusSerial = focusRestoreSerial;

    state.pending = true;
    input.value = '';

    pushMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      sources: [],
      suggestions: [],
    });

    pushMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: 'Looking that up...',
      pending: true,
      sources: [],
      suggestions: [],
    });

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          messages: buildApiMessages(state.messages),
          resolvedContext: normalizeResolvedContext(state.resolvedContext),
          selectedSeason: normalizeYear(getSelectedSeason?.()),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || 'Chat request failed');
      }
      if (requestId !== requestSerial) return;

      state.resolvedContext = normalizeResolvedContext(payload.resolvedContext);
      replacePendingMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: payload.answer || 'No answer returned.',
        sources: Array.isArray(payload.sources) ? payload.sources.slice(0, 3) : [],
        suggestions: Array.isArray(payload.suggestions) ? payload.suggestions.slice(0, 3) : [],
      });
    } catch (error) {
      if (requestId !== requestSerial) return;
      replacePendingMessage({
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          error instanceof Error
            ? error.message
            : 'Chat is unavailable right now. Please try again in a moment.',
        sources: [],
        suggestions: STARTER_PROMPTS.slice(0, 2),
      });
    } finally {
      if (requestId !== requestSerial) return;
      state.pending = false;
      render();
      persist();
      if (canRestoreInputFocus(expectedFocusSerial)) {
        requestAnimationFrame(() => input.focus({ preventScroll: true }));
      }
    }
  }

  function handleOpen(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    setOpen(true);
  }

  function handleClose(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    setOpen(false);
  }

  function handleReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    playResetAnimation();
    resetSession();
  }

  launcher.addEventListener('click', handleOpen);
  launcher.addEventListener('pointerdown', handleOpen);
  closeBtn.addEventListener('click', handleClose);
  closeBtn.addEventListener('pointerdown', handleClose);
  backdrop.addEventListener('click', handleClose);
  backdrop.addEventListener('pointerdown', handleClose);
  resetBtn.addEventListener('click', handleReset);
  resetBtn.addEventListener('pointerdown', handleReset);

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.isOpen) {
      setOpen(false);
    }
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    sendMessage(input.value);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage(input.value);
    }
  });

  messagesEl.addEventListener('click', event => {
    const button = event.target instanceof Element
      ? event.target.closest('[data-chat-suggestion]')
      : null;
    if (!button) return;
    const suggestion = button.getAttribute('data-chat-suggestion') || '';
    if (!suggestion) return;
    sendMessage(suggestion);
  });

  root.addEventListener('click', event => {
    const button = event.target instanceof Element
      ? event.target.closest('[data-chat-action]')
      : null;
    if (!button) return;

    const action = button.getAttribute('data-chat-action');
    if (action === 'close') {
      handleClose(event);
      return;
    }

    if (action === 'reset') {
      handleReset(event);
    }
  });

  render();
  setOpen(false);
}

function buildApiMessages(messages) {
  return messages
    .filter(message => !message.seed && !message.pending)
    .map(message => ({
      role: message.role,
      content: String(message.content || '').slice(0, 500),
    }))
    .slice(-8);
}

function clearPersistedState() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (_error) {
    // Ignore storage errors in private browsing or restricted environments.
  }
}

function loadPersistedState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.messages)
      ? parsed.messages
          .map(sanitizePersistedMessage)
          .filter(Boolean)
          .slice(-MAX_CLIENT_MESSAGES)
      : [];

    if (!messages.length) {
      clearPersistedState();
      return null;
    }

    return {
      isOpen: false,
      pending: false,
      messages,
      resolvedContext: normalizeResolvedContext(parsed?.resolvedContext),
    };
  } catch (_error) {
    clearPersistedState();
    return null;
  }
}

function serializePersistedMessage(message) {
  if (!message || typeof message !== 'object') return null;

  return {
    id: toShortString(message.id, 80) || crypto.randomUUID(),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: toShortString(message.content, 2000),
    sources: Array.isArray(message.sources)
      ? message.sources
          .map(source => ({
            label: toShortString(source?.label, 80),
            detail: toShortString(source?.detail, 160),
          }))
          .filter(source => source.label)
          .slice(0, 3)
      : [],
    suggestions: Array.isArray(message.suggestions)
      ? message.suggestions
          .map(suggestion => toShortString(suggestion, 120))
          .filter(Boolean)
          .slice(0, 3)
      : [],
    seed: Boolean(message.seed),
  };
}

function sanitizePersistedMessage(value) {
  if (!value || typeof value !== 'object') return null;

  const role = value.role === 'assistant' ? 'assistant' : value.role === 'user' ? 'user' : '';
  const content = toShortString(value.content, 2000);
  if (!role || !content) return null;

  return {
    id: toShortString(value.id, 80) || crypto.randomUUID(),
    role,
    content,
    sources: Array.isArray(value.sources)
      ? value.sources
          .map(source => ({
            label: toShortString(source?.label, 80),
            detail: toShortString(source?.detail, 160),
          }))
          .filter(source => source.label)
          .slice(0, 3)
      : [],
    suggestions: Array.isArray(value.suggestions)
      ? value.suggestions
          .map(suggestion => toShortString(suggestion, 120))
          .filter(Boolean)
          .slice(0, 3)
      : [],
    seed: Boolean(value.seed && role === 'assistant'),
  };
}

function defaultState() {
  return {
    isOpen: false,
    pending: false,
    messages: [{ ...SEED_MESSAGE }],
    resolvedContext: defaultResolvedContext(),
  };
}

function defaultResolvedContext() {
  return {
    year: 0,
    driverName: '',
    raceName: '',
    teamName: '',
    round: 0,
    source: 'unknown',
  };
}

function normalizeResolvedContext(context) {
  const fallback = defaultResolvedContext();
  if (!context || typeof context !== 'object') return fallback;
  return {
    year: normalizeYear(context.year),
    driverName: toShortString(context.driverName),
    raceName: toShortString(context.raceName),
    teamName: toShortString(context.teamName),
    round: normalizePositiveInt(context.round, 99),
    source: ['supabase', 'jolpica'].includes(context.source) ? context.source : 'unknown',
  };
}

function normalizeYear(value) {
  return normalizePositiveInt(value, 2100);
}

function normalizePositiveInt(value, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return 0;
  return parsed;
}

function toShortString(value) {
  return typeof value === 'string' ? value.slice(0, 120).trim() : '';
}

function formatMessageBody(content) {
  return escapeHtml(String(content || '')).replace(/\n/g, '<br>');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
