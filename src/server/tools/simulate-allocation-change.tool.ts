import Big from 'big.js';

import {
  AllocationChange,
  AllocationRow,
  SimulateAllocationResult,
  ValuationMethod
} from '../agent.types';
import { ghostfolioGet } from './http';
import { BaseTool } from './base-tool';
import { AgentToolDefinition, ToolContext } from './tool-registry';

interface PortfolioPositionLike {
  symbol: string;
  quantity: number;
  investment?: number;
  marketPrice?: number;
  valueInBaseCurrency?: number;
}

interface PortfolioDetailsLike {
  holdings: Record<string, PortfolioPositionLike>;
}

const nowIso = (): string => new Date().toISOString().split('T')[0];

export class SimulateAllocationChangeTool extends BaseTool {
  public static readonly DEFINITION: AgentToolDefinition = {
    name: 'simulateAllocationChange',
    description:
      'Simulates one set of hypothetical buy/sell changes (read-only). Single responsibility. Idempotent and safe to retry. Returns structured allocation result; on failure sets reasonIfUnavailable and returns empty simulation.',
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

  protected async run(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<SimulateAllocationResult> {
    const changes = (input.changes as AllocationChange[]) ?? [];
    const now = nowIso();

    const details = await ghostfolioGet<PortfolioDetailsLike>({
      path: '/api/v1/portfolio/details?range=max',
      jwt: context.jwt
    });

    const positions = Object.values(details.holdings ?? {});
    const notes: string[] = [];

    const valueMap = new Map<string, Big>();
    for (const pos of positions) {
      if (pos.quantity > 0 || (pos.valueInBaseCurrency ?? 0) > 0) {
        valueMap.set(
          pos.symbol,
          new Big(pos.valueInBaseCurrency ?? pos.investment ?? 0)
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

    const isPriceDataMissing = positions.some(
      (pos) => pos.marketPrice === 0 || pos.marketPrice == null
    );
    const valuationMethod: ValuationMethod = isPriceDataMissing
      ? 'cost_basis'
      : 'market';

    return {
      accountId: 'default',
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

  protected onError(
    error: unknown,
    _input: Record<string, unknown>,
    context: ToolContext
  ): SimulateAllocationResult {
    const message = error instanceof Error ? error.message : String(error);
    const now = nowIso();
    return {
      accountId: 'default',
      timeframe: { start: '', end: now },
      valuationMethod: 'cost_basis',
      asOf: null,
      originalTotalValue: { currency: context.baseCurrency, amount: 0 },
      newTotalValue: { currency: context.baseCurrency, amount: 0 },
      newAllocationBySymbol: [],
      notes: [],
      reasonIfUnavailable: message
    };
  }
}
