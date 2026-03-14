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
    terminationReason: string;
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
      loopMeta?: AgentResponse['loopMeta'];
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

// Brokerage elements
const brokerageStatusIndicator = document.getElementById('brokerageStatusIndicator') as HTMLSpanElement;
const connectBrokerageBtn = document.getElementById('connectBrokerageBtn') as HTMLButtonElement;
const brokerageStatus = document.getElementById('brokerageStatus') as HTMLSpanElement;
const linkedAccountsEl = document.getElementById('linkedAccounts') as HTMLDivElement;

// Dashboard elements
const dashboardPanel = document.getElementById('dashboardPanel') as HTMLElement;
const totalValueEl = document.getElementById('totalValue') as HTMLDivElement;
const allocationCanvas = document.getElementById('allocationChart') as HTMLCanvasElement;
const allocationLegend = document.getElementById('allocationLegend') as HTMLDivElement;
const performanceValue = document.getElementById('performanceValue') as HTMLDivElement;
const performanceLabel = document.getElementById('performanceLabel') as HTMLDivElement;
const holdingsTableEl = document.getElementById('holdingsTable') as HTMLDivElement;

let currentSession: Session | null = null;
let hasBrokerage = false;

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function getAccessToken(): string | null {
  return currentSession?.access_token ?? null;
}

function authHeaders(): Record<string, string> {
  const token = getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function setAuthStatus(text: string, isError = false): void {
  authStatusEl.textContent = text;
  authStatusEl.className = 'authStatusMsg' + (isError ? ' error' : '');
}

function updateTerminalStatus(): void {
  const connected = !!currentSession;
  if (headerDot) headerDot.style.background = connected ? '#33ff33' : '#ff3333';
  if (headerStatus) headerStatus.textContent = connected ? 'ONLINE' : 'OFFLINE';
  if (statusDot) statusDot.className = 'statusDot' + (connected ? ' connected' : '');
  if (statusText) statusText.textContent = hasBrokerage ? 'BROKERAGE LINKED' : (connected ? 'NO BROKERAGE' : 'DISCONNECTED');
}

function updateAuthUI(): void {
  const loggedIn = !!currentSession;

  if (authPage) authPage.style.display = loggedIn ? 'none' : '';
  if (terminalPage) terminalPage.style.display = loggedIn ? '' : 'none';

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
  hasBrokerage = false;
  setAuthStatus('');
  dashboardPanel.style.display = 'none';
  initHistoryForUser();
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

supabase.auth.onAuthStateChange((event, session) => {
  currentSession = session;

  if (event === 'SIGNED_IN' && session) {
    setAuthStatus('Signed in!');
    AgentChatHistoryService.removeUnscopedHistory();
    initHistoryForUser(session.user.id);
    void checkBrokerageStatus();
  } else if (event === 'SIGNED_OUT') {
    setAuthStatus('');
    hasBrokerage = false;
    initHistoryForUser();
  }

  updateAuthUI();
});

async function initSession(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      currentSession = data.session;
      AgentChatHistoryService.removeUnscopedHistory();
      initHistoryForUser(data.session.user.id);
    }
  } catch {
    currentSession = null;
  }
  updateAuthUI();
}

// ── Event listeners ──

signUpButton.addEventListener('click', () => void handleSignUp());
signInButton.addEventListener('click', () => void handleSignIn());
signOutButton.addEventListener('click', () => void handleSignOut());
googleSignInButton.addEventListener('click', () => void handleGoogleSignIn());

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

connectBrokerageBtn.addEventListener('click', () => void openSnapTradeConnect());

// ── SnapTrade Brokerage Integration ──

