import Big from 'big.js';

import { AllocationRow, PortfolioSnapshotResult } from './agent.types';

const ALLOCATION_SUM_TOLERANCE = 1.0;

const FORBIDDEN_ADVICE_PATTERNS = [
  /you should (buy|sell|invest in|divest from)/i,
  /I recommend (buying|selling|investing|purchasing)/i,
  /you must (buy|sell|invest)/i,
  /guaranteed (returns?|profits?|gains?)/i,
  /I (advise|suggest) (you )?(buy|sell|purchase)/i,
  /allocate exactly/i
];

const VALUATION_KEYWORDS = [
  'cost basis',
  'cost-basis',
  'costbasis',
  "price data isn't available",
  'price data is not available',
  'market price data is missing',
  'based on cost'
];

export interface VerificationResult {
  warnings: string[];
  confidenceAdjustment: number;
}

export function verifyAgentResponse({
  answer,
  toolResults
}: {
  answer: string;
  toolResults: Map<string, unknown>;
}): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  const adviceResult = checkAdviceBoundary(answer);
  warnings.push(...adviceResult.warnings);
  confidenceAdjustment += adviceResult.confidenceAdjustment;

  const snapshotResult = toolResults.get('getPortfolioSnapshot') as
    | PortfolioSnapshotResult
    | undefined;

  if (snapshotResult?.allocationBySymbol) {
    const allocationResult = checkAllocationSum(snapshotResult.allocationBySymbol);
    warnings.push(...allocationResult.warnings);
    confidenceAdjustment += allocationResult.confidenceAdjustment;
  }

  if (snapshotResult?.isPriceDataMissing) {
    const valuationResult = checkValuationLabel(answer);
    warnings.push(...valuationResult.warnings);
    confidenceAdjustment += valuationResult.confidenceAdjustment;
  }

  return { warnings, confidenceAdjustment };
}

function checkAdviceBoundary(answer: string): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  for (const pattern of FORBIDDEN_ADVICE_PATTERNS) {
    if (pattern.test(answer)) {
      warnings.push(
        'Response may contain financial advice language. The agent should provide educational analysis only, not specific buy/sell recommendations.'
      );
      confidenceAdjustment += 0.2;
      break;
    }
  }

  return { warnings, confidenceAdjustment };
}

function checkAllocationSum(allocations: AllocationRow[]): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  if (allocations.length === 0) {
    return { warnings, confidenceAdjustment };
  }

  const sum = allocations.reduce((acc, row) => {
    return acc.plus(new Big(row.percent));
  }, new Big(0));

  const diff = sum.minus(100).abs().toNumber();

  if (diff > ALLOCATION_SUM_TOLERANCE) {
    warnings.push(
      `Allocation percentages sum to ${sum.toFixed(2)}%, which deviates from 100% by ${diff.toFixed(2)}%. This may indicate a calculation error.`
    );
    confidenceAdjustment += 0.1;
  }

  return { warnings, confidenceAdjustment };
}

function checkValuationLabel(answer: string): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  const mentionsCostBasis = VALUATION_KEYWORDS.some((keyword) =>
    answer.toLowerCase().includes(keyword.toLowerCase())
  );

  if (!mentionsCostBasis) {
    warnings.push(
      'Price data is missing for some holdings, but the response does not mention that values are based on cost basis. Users should be informed when market prices are unavailable.'
    );
    confidenceAdjustment += 0.1;
  }

  return { warnings, confidenceAdjustment };
}

export function computeConfidence({
  hasErrors,
  isPriceDataMissing,
  toolsSucceeded,
  toolsFailed,
  hasHoldings
}: {
  hasErrors: boolean;
  isPriceDataMissing: boolean;
  toolsSucceeded: number;
  toolsFailed: number;
  hasHoldings: boolean;
}): number {
  if (toolsFailed > 0 && toolsSucceeded === 0) {
    return 0.1;
  }

  if (!hasHoldings) {
    return 0.4;
  }

  if (toolsFailed > 0) {
    return 0.4;
  }

  if (isPriceDataMissing || hasErrors) {
    return 0.7;
  }

  return 1.0;
}
