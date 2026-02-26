/**
 * Trade Confirmation Guardrail
 *
 * Hard code-level enforcement that prevents the LLM from executing
 * paper trades without explicit user confirmation. The LLM cannot
 * bypass this — it runs before the tool executor.
 */

export interface TradeGuardrailInput {
  symbol: string;
  side: string;
  quantity: number;
  unitPrice: number;
  currency?: string;
}

export interface TradeGuardrailResult {
  allowed: boolean;
  cancelled?: boolean;
  reason: string;
  proposal?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const CONFIRMATION_PATTERNS = [
  /^yes$/i,
  /^y$/i,
  /^confirm$/i,
  /^go ahead$/i,
  /^do it$/i,
  /^execute$/i,
  /^proceed$/i,
  /^sure$/i,
  /^ok$/i,
  /^okay$/i,
  /^yep$/i,
  /^yeah$/i,
  /^yup$/i,
  /^absolutely$/i,
  /^affirmative$/i
];

const CANCELLATION_PATTERNS = [
  /^no$/i,
  /^n$/i,
  /^cancel$/i,
  /^nevermind$/i,
  /^never mind$/i,
  /^abort$/i,
  /^don'?t$/i,
  /^stop$/i,
  /^scratch that$/i,
  /^nah$/i,
  /^nope$/i
];

function isConfirmation(message: string): boolean {
  const trimmed = message.trim();
  return CONFIRMATION_PATTERNS.some((p) => p.test(trimmed));
}

function isCancellation(message: string): boolean {
  const trimmed = message.trim();
  return CANCELLATION_PATTERNS.some((p) => p.test(trimmed));
}

function hasPriorProposal(
  symbol: string,
  side: string,
  history: ConversationMessage[]
): boolean {
  const upperSymbol = symbol.toUpperCase();
  const upperSide = side.toUpperCase();

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;

    const content = msg.content.toUpperCase();
    if (
      content.includes(upperSymbol) &&
      content.includes(upperSide) &&
      (content.includes('CONFIRM') || content.includes('CONFIRMATION_REQUIRED'))
    ) {
      return true;
    }
  }

  return false;
}

export function checkTradeConfirmation(
  input: TradeGuardrailInput,
  currentMessage: string,
  conversationHistory?: ConversationMessage[]
): TradeGuardrailResult {
  const history = conversationHistory ?? [];

  // Check if the assistant previously proposed this exact trade
  const hasProposal = hasPriorProposal(input.symbol, input.side, history);

  if (!hasProposal) {
    // No prior proposal — block and ask for confirmation
    return {
      allowed: false,
      reason: 'No prior trade proposal found in conversation history.',
      proposal: formatTradeProposal(input)
    };
  }

  // There IS a prior proposal — check if user confirmed or cancelled
  if (isCancellation(currentMessage)) {
    return {
      allowed: false,
      cancelled: true,
      reason: 'User cancelled the trade.'
    };
  }

  if (isConfirmation(currentMessage)) {
    return {
      allowed: true,
      reason: 'User confirmed the trade.'
    };
  }

  // Prior proposal exists but user message is neither confirm nor cancel
  // Block and re-propose (user might be modifying the trade)
  return {
    allowed: false,
    reason: 'User message is neither confirmation nor cancellation. Re-proposing trade.',
    proposal: formatTradeProposal(input)
  };
}

export function formatTradeProposal(input: TradeGuardrailInput): string {
  const currency = input.currency ?? 'USD';
  const total = input.quantity * input.unitPrice;

  return [
    'CONFIRMATION_REQUIRED: The trade has NOT been executed. You MUST present these details to the user and ask for confirmation.',
    'Present this as a conversational confirmation prompt (do NOT just dump the raw data). Your response MUST include:',
    '1. The trade details below',
    '2. The phrase "paper trade" (to remind them no real money is involved)',
    '3. An option to "cancel" (so they can abort)',
    '',
    'Trade details:',
    `- Action: ${input.side.toUpperCase()} ${input.quantity} shares of ${input.symbol.toUpperCase()}`,
    `- Price: $${input.unitPrice.toFixed(2)} per share`,
    `- Estimated total: $${total.toFixed(2)}`,
    `- Currency: ${currency}`,
    '- Type: Paper trade (simulated, no real money)',
    '',
    "Tell the user to reply 'yes' to confirm or 'cancel' to abort."
  ].join('\n');
}
