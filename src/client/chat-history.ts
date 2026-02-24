export const AGENT_CHAT_HISTORY_KEY = 'agentChatHistory';
export const MAX_HISTORY_MESSAGES = 50;

export type AgentChatRole = 'assistant' | 'user';

export interface AgentChatMessage {
  confidence?: number;
  content: string;
  role: AgentChatRole;
  warnings?: string[];
}

export class AgentChatHistoryService {
  private messages: AgentChatMessage[] = [];

  public constructor() {
    this.messages = this.loadMessages();
  }

  public appendAssistantMessage(
    content: string,
    meta?: { confidence?: number; warnings?: string[] }
  ) {
    this.appendMessage({
      confidence: meta?.confidence,
      content,
      role: 'assistant',
      warnings: meta?.warnings
    });
  }

  public appendUserMessage(content: string) {
    this.appendMessage({
      content,
      role: 'user'
    });
  }

  public getMessages(): AgentChatMessage[] {
    return [...this.messages];
  }

  private appendMessage(message: AgentChatMessage) {
    this.messages = [...this.messages, message].slice(-MAX_HISTORY_MESSAGES);
    this.persistMessages();
  }

  private loadMessages(): AgentChatMessage[] {
    const rawValue = window.localStorage.getItem(AGENT_CHAT_HISTORY_KEY);

    if (!rawValue) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((entry) => {
          return (
            typeof entry?.content === 'string' &&
            (entry?.role === 'assistant' || entry?.role === 'user')
          );
        })
        .map((entry) => ({
          confidence:
            typeof entry.confidence === 'number' ? entry.confidence : undefined,
          content: entry.content,
          role: entry.role,
          warnings: Array.isArray(entry.warnings)
            ? entry.warnings.filter((warning: unknown) => typeof warning === 'string')
            : undefined
        }))
        .slice(-MAX_HISTORY_MESSAGES);
    } catch {
      return [];
    }
  }

  private persistMessages() {
    window.localStorage.setItem(
      AGENT_CHAT_HISTORY_KEY,
      JSON.stringify(this.messages)
    );
  }
}
