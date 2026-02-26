import { createClient, Session } from '@supabase/supabase-js';
import { AgentChatHistoryService } from './chat-history';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const API_BASE = '';

type AgentResponse = {
  answer: string;
  confidence: number;
  warnings: string[];
};

const history = new AgentChatHistoryService();

// DOM elements
const messagesEl = document.getElementById('messages') as HTMLDivElement;
const messageInput = document.getElementById('messageInput') as HTMLInputElement;
const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
const emailInput = document.getElementById('emailInput') as HTMLInputElement;
const passwordInput = document.getElementById('passwordInput') as HTMLInputElement;
const signUpButton = document.getElementById('signUpButton') as HTMLButtonElement;
const signInButton = document.getElementById('signInButton') as HTMLButtonElement;
const signOutButton = document.getElementById('signOutButton') as HTMLButtonElement;
const authStatusEl = document.getElementById('authStatus') as HTMLSpanElement;
const authSection = document.getElementById('authSection') as HTMLElement;

// Status bar elements
const headerDot = document.getElementById('headerDot') as HTMLSpanElement;
const headerStatus = document.getElementById('headerStatus') as HTMLSpanElement;
const headerClock = document.getElementById('headerClock') as HTMLSpanElement;
const statusDot = document.getElementById('statusDot') as HTMLSpanElement;
const statusText = document.getElementById('statusText') as HTMLSpanElement;
const statusClock = document.getElementById('statusClock') as HTMLSpanElement;

let currentSession: Session | null = null;

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function getAccessToken(): string | null {
  return currentSession?.access_token ?? null;
}

function setAuthStatus(text: string, isError = false): void {
  authStatusEl.textContent = text;
  authStatusEl.className = 'connectStatus' + (isError ? ' error' : '');
}

function updateTerminalStatus(): void {
  const connected = !!currentSession;
  if (headerDot) headerDot.style.background = connected ? '#33ff33' : '#ff3333';
  if (headerStatus) headerStatus.textContent = connected ? 'CONNECTED' : 'OFFLINE';
  if (statusDot) statusDot.className = 'statusDot' + (connected ? ' connected' : '');
  if (statusText) statusText.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
}

function updateAuthUI(): void {
  const loggedIn = !!currentSession;

  // Show/hide form fields vs sign out
  emailInput.style.display = loggedIn ? 'none' : '';
  passwordInput.style.display = loggedIn ? 'none' : '';
  signUpButton.style.display = loggedIn ? 'none' : '';
  signInButton.style.display = loggedIn ? 'none' : '';
  signOutButton.style.display = loggedIn ? '' : 'none';

  // Update hint text
  const hint = authSection.querySelector('.connectHint') as HTMLElement;
  if (hint) {
    hint.textContent = loggedIn
      ? `Signed in as ${currentSession!.user.email ?? 'user'}`
      : 'Sign up or sign in with your email and password to connect.';
  }

  updateTerminalStatus();
}

// ── Clock ──
function updateClock(): void {
  const now = new Date();
  const ts = now.toLocaleTimeString('en-US', { hour12: false });
  const ds = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' }).toUpperCase();
  const full = `${ds} ${ts}`;
  if (headerClock) headerClock.textContent = full;
  if (statusClock) statusClock.textContent = full;
}

setInterval(updateClock, 1000);
updateClock();

// ── Supabase auth ──

