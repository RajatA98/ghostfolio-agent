import { createClient, Session } from '@supabase/supabase-js';
import { marked } from 'marked';
import { AgentChatHistoryService } from './chat-history';

// Configure marked: GFM tables, hard line-breaks, no async
marked.use({
  gfm: true,
  breaks: true
});

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string || '';

const supabaseConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_ANON_KEY || 'placeholder');

const API_BASE = '';

type AgentResponse = {
  answer: string;
  confidence: number;
  warnings: string[];
  toolTrace?: Array<{ tool: string; ok: boolean; ms: number; error?: string | null }>;
  loopMeta?: {
    iterations: number;
    totalMs: number;
    tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
    terminationReason:
      | 'end_turn'
      | 'max_iterations'
      | 'timeout'
      | 'cost_limit'
      | 'circuit_breaker'
      | 'trade_blocked'
      | 'error';
  };
};

type AgentStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  | { type: 'thinking'; iteration: number }
  | { type: 'tool_start'; tool: string; iteration: number }
  | {
      type: 'tool_end';
      tool: string;
      ok: boolean;
      ms: number;
      iteration: number;
      detail?: string;
    }
  | {
      type: 'done';
      answer: string;
      confidence: number;
      warnings: string[];
      toolTrace: Array<{ tool: string; ok: boolean; ms: number; error?: string | null }>;
      loopMeta?: {
        iterations: number;
        totalMs: number;
        tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
        terminationReason:
          | 'end_turn'
          | 'max_iterations'
          | 'timeout'
          | 'cost_limit'
          | 'circuit_breaker'
          | 'trade_blocked'
          | 'error';
      };
    }
  | { type: 'error'; message: string };

let history = new AgentChatHistoryService();

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
const authPage = document.getElementById('authPage') as HTMLElement;
const terminalPage = document.getElementById('terminalPage') as HTMLElement;
const headerUserEmail = document.getElementById('headerUserEmail') as HTMLSpanElement;
const googleSignInButton = document.getElementById('googleSignInButton') as HTMLButtonElement;

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
  authStatusEl.className = 'authStatusMsg' + (isError ? ' error' : '');
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

  // Toggle between auth page and terminal (guard so we never leave both hidden)
  if (authPage) authPage.style.display = loggedIn ? 'none' : '';
  if (terminalPage) terminalPage.style.display = loggedIn ? '' : 'none';

  // Show user email in terminal header
  if (headerUserEmail) {
    headerUserEmail.textContent = loggedIn ? (currentSession!.user.email ?? '') : '';
  }

  updateTerminalStatus();
}

function initHistoryForUser(userId?: string): void {
  history = new AgentChatHistoryService(userId);
  render();
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
  messagesEl.innerHTML = '';
  await supabase.auth.signOut();
  currentSession = null;
  setAuthStatus('');
  updateAuthUI();
}

async function handleGoogleSignIn(): Promise<void> {
  setAuthStatus('REDIRECTING TO GOOGLE...');

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin
    }
  });

  if (error) {
    setAuthStatus(`Google sign in failed: ${error.message}`, true);
  }
}

