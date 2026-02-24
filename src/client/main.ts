import { AgentChatHistoryService } from './chat-history';

type AgentResponse = {
  answer: string;
  confidence: number;
  warnings: string[];
};

const history = new AgentChatHistoryService();

const messagesEl = document.getElementById('messages') as HTMLDivElement;
const messageInput = document.getElementById('messageInput') as HTMLInputElement;
const sendButton = document.getElementById('sendButton') as HTMLButtonElement;
const jwtInput = document.getElementById('jwt') as HTMLTextAreaElement;
const apiUrlInput = document.getElementById('agentApiUrl') as HTMLInputElement;

render();

sendButton.addEventListener('click', () => {
  void sendMessage();
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void sendMessage();
  }
});

async function sendMessage() {
  const message = messageInput.value.trim();
  const jwt = jwtInput.value.trim();
  const apiBase = apiUrlInput.value.trim().replace(/\/$/, '');

  if (!message) {
    return;
  }

  if (!jwt) {
    alert('JWT is required.');
    return;
  }

  history.appendUserMessage(message);
  messageInput.value = '';
  render();

  try {
    const response = await fetch(`${apiBase}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({ message })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const data = (await response.json()) as AgentResponse;
    history.appendAssistantMessage(data.answer, {
      confidence: data.confidence,
      warnings: data.warnings
    });
  } catch (error) {
    history.appendAssistantMessage(
      `The agent request failed. ${error instanceof Error ? error.message : String(error)}`
    );
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