async function handleSignUp(): Promise<void> {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    setAuthStatus('Email and password are required.', true);
    return;
  }

  if (password.length < 6) {
    setAuthStatus('Password must be at least 6 characters.', true);
    return;
  }

  setAuthStatus('SIGNING UP...');

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    setAuthStatus(`Sign up failed: ${error.message}`, true);
    return;
  }

  if (data.session) {
    currentSession = data.session;
    // Provision Ghostfolio account on first signup
    try {
      await fetch(apiUrl('/api/auth/signup'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${data.session.access_token}`
        }
      });
    } catch {
      // Non-fatal: account provisioning can happen on first chat
    }
    setAuthStatus('Signed up and connected!');
    updateAuthUI();
  } else {
    setAuthStatus('Check your email to confirm your account.');
  }
}

async function handleSignIn(): Promise<void> {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  if (!email || !password) {
    setAuthStatus('Email and password are required.', true);
    return;
  }

  setAuthStatus('SIGNING IN...');

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    setAuthStatus(`Sign in failed: ${error.message}`, true);
    return;
  }

  currentSession = data.session;
  setAuthStatus('Signed in!');
  updateAuthUI();
}

async function handleSignOut(): Promise<void> {
  await supabase.auth.signOut();
  currentSession = null;
  setAuthStatus('');
  updateAuthUI();
}

// Listen for auth state changes (e.g. token refresh)
supabase.auth.onAuthStateChange((_event, session) => {
  currentSession = session;
  updateAuthUI();
});

// Check for existing session on load
async function initSession(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    currentSession = data.session;
    setAuthStatus('Signed in!');
    updateAuthUI();
  }
}

// ── Event listeners ──

signUpButton.addEventListener('click', () => void handleSignUp());
signInButton.addEventListener('click', () => void handleSignIn());
signOutButton.addEventListener('click', () => void handleSignOut());

// Allow Enter in password field to sign in
passwordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void handleSignIn();
  }
});

sendButton.addEventListener('click', () => void sendMessage());
messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void sendMessage();
  }
});

// ── Chat ──

async function sendMessage(): Promise<void> {
  const message = messageInput.value.trim();
  const token = getAccessToken();

  if (!message) return;

  if (!token) {
    history.appendAssistantMessage('Please sign in first to use the terminal.');
    render();
    return;
  }

  history.appendUserMessage(message);
  messageInput.value = '';
  render();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };

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
      // Try refreshing the session
      const { data } = await supabase.auth.refreshSession();
      if (data.session) {
        currentSession = data.session;
        // Retry the request
        const retryRes = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${data.session.access_token}`
          },
          body: JSON.stringify({ message, conversationHistory })
        });
        if (retryRes.ok) {
          const retryData = (await retryRes.json()) as AgentResponse;
          history.appendAssistantMessage(retryData.answer, {
            confidence: retryData.confidence,
            warnings: retryData.warnings
          });
          render();
          return;
        }
      }
      currentSession = null;
      updateAuthUI();
      history.appendAssistantMessage(
        'Session expired. Please sign in again.',
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

// ── Render ──

function render(): void {
  const messages = history.getMessages();
  messagesEl.innerHTML = messages
    .map((message) => {
      const isUser = message.role === 'user';
      const prefix = isUser ? '&gt;&gt;' : '&lt;&lt;';

      const confidence =
        message.confidence !== undefined
          ? `<div class="meta confidence">[CONFIDENCE: ${Math.round(message.confidence * 100)}%]</div>`
          : '';

      const warnings =
        message.warnings && message.warnings.length
          ? message.warnings
              .map((w) => `<div class="meta warning">[WARNING] ${escapeHtml(w)}</div>`)
              .join('')
          : '';

      return `<div class="message ${message.role}">
        <span class="rolePrefix">${prefix}</span><span class="msgContent">${escapeHtml(message.content)}</span>${confidence}${warnings}
      </div>`;
    })
    .join('');

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
    .replaceAll('\n', '<br/>');
}

// ── Plaid Link Integration ──

declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        onSuccess: (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } }) => void;
        onExit: (err: unknown) => void;
        onEvent: (eventName: string) => void;
      }): { open: () => void };
    };
  }
}

const brokerageSection = document.getElementById('brokerageSection') as HTMLElement;
const connectBrokerageBtn = document.getElementById('connectBrokerageBtn') as HTMLButtonElement;
const brokerageStatus = document.getElementById('brokerageStatus') as HTMLSpanElement;

async function checkPlaidAvailability(): Promise<void> {
  try {
    const token = getAccessToken();
    if (!token) return;
    const res = await fetch(apiUrl('/api/plaid/link-token'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({})
    });
    if (res.status !== 404) {
      brokerageSection.style.display = '';
    }
  } catch {
    // Plaid routes not available
  }
}

connectBrokerageBtn.addEventListener('click', () => void openPlaidLink());

async function openPlaidLink(): Promise<void> {
  if (!window.Plaid) {
    brokerageStatus.textContent = 'Plaid SDK not loaded';
    return;
  }

  const token = getAccessToken();
  if (!token) {
    brokerageStatus.textContent = 'Please sign in first';
    return;
  }

  brokerageStatus.textContent = 'INITIALIZING...';

  try {
    const res = await fetch(apiUrl('/api/plaid/link-token'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({})
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
      brokerageStatus.textContent = `ERROR: ${data?.error ?? res.status}`;
      return;
    }

    const { linkToken } = (await res.json()) as { linkToken: string };

    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: (publicToken: string, metadata) => {
        void exchangePlaidToken(publicToken, metadata.institution?.institution_id, metadata.institution?.name);
      },
      onExit: (err) => {
        if (err) {
          brokerageStatus.textContent = 'CONNECTION CANCELLED';
        } else {
          brokerageStatus.textContent = '';
        }
      },
      onEvent: () => { /* no-op */ }
    });

    handler.open();
    brokerageStatus.textContent = '';
  } catch (error) {
    brokerageStatus.textContent = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function exchangePlaidToken(
  publicToken: string,
  institutionId?: string,
  institutionName?: string
): Promise<void> {
  brokerageStatus.textContent = 'CONNECTING...';

  const token = getAccessToken();
  if (!token) return;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    };

    const res = await fetch(apiUrl('/api/plaid/exchange-token'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ publicToken, institutionId, institutionName })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
      brokerageStatus.textContent = `ERROR: ${data?.error ?? res.status}`;
      return;
    }

    const exchangeData = (await res.json()) as { success: boolean; itemId?: string };

    // Trigger sync after successful exchange
    if (exchangeData.itemId) {
      brokerageStatus.textContent = 'SYNCING HOLDINGS...';
      try {
        await fetch(apiUrl('/api/plaid/sync'), {
          method: 'POST',
          headers,
          body: JSON.stringify({ itemId: exchangeData.itemId })
        });
      } catch {
        // Non-fatal: sync can be triggered manually via chat
      }
    }

    brokerageStatus.textContent = `CONNECTED: ${institutionName ?? 'BROKERAGE'}`;
    history.appendAssistantMessage(
      `Brokerage "${institutionName ?? 'Unknown'}" has been connected and holdings synced. You can now ask me about your portfolio.`
    );
    render();
  } catch (error) {
    brokerageStatus.textContent = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── Init ──
render();
updateTerminalStatus();
void initSession().then(() => {
  void checkPlaidAvailability();
});