// Listen for auth state changes (e.g. token refresh, OAuth callback)
supabase.auth.onAuthStateChange((event, session) => {
  currentSession = session;

  if (event === 'SIGNED_IN' && session) {
    setAuthStatus('Signed in!');
    // Scope chat history to this user
    AgentChatHistoryService.removeUnscopedHistory();
    initHistoryForUser(session.user.id);
    // Provision Ghostfolio account (covers Google OAuth and any other provider)
    void fetch(apiUrl('/api/auth/signup'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`
      }
    }).catch(() => { /* non-fatal */ });
  } else if (event === 'SIGNED_OUT') {
    setAuthStatus('');
    // Reset to empty anonymous history so next user doesn't see messages
    initHistoryForUser();
  }

  updateAuthUI();
});

// Check for existing session on load (including OAuth callback hash)
async function initSession(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      currentSession = data.session;
      AgentChatHistoryService.removeUnscopedHistory();
      initHistoryForUser(data.session.user.id);
    }
  } catch (e) {
    // e.g. invalid Supabase URL or network; show auth screen
    currentSession = null;
  }
  // Always show auth or terminal so we never get a blank screen
  updateAuthUI();
}

// ── Event listeners ──

signUpButton.addEventListener('click', () => void handleSignUp());
signInButton.addEventListener('click', () => void handleSignIn());
signOutButton.addEventListener('click', () => void handleSignOut());
googleSignInButton.addEventListener('click', () => void handleGoogleSignIn());

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

function formatIteration(iteration: number): string {
  return String(iteration).padStart(2, '0');
}

function createAgentConsoleElement(): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant';
  wrapper.innerHTML =
    '<span class="rolePrefix">&lt;&lt;</span>' +
    '<div class="agentConsole">' +
    '<div class="agentConsoleHeader">[AGENT]</div>' +
    '<div class="agentConsoleLines"></div>' +
    '</div>';
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrapper;
}

function appendAgentConsoleLine(
  consoleWrapper: HTMLDivElement,
  text: string,
  className?: string
): void {
  const linesEl = consoleWrapper.querySelector('.agentConsoleLines') as HTMLDivElement | null;
  if (!linesEl) return;

  const lineEl = document.createElement('div');
  lineEl.className = className ? `agentConsoleLine ${className}` : 'agentConsoleLine';
  lineEl.textContent = text;
  linesEl.appendChild(lineEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

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
  sendButton.disabled = true;
  messageInput.disabled = true;

  const payload = (() => {
    const allMessages = history.getMessages();
    const conversationHistory = allMessages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content
    }));
    return { message, conversationHistory };
  })();

  const streamRequest = async (accessToken: string): Promise<Response> =>
    fetch(apiUrl('/api/chat/stream'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload)
    });

  const agentConsole = createAgentConsoleElement();
  appendAgentConsoleLine(agentConsole, 'CONNECTING TO AGENT...', 'cl-thinking');

  try {
    let response = await streamRequest(token);

    if (response.status === 401) {
      const { data } = await supabase.auth.refreshSession();
      if (data.session) {
        currentSession = data.session;
        response = await streamRequest(data.session.access_token);
      }
      if (response.status === 401) {
        currentSession = null;
        updateAuthUI();
        history.appendAssistantMessage(
          'Session expired. Please sign in again.',
          {}
        );
        agentConsole.remove();
        render();
        return;
      }
    }

    if (!response.ok) {
      const text = await response.text();
      const detail = text.trim();
      agentConsole.remove();
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

    if (!response.body) {
      throw new Error('Streaming response was empty.');
    }

    appendAgentConsoleLine(agentConsole, 'CONNECTED. STREAMING EVENTS...', 'cl-thinking');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse: AgentResponse | null = null;
    let streamError: string | null = null;

    const handleStreamEvent = (event: AgentStreamEvent): void => {
      switch (event.type) {
        case 'iteration_start': {
          appendAgentConsoleLine(
            agentConsole,
            `ITER ${formatIteration(event.iteration)} | THINKING...`,
            'cl-thinking'
          );
          break;
        }
        case 'thinking': {
          appendAgentConsoleLine(
            agentConsole,
            `ITER ${formatIteration(event.iteration)} | LLM STEP READY`,
            'cl-thinking'
          );
          break;
        }
        case 'tool_start': {
          appendAgentConsoleLine(
            agentConsole,
            `ITER ${formatIteration(event.iteration)} | TOOL ${event.tool} [RUNNING]`,
            'cl-tool-running'
          );
          break;
        }
        case 'tool_end': {
          const blocked = event.detail?.toUpperCase().includes('BLOCKED');
          if (blocked) {
            appendAgentConsoleLine(
              agentConsole,
              `ITER ${formatIteration(event.iteration)} | TOOL ${event.tool} [BLOCKED] ${event.detail ?? ''}`.trim(),
              'cl-tool-blocked'
            );
            break;
          }
          if (event.ok) {
            appendAgentConsoleLine(
              agentConsole,
              `ITER ${formatIteration(event.iteration)} | TOOL ${event.tool} [OK ${event.ms}ms]${event.detail ? ` ${event.detail}` : ''}`,
              'cl-tool-ok'
            );
          } else {
            appendAgentConsoleLine(
              agentConsole,
              `ITER ${formatIteration(event.iteration)} | TOOL ${event.tool} [FAIL ${event.ms}ms]${event.detail ? ` ${event.detail}` : ''}`,
              'cl-tool-fail'
            );
          }
          break;
        }
        case 'done': {
          finalResponse = {
            answer: event.answer,
            confidence: event.confidence,
            warnings: event.warnings,
            toolTrace: event.toolTrace,
            loopMeta: event.loopMeta
          };
          const iters = event.loopMeta?.iterations ?? '-';
          const totalMs = event.loopMeta?.totalMs ?? 0;
          appendAgentConsoleLine(
            agentConsole,
            `DONE — ${iters} iters · ${(totalMs / 1000).toFixed(1)}s`,
            'cl-done'
          );
          // METRICS: cost, tokens, tools, success (same style as CLI observability)
          const meta = event.loopMeta;
          const trace = event.toolTrace ?? [];
          if (meta) {
            const COST_PER_INPUT = 3.0 / 1_000_000;
            const COST_PER_OUTPUT = 15.0 / 1_000_000;
            const cost =
              (meta.tokenUsage.inputTokens ?? 0) * COST_PER_INPUT +
              (meta.tokenUsage.outputTokens ?? 0) * COST_PER_OUTPUT;
            const tokens =
              meta.tokenUsage.totalTokens ??
              (meta.tokenUsage.inputTokens ?? 0) + (meta.tokenUsage.outputTokens ?? 0);
            const toolsList = trace.length ? trace.map((t) => t.tool).join(', ') : '—';
            const success = meta.terminationReason === 'end_turn';
            appendAgentConsoleLine(
              agentConsole,
              `METRICS: cost $${cost.toFixed(4)} · tokens ${tokens} · tools: ${toolsList} · success: ${success}`,
              'cl-metrics'
            );
          }
          break;
        }
        case 'error': {
          appendAgentConsoleLine(agentConsole, `ERROR — ${event.message}`, 'cl-tool-fail');
          streamError = event.message;
          break;
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const dataPayload = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');

        if (dataPayload) {
          try {
            const parsed = JSON.parse(dataPayload) as AgentStreamEvent;
            handleStreamEvent(parsed);
          } catch (parseError) {
            const msg =
              parseError instanceof Error ? parseError.message : String(parseError);
            appendAgentConsoleLine(
              agentConsole,
              `STREAM PARSE ERROR — ${msg}`,
              'cl-tool-fail'
            );
          }
        }

        if (streamError) {
          throw new Error(streamError);
        }

        separatorIndex = buffer.indexOf('\n\n');
      }
    }

    if (streamError) {
      throw new Error(streamError);
    }

    if (!finalResponse) {
      throw new Error('Agent stream ended without a final response.');
    }

    agentConsole.remove();
    history.appendAssistantMessage(finalResponse.answer, {
      confidence: finalResponse.confidence,
      warnings: finalResponse.warnings
    });
  } catch (error) {
    agentConsole.remove();
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
  } finally {
    sendButton.disabled = false;
    messageInput.disabled = false;
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

      // User messages: plain text (escaped). Assistant messages: markdown.
      const content = isUser
        ? `<span class="msgContent msgContent--plain">${escapeHtml(message.content)}</span>`
        : `<div class="msgContent msgContent--md">${renderMarkdown(message.content)}</div>`;

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
        <span class="rolePrefix">${prefix}</span>${content}${confidence}${warnings}
      </div>`;
    })
    .join('');

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** Render assistant markdown as HTML. Uses marked (GFM). */
function renderMarkdown(text: string): string {
  // marked.parse is synchronous when no async extensions are used
  const html = marked.parse(text) as string;

  // Post-process markdown tables so 2-column "Field | Details" tables
  // can be styled as receipts while wider tables keep data-grid styling.
  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  tmp.querySelectorAll('table').forEach((table) => {
    if (table.querySelectorAll('thead th').length === 2) {
      table.classList.add('table--receipt');
    }
  });

  return tmp.innerHTML;
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

// ── Init ──
render();

if (!supabaseConfigured) {
  setAuthStatus('Configuration error: authentication service not configured (missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY).', true);
} else {
  void initSession();
}
