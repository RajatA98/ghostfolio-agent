import { AgentChatHistoryService } from './chat-history';

const JWT_STORAGE_KEY = 'ghostfolio_agent_jwt';
const API_BASE = '';

type AgentResponse = {
  answer: string;
  confidence: number;
  warnings: string[];
};

const history = new AgentChatHistoryService();

const messagesEl = document.getElementById('messages') as HTMLDivElement;
const messageInput = document.getElementById('messageInput') as HTMLInputElement;
const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
const accessTokenInput = document.getElementById('accessTokenInput') as HTMLInputElement;
const connectButton = document.getElementById('connectButton') as HTMLButtonElement;
const disconnectButton = document.getElementById('disconnectButton') as HTMLButtonElement;
const connectStatusEl = document.getElementById('connectStatus') as HTMLSpanElement;

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function getStoredJwt(): string | null {
  try {
    return sessionStorage.getItem(JWT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredJwt(jwt: string): void {
  sessionStorage.setItem(JWT_STORAGE_KEY, jwt);
}

function clearStoredJwt(): void {
  sessionStorage.removeItem(JWT_STORAGE_KEY);
}

function setConnectStatus(text: string, isError = false): void {
  connectStatusEl.textContent = text;
  connectStatusEl.className = 'connectStatus' + (isError ? ' error' : '');
}

render();
updateConnectStatus();
void checkServerAuth();

connectButton.addEventListener('click', () => {
  void connect();
});

disconnectButton.addEventListener('click', () => {
  clearStoredJwt();
  setConnectStatus('');
  updateConnectStatus();
});

sendButton.addEventListener('click', () => {
  void sendMessage();
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void sendMessage();
  }
});

/** JWTs are three base64url segments separated by dots. Allow pasted tokens with line breaks. */
function looksLikeJwt(value: string): boolean {
  const normalized = value.replace(/\s/g, '').trim();
  if (normalized.length < 50) return false;
  const parts = normalized.split('.');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}

async function connect(): Promise<void> {
  const rawInput = accessTokenInput.value.trim();
  const input = rawInput.replace(/\s/g, ''); // normalize so JWT with line breaks still works

  if (!input) {
    setConnectStatus('Enter your Ghostfolio JWT or access token.', true);
    return;
  }

  // If it looks like a JWT, verify the agent is reachable then store the token.
  if (looksLikeJwt(input)) {
    try {
      const healthRes = await fetch(apiUrl('/health'));
      if (!healthRes.ok) {
        setConnectStatus(`Agent returned HTTP ${healthRes.status}.`, true);
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isNetworkError =
        msg.includes('fetch') || msg.includes('Load failed') || msg.includes('NetworkError');
      const hint = isNetworkError
        ? ' Is the agent server running? In dev, run `npm run dev` in one terminal and `npm run dev:client` in another.'
        : '';
      setConnectStatus(`Could not reach the agent.${hint}`, true);
      return;
    }
    setStoredJwt(input);
    setConnectStatus('Connected (using JWT)');
    accessTokenInput.value = '';
    return;
  }

  // Otherwise treat as access token and exchange for JWT (agent will call Ghostfolio).
  setConnectStatus('Connecting…');

  try {
    const response = await fetch(apiUrl('/api/auth/ghostfolio'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: input })
    });

    let data: { authToken?: string; error?: string } | null = null;
    try {
      data = (await response.json()) as { authToken?: string; error?: string };
    } catch {
      data = null;
    }

    if (!response.ok) {
      clearStoredJwt();
      const msg = data?.error ?? `Auth failed with HTTP ${response.status}.`;
      const hint =
        msg.includes('fetch failed') || msg.includes('ECONNREFUSED')
          ? ' Is Ghostfolio running? Check server `.env` `GHOSTFOLIO_API_URL`.'
          : '';
      setConnectStatus(msg + hint, true);
      return;
    }

    if (typeof data?.authToken === 'string') {
      setStoredJwt(data.authToken);
      setConnectStatus('Connected');
      accessTokenInput.value = '';
    } else {
      clearStoredJwt();
      setConnectStatus('No token returned.', true);
    }
  } catch (error) {
    clearStoredJwt();
    const msg = error instanceof Error ? error.message : String(error);
    const isNetworkError =
      msg.includes('fetch failed') || msg.includes('Failed to fetch') || msg.includes('Load failed');
    const hint = isNetworkError
      ? ' Could not reach the agent server. In dev, run `npm run dev` and `npm run dev:client`.'
      : '';
    setConnectStatus(`Failed to connect.${hint}`, true);
  }
}

function updateConnectStatus(): void {
  if (getStoredJwt()) {
    setConnectStatus('Connected');
  } else if (!connectStatusEl.textContent) {
    setConnectStatus('');
  }
}

async function checkServerAuth(): Promise<void> {
  try {
    const res = await fetch(apiUrl('/api/auth/status'));
    if (!res.ok) return;
    const data = (await res.json()) as { authenticated?: boolean };
    if (data?.authenticated) {
      // Server already has a JWT (set via .env) — no manual connect needed.
      document.getElementById('connectSection')!.style.display = 'none';
    }
  } catch {
    // Agent not reachable yet — ignore.
  }
}

async function sendMessage() {
  const message = messageInput.value.trim();
  const jwt = getStoredJwt();

  if (!message) {
    return;
  }

  history.appendUserMessage(message);
  messageInput.value = '';
  render();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;

  try {
    const allMessages = history.getMessages();
    const conversationHistory = allMessages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content
    }));
    const response = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, conversationHistory })
    });

    if (response.status === 401) {
      clearStoredJwt();
      updateConnectStatus();
      history.appendAssistantMessage(
        'Session expired. Please connect again with your Ghostfolio JWT or access token.',
        {}
      );
      render();
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      const detail = text.trim();
      if (response.status === 404) {
        history.appendAssistantMessage(
          'The agent request failed. Endpoint not found. If you are using a dev proxy, ensure `/api` routes are forwarded to the agent server.'
        );
      } else if (response.status >= 500) {
        const suffix = detail ? ` (${detail})` : '';
        history.appendAssistantMessage(
          `The agent request failed. Agent error (HTTP ${response.status}). Check the agent server logs.${suffix}`
        );
      } else {
        const suffix = detail ? ` (${detail})` : '';
        history.appendAssistantMessage(
          `The agent request failed. Request was rejected (HTTP ${response.status}).${suffix}`
        );
      }
      render();
      return;
    }

    const data = (await response.json()) as AgentResponse;
    history.appendAssistantMessage(data.answer, {
      confidence: data.confidence,
      warnings: data.warnings
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isNetworkError =
      msg.includes('Load failed') ||
      msg.includes('Failed to fetch') ||
      msg.includes('NetworkError');
    if (isNetworkError) {
      history.appendAssistantMessage(
        'The agent request failed. Could not reach the agent server. In dev, run `npm run dev` in one terminal and `npm run dev:client` in another.'
      );
    } else {
      history.appendAssistantMessage(`The agent request failed. ${msg}`);
    }
  }

  render();
}

function render() {
  const messages = history.getMessages();
  messagesEl.innerHTML = messages
    .map((message) => {
      const warnings =
        message.warnings && message.warnings.length
          ? `<div class="meta">${message.warnings.join('<br/>')}</div>`
          : '';
      const confidence =
        message.confidence !== undefined
          ? `<div class="meta">Confidence: ${Math.round(
              message.confidence * 100
            )}%</div>`
          : '';
      return `<div class="message ${message.role}">
        <div class="bubble">${escapeHtml(message.content)}${confidence}${warnings}</div>
      </div>`;
    })
    .join('');
}

function escapeHtml(text: string) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
    .replaceAll('\n', '<br/>');
}
