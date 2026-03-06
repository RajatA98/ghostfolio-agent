import {
  checkTransactionMode,
  checkTradeSafetyLimits,
  checkFundMovementSafetyLimits,
  checkTradeConfirmation,
  checkFundMovementConfirmation,
  formatTradeProposal,
  formatFundMovementProposal
} from '../trade-guardrail';

describe('Transaction Mode Guard', () => {
  const originalMode = process.env.AGENT_TRANSACTION_MODE;

  afterEach(() => {
    if (originalMode !== undefined) {
      process.env.AGENT_TRANSACTION_MODE = originalMode;
    } else {
      delete process.env.AGENT_TRANSACTION_MODE;
    }
  });

  it('allows transactions in paper mode (default)', () => {
    delete process.env.AGENT_TRANSACTION_MODE;
    const result = checkTransactionMode();
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('paper');
  });

  it('allows transactions when explicitly set to paper', () => {
    process.env.AGENT_TRANSACTION_MODE = 'paper';
    const result = checkTransactionMode();
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('paper');
  });

  it('blocks transactions in live mode', () => {
    process.env.AGENT_TRANSACTION_MODE = 'live';
    const result = checkTransactionMode();
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe('live');
    expect(result.reason).toContain('BLOCKED');
    expect(result.reason).toContain('not implemented');
  });

  it('defaults to paper for unknown mode values', () => {
    process.env.AGENT_TRANSACTION_MODE = 'yolo';
    const result = checkTransactionMode();
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('paper');
  });
});

describe('Trade Safety Limits', () => {
  it('allows normal trades', () => {
    const result = checkTradeSafetyLimits({ quantity: 100, unitPrice: 150 });
    expect(result.allowed).toBe(true);
  });

  it('blocks quantity exceeding 1M shares', () => {
    const result = checkTradeSafetyLimits({ quantity: 1_500_000, unitPrice: 1 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Quantity');
  });

  it('blocks trade value exceeding $10M', () => {
    const result = checkTradeSafetyLimits({ quantity: 100_000, unitPrice: 200 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Trade value');
  });

  it('blocks zero quantity', () => {
    const result = checkTradeSafetyLimits({ quantity: 0, unitPrice: 100 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('positive');
  });

  it('blocks negative unit price', () => {
    const result = checkTradeSafetyLimits({ quantity: 10, unitPrice: -5 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('positive');
  });

  it('allows trades right at $10M boundary', () => {
    const result = checkTradeSafetyLimits({ quantity: 100_000, unitPrice: 100 });
    expect(result.allowed).toBe(true);
  });

  it('allows trades right at 1M quantity boundary', () => {
    const result = checkTradeSafetyLimits({ quantity: 1_000_000, unitPrice: 1 });
    expect(result.allowed).toBe(true);
  });
});

describe('Fund Movement Safety Limits', () => {
  it('allows normal fund movements', () => {
    const result = checkFundMovementSafetyLimits({ amount: 5000 });
    expect(result.allowed).toBe(true);
  });

  it('blocks zero amount', () => {
    const result = checkFundMovementSafetyLimits({ amount: 0 });
    expect(result.allowed).toBe(false);
  });

  it('blocks negative amount', () => {
    const result = checkFundMovementSafetyLimits({ amount: -100 });
    expect(result.allowed).toBe(false);
  });

  it('blocks amounts exceeding $10M', () => {
    const result = checkFundMovementSafetyLimits({ amount: 15_000_000 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds maximum');
  });
});

describe('Trade Confirmation Guardrail', () => {
  it('blocks trade when no prior proposal exists', () => {
    const result = checkTradeConfirmation(
      { symbol: 'AAPL', side: 'BUY', quantity: 10, unitPrice: 150 },
      'buy 10 shares of AAPL',
      []
    );
    expect(result.allowed).toBe(false);
    expect(result.proposal).toBeDefined();
    expect(result.proposal).toContain('CONFIRMATION_REQUIRED');
  });

  it('allows trade when user confirms after proposal', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'CONFIRMATION_REQUIRED: BUY 10 shares of AAPL at $150. Paper trade.'
      }
    ];
    const result = checkTradeConfirmation(
      { symbol: 'AAPL', side: 'BUY', quantity: 10, unitPrice: 150 },
      'yes',
      history
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks trade when user cancels', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'CONFIRMATION_REQUIRED: BUY 10 shares of AAPL at $150. Paper trade.'
      }
    ];
    const result = checkTradeConfirmation(
      { symbol: 'AAPL', side: 'BUY', quantity: 10, unitPrice: 150 },
      'cancel',
      history
    );
    expect(result.allowed).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  it('blocks and re-proposes when user message is ambiguous', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'CONFIRMATION_REQUIRED: BUY 10 shares of AAPL at $150.'
      }
    ];
    const result = checkTradeConfirmation(
      { symbol: 'AAPL', side: 'BUY', quantity: 10, unitPrice: 150 },
      'actually make it 20 shares',
      history
    );
    expect(result.allowed).toBe(false);
    expect(result.proposal).toBeDefined();
  });

  it('recognizes various confirmation phrases', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'CONFIRMATION_REQUIRED: BUY 5 shares of MSFT'
      }
    ];
    const confirmations = ['yes', 'y', 'confirm', 'go ahead', 'do it', 'proceed', 'sure', 'ok', 'yep', 'yeah'];
    for (const msg of confirmations) {
      const result = checkTradeConfirmation(
        { symbol: 'MSFT', side: 'BUY', quantity: 5, unitPrice: 300 },
        msg,
        history
      );
      expect(result.allowed).toBe(true);
    }
  });

  it('recognizes various cancellation phrases', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'CONFIRMATION_REQUIRED: SELL 5 shares of TSLA'
      }
    ];
    const cancellations = ['no', 'n', 'cancel', 'nevermind', 'abort', "don't", 'stop', 'nah', 'nope'];
    for (const msg of cancellations) {
      const result = checkTradeConfirmation(
        { symbol: 'TSLA', side: 'SELL', quantity: 5, unitPrice: 200 },
        msg,
        history
      );
      expect(result.allowed).toBe(false);
      expect(result.cancelled).toBe(true);
    }
  });
});

