import Big from 'big.js';

import {
  AllocationChange,
  AllocationRow,
  SimulateAllocationResult,
  ValuationMethod
} from '../agent.types';
import { PortfolioService } from '../services/portfolio.service';
import { AgentToolDefinition, ToolContext, ToolExecutor } from './tool-registry';

export class SimulateAllocationChangeTool implements ToolExecutor {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'simulateAllocationChange',
    description:
      'Simulates hypothetical buy/sell changes to the portfolio and shows the resulting new allocation. This is a read-only simulation - no actual transactions are made. Use this to answer "what if I buy/sell X" questions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['buy', 'sell'],
                description: 'Whether to simulate buying or selling'
              },
              symbol: {
                type: 'string',
                description: 'Ticker symbol (e.g. "VTI", "AAPL")'
              },
              amount: {
                type: 'object',
                properties: {
                  currency: {
                    type: 'string',
                    description: 'Currency code (e.g. "USD")'
                  },
                  amount: {
                    type: 'number',
                    description: 'Dollar amount to buy or sell'
                  }
                },
                required: ['currency', 'amount']
              }
            },
            required: ['type', 'symbol', 'amount']
          },
          description: 'Array of hypothetical buy/sell changes to simulate'
        }
      },
      required: ['changes']
    }
  };

  constructor(private readonly portfolioService: PortfolioService) {}

  public async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<SimulateAllocationResult> {
    const changes = (input.changes as AllocationChange[]) ?? [];

    const snapshot = await this.portfolioService.getSnapshot(
      context.userId,
      context.baseCurrency,
      context.supabaseUserId
    );

    const notes: string[] = [];
    const valueMap = new Map<string, Big>();

    for (const h of snapshot.holdings) {
      if (h.quantity > 0 || (h.value?.amount ?? 0) > 0) {
        valueMap.set(
          h.symbol,
          new Big(h.value?.amount ?? h.costBasis?.amount ?? 0)
        );
      }
    }

    let originalTotal = new Big(0);
    for (const val of valueMap.values()) {
      originalTotal = originalTotal.plus(val);
    }

    let newTotal = new Big(originalTotal);

    for (const change of changes) {
      const changeAmount = new Big(change.amount.amount);
      const currentValue = valueMap.get(change.symbol) ?? new Big(0);

      if (change.type === 'buy') {
        valueMap.set(change.symbol, currentValue.plus(changeAmount));
        newTotal = newTotal.plus(changeAmount);
        notes.push(
          `Simulated buying ${change.amount.currency} ${change.amount.amount} of ${change.symbol}`
        );
      } else if (change.type === 'sell') {
        const newValue = currentValue.minus(changeAmount);

        if (newValue.lt(0)) {
          notes.push(
            `Warning: Selling ${change.amount.currency} ${change.amount.amount} of ${change.symbol} exceeds current value (${currentValue.toFixed(2)}). Clamped to 0.`
          );
          valueMap.set(change.symbol, new Big(0));
          newTotal = newTotal.minus(currentValue);
        } else {
          valueMap.set(change.symbol, newValue);
          newTotal = newTotal.minus(changeAmount);
        }
      }
    }

    const newAllocationBySymbol: AllocationRow[] = [];
    for (const [symbol, value] of valueMap.entries()) {
      if (value.gt(0)) {
        newAllocationBySymbol.push({
          key: symbol,
          value: {
            currency: context.baseCurrency,
            amount: value.toNumber()
          },
          percent: newTotal.gt(0)
            ? Math.round(value.div(newTotal).times(100).toNumber() * 100) / 100
            : 0
        });
      }
    }

    newAllocationBySymbol.sort((a, b) => b.percent - a.percent);

    const valuationMethod: ValuationMethod = snapshot.isPriceDataMissing
      ? 'cost_basis'
      : 'market';
    const now = new Date().toISOString().split('T')[0];

    return {
      accountId: 'snaptrade',
      timeframe: { start: '', end: now },
      valuationMethod,
      asOf: valuationMethod === 'market' ? now : null,
      originalTotalValue: {
        currency: context.baseCurrency,
        amount: originalTotal.toNumber()
      },
      newTotalValue: {
        currency: context.baseCurrency,
        amount: newTotal.toNumber()
      },
      newAllocationBySymbol,
      notes
    };
  }
}