async function checkBrokerageStatus(): Promise<void> {
  const token = getAccessToken();
  if (!token) return;

  try {
    const res = await fetch(apiUrl('/api/snaptrade/connections'), {
      headers: authHeaders()
    });

    if (!res.ok) {
      brokerageStatusIndicator.textContent = 'NO BROKERAGE';
      brokerageStatusIndicator.classList.remove('connected');
      hasBrokerage = false;
      updateTerminalStatus();
      return;
    }

    const data = (await res.json()) as { connections?: Array<{ id: string; brokerageName: string }> };
    if (data.connections && data.connections.length > 0) {
      hasBrokerage = true;
      brokerageStatusIndicator.textContent = `LINKED: ${data.connections.map((c) => c.brokerageName).join(', ')}`;
      brokerageStatusIndicator.classList.add('connected');
      renderLinkedAccounts(data.connections);
      void loadDashboard();
    } else {
      hasBrokerage = false;
      brokerageStatusIndicator.textContent = 'NO BROKERAGE';
      brokerageStatusIndicator.classList.remove('connected');
    }
    updateTerminalStatus();
  } catch {
    brokerageStatusIndicator.textContent = 'NO BROKERAGE';
    brokerageStatusIndicator.classList.remove('connected');
    hasBrokerage = false;
    updateTerminalStatus();
  }
}

function renderLinkedAccounts(connections: Array<{ id: string; brokerageName: string }>): void {
  linkedAccountsEl.style.display = '';
  linkedAccountsEl.innerHTML = connections
    .map((c) => `<div class="linkedAccount"><span class="linkedAccountDot"></span> ${escapeHtml(c.brokerageName)}</div>`)
    .join('');
}