describe('Fund Movement Confirmation Guardrail', () => {
  it('blocks fund movement when no prior proposal exists', () => {
    const result = checkFundMovementConfirmation(
      { type: 'DEPOSIT', amount: 1000 },
      'deposit $1000',
      []
    );
    expect(result.allowed).toBe(false);
    expect(result.proposal).toContain('CONFIRMATION_REQUIRED');
  });

  it('allows fund movement when user confirms', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'CONFIRMATION_REQUIRED: DEPOSIT $1000. Simulated fund movement.'
      }
    ];
    const result = checkFundMovementConfirmation(
      { type: 'DEPOSIT', amount: 1000 },
      'yes',
      history
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks fund movement when user cancels', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: 'CONFIRMATION_REQUIRED: WITHDRAWAL $500.'
      }
    ];
    const result = checkFundMovementConfirmation(
      { type: 'WITHDRAWAL', amount: 500 },
      'cancel',
      history
    );
    expect(result.allowed).toBe(false);
    expect(result.cancelled).toBe(true);
  });
});

describe('formatTradeProposal', () => {
  it('formats a trade proposal with all required fields', () => {
    const proposal = formatTradeProposal({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 10,
      unitPrice: 150,
      currency: 'USD'
    });
    expect(proposal).toContain('CONFIRMATION_REQUIRED');
    expect(proposal).toContain('BUY');
    expect(proposal).toContain('AAPL');
    expect(proposal).toContain('10');
    expect(proposal).toContain('$150.00');
    expect(proposal).toContain('paper trade');
  });

  it('includes price citation when provided', () => {
    const proposal = formatTradeProposal(
      { symbol: 'MSFT', side: 'SELL', quantity: 5, unitPrice: 300 },
      { priceCitation: 'Yahoo Finance real-time' }
    );
    expect(proposal).toContain('Yahoo Finance real-time');
  });

  it('includes price warning when provided', () => {
    const proposal = formatTradeProposal(
      { symbol: 'BTC', side: 'BUY', quantity: 1, unitPrice: 50000 },
      { priceWarning: 'Price may be delayed by 15 minutes' }
    );
    expect(proposal).toContain('Price may be delayed');
  });
});

describe('formatFundMovementProposal', () => {
  it('formats a deposit proposal', () => {
    const proposal = formatFundMovementProposal({
      type: 'DEPOSIT',
      amount: 5000,
      currency: 'USD'
    });
    expect(proposal).toContain('CONFIRMATION_REQUIRED');
    expect(proposal).toContain('DEPOSIT');
    expect(proposal).toContain('$5000.00');
    expect(proposal).toContain('Simulated');
  });

  it('formats a withdrawal proposal', () => {
    const proposal = formatFundMovementProposal({
      type: 'WITHDRAWAL',
      amount: 2000
    });
    expect(proposal).toContain('WITHDRAW');
    expect(proposal).toContain('$2000.00');
  });
});