async function openSnapTradeConnect(): Promise<void> {
  const token = getAccessToken();
  if (!token) {
    brokerageStatus.textContent = 'SIGN IN FIRST';
    return;
  }

  brokerageStatus.textContent = 'INITIALIZING...';

  // Open popup immediately on user gesture to avoid popup blockers (Safari/Chrome)
  const popup = window.open('about:blank', 'snaptrade-connect', 'width=500,height=700');

  try {
    // Register user (idempotent)
    const regRes = await fetch(apiUrl('/api/snaptrade/register'), {
      method: 'POST',
      headers: authHeaders()
    });

    if (!regRes.ok) {
      const errData = (await regRes.json().catch(() => ({ error: 'Registration failed' }))) as { error?: string };
      popup?.close();
      brokerageStatus.textContent = `ERROR: ${errData?.error ?? regRes.status}`;
      return;
    }

    // Get connect URL
    const res = await fetch(apiUrl('/api/snaptrade/connect-url'), {
      headers: authHeaders()
    });

    if (!res.ok) {
      const errData = (await res.json().catch(() => ({ error: 'Unknown error' }))) as { error?: string };
      popup?.close();
      brokerageStatus.textContent = `ERROR: ${errData?.error ?? res.status}`;
      return;
    }

    const { redirectURI } = (await res.json()) as { redirectURI: string };

    // Navigate the already-open popup to the SnapTrade portal
    if (popup) {
      popup.location.href = redirectURI;
    } else {
      // Fallback: popup was still blocked, open in new tab
      window.open(redirectURI, '_blank');
    }
    brokerageStatus.textContent = 'CONNECTING...';

    // Listen for postMessage from callback page OR poll for popup close
    const onMessage = (event: MessageEvent) => {
      if (event.data === 'snaptrade-connected') {
        cleanup();
        brokerageStatus.textContent = 'SYNCING...';
        void checkBrokerageStatus().then(() => {
          void loadDashboard();
          brokerageStatus.textContent = '';
        });
      }
    };
    window.addEventListener('message', onMessage);

    const pollInterval = setInterval(() => {
      if (popup && popup.closed) {
        cleanup();
        brokerageStatus.textContent = 'SYNCING...';
        void checkBrokerageStatus().then(() => {
          void loadDashboard();
          brokerageStatus.textContent = '';
        });
      }
    }, 1000);

    const cleanup = () => {
      clearInterval(pollInterval);
      window.removeEventListener('message', onMessage);
      popup?.close();
    };
  } catch (error) {
    brokerageStatus.textContent = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── Dashboard ──

async function loadDashboard(): Promise<void> {
  const token = getAccessToken();
  if (!token) return;

  try {
    const res = await fetch(apiUrl('/api/snaptrade/holdings'), {
      headers: authHeaders()
    });
    if (!res.ok) return;

    const data = (await res.json()) as {
      holdings: Array<{
        symbol: string;
        name: string;
        quantity: number;
        costBasis: number | null;
        currentValue: number | null;
        currency: string;
        institutionName: string;
      }>;
    };

    if (data.holdings && data.holdings.length > 0) {
      dashboardPanel.style.display = '';
      renderDashboard(data.holdings);
    }
  } catch {
    // Non-fatal
  }
}

function renderDashboard(
  holdings: Array<{
    symbol: string;
    name: string;
    quantity: number;
    costBasis: number | null;
    currentValue: number | null;
    currency: string;
    institutionName: string;
  }>
): void {
  // Total value
  const total = holdings.reduce((sum, h) => sum + (h.currentValue ?? h.costBasis ?? 0), 0);
  totalValueEl.textContent = `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Performance (total return)
  const totalCost = holdings.reduce((sum, h) => sum + (h.costBasis ?? 0), 0);
  const totalCurrent = holdings.reduce((sum, h) => sum + (h.currentValue ?? h.costBasis ?? 0), 0);
  if (totalCost > 0) {
    const returnPct = ((totalCurrent - totalCost) / totalCost) * 100;
    const gain = totalCurrent - totalCost;
    const isPositive = gain >= 0;
    performanceValue.textContent = `${isPositive ? '+' : ''}${returnPct.toFixed(2)}%`;
    performanceValue.className = `performanceValue ${isPositive ? 'positive' : 'negative'}`;
    performanceLabel.textContent = `${isPositive ? '+' : ''}$${gain.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TOTAL RETURN`;
  }

  // Allocation donut chart
  renderDonutChart(holdings, total);

  // Holdings table
  renderHoldingsTable(holdings);
}

const CHART_COLORS = [
  '#ff6600', '#33ff33', '#ff3333', '#3399ff', '#ffcc00',
  '#cc33ff', '#00cccc', '#ff6699', '#99cc00', '#6633ff'
];

function renderDonutChart(
  holdings: Array<{ symbol: string; currentValue: number | null; costBasis: number | null }>,
  total: number
): void {
  const ctx = allocationCanvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  allocationCanvas.width = 200 * dpr;
  allocationCanvas.height = 200 * dpr;
  ctx.scale(dpr, dpr);

  const cx = 100;
  const cy = 100;
  const outerR = 90;
  const innerR = 55;

  ctx.clearRect(0, 0, 200, 200);

  if (total <= 0) return;

  // Sort by value descending
  const sorted = [...holdings]
    .map((h) => ({ symbol: h.symbol, value: h.currentValue ?? h.costBasis ?? 0 }))
    .filter((h) => h.value > 0)
    .sort((a, b) => b.value - a.value);

  let startAngle = -Math.PI / 2;
  const legendItems: string[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];
    const pct = h.value / total;
    const sliceAngle = pct * 2 * Math.PI;
    const color = CHART_COLORS[i % CHART_COLORS.length];

    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, startAngle + sliceAngle);
    ctx.arc(cx, cy, innerR, startAngle + sliceAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    legendItems.push(
      `<div class="legendItem"><span class="legendDot" style="background:${color}"></span>${escapeHtml(h.symbol)} <span class="legendPct">${(pct * 100).toFixed(1)}%</span></div>`
    );

    startAngle += sliceAngle;
  }

  // Center text
  ctx.fillStyle = '#c8c8c8';
  ctx.font = '700 14px "SF Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`$${(total / 1000).toFixed(1)}K`, cx, cy);

  allocationLegend.innerHTML = legendItems.join('');
}

function renderHoldingsTable(
  holdings: Array<{
    symbol: string;
    name: string;
    quantity: number;
    currentValue: number | null;
    costBasis: number | null;
    currency: string;
    institutionName: string;
  }>
): void {
  const sorted = [...holdings].sort(
    (a, b) => (b.currentValue ?? b.costBasis ?? 0) - (a.currentValue ?? a.costBasis ?? 0)
  );

  const rows = sorted
    .map((h) => {
      const val = h.currentValue ?? h.costBasis ?? 0;
      return `<div class="holdingRow">
      <span class="holdingSymbol">${escapeHtml(h.symbol)}</span>
      <span class="holdingQty">${h.quantity.toFixed(2)}</span>
      <span class="holdingValue">$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </div>`;
    })
    .join('');

  holdingsTableEl.innerHTML = `
    <div class="holdingRow holdingHeader">
      <span class="holdingSymbol">SYMBOL</span>
      <span class="holdingQty">QTY</span>
      <span class="holdingValue">VALUE</span>
    </div>
    ${rows}`;
}

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

  // Try streaming first, fall back to regular chat
  const useStreaming = true;

  if (useStreaming) {
    await sendMessageStreaming(payload, token);
  } else {
    await sendMessageClassic(payload, token);
  }

  sendButton.disabled = false;
  messageInput.disabled = false;
  render();
}

async function sendMessageStreaming(
  payload: { message: string; conversationHistory: Array<{ role: string; content: string }> },
  token: string
): Promise<void> {
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

    // If streaming endpoint not found, fall back to classic
    if (response.status === 404) {
      agentConsole.remove();
      await sendMessageClassic(payload, token);
      return;
    }

    if (response.status === 401) {
      const { data } = await supabase.auth.refreshSession();
      if (data.session) {
        currentSession = data.session;
        response = await streamRequest(data.session.access_token);
      }
      if (response.status === 401) {
        currentSession = null;
        updateAuthUI();
        history.appendAssistantMessage('Session expired. Please sign in again.');
        agentConsole.remove();
        return;
      }
    }

    if (!response.ok) {
      const text = await response.text();
      agentConsole.remove();
      history.appendAssistantMessage(
        `The agent request failed (HTTP ${response.status}). ${text.trim()}`
      );
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
          } else if (event.ok) {
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
  }
}

async function sendMessageClassic(
  payload: { message: string; conversationHistory: Array<{ role: string; content: string }> },
  token: string
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };

  try {
    const response = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (response.status === 401) {
      const { data } = await supabase.auth.refreshSession();
      if (data.session) {
        currentSession = data.session;
        const retryRes = await fetch(apiUrl('/api/chat'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${data.session.access_token}`
          },
          body: JSON.stringify(payload)
        });
        if (retryRes.ok) {
          const retryData = (await retryRes.json()) as AgentResponse;
          history.appendAssistantMessage(retryData.answer, {
            confidence: retryData.confidence,
            warnings: retryData.warnings
          });
          return;
        }
      }
      currentSession = null;
      updateAuthUI();
      history.appendAssistantMessage('Session expired. Please sign in again.');
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      const detail = text.trim();
      if (response.status === 404) {
        history.appendAssistantMessage(
          'The agent request failed. Endpoint not found.'
        );
      } else {
        const suffix = detail ? ` (${detail})` : '';
        history.appendAssistantMessage(
          `The agent request failed (HTTP ${response.status}).${suffix}`
        );
      }
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
        'The agent request failed. Could not reach the agent server.'
      );
    } else {
      history.appendAssistantMessage(`The agent request failed. ${msg}`);
    }
  }
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
  const html = marked.parse(text) as string;

  // Post-process: 2-column tables get receipt styling
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
  void initSession().then(() => {
    void checkBrokerageStatus();
  });
}
