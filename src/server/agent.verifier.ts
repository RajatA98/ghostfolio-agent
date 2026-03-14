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

export interface SourceAttribution {
  claim: string;
  source: string;
  verified: boolean;
}

export interface VerificationResult {
  warnings: string[];
  confidenceAdjustment: number;
  attributions?: SourceAttribution[];
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

  // Existing: advice boundary check
  const adviceResult = checkAdviceBoundary(answer);
  warnings.push(...adviceResult.warnings);
  confidenceAdjustment += adviceResult.confidenceAdjustment;

  const snapshotResult = toolResults.get('getPortfolioSnapshot') as
    | PortfolioSnapshotResult
    | undefined;

  // Existing: allocation sum check
  if (snapshotResult?.allocationBySymbol) {
    const allocationResult = checkAllocationSum(snapshotResult.allocationBySymbol);
    warnings.push(...allocationResult.warnings);
    confidenceAdjustment += allocationResult.confidenceAdjustment;
  }

  // Existing: valuation label check
  if (snapshotResult?.isPriceDataMissing) {
    const valuationResult = checkValuationLabel(answer);
    warnings.push(...valuationResult.warnings);
    confidenceAdjustment += valuationResult.confidenceAdjustment;
  }

  // NEW: Source attribution — verify numeric claims trace to tool results
  const attrResult = checkSourceAttribution({ answer, toolResults });
  warnings.push(...attrResult.warnings);

  // NEW: Fact consistency — cross-validate key numeric claims
  const factResult = checkFactConsistency({ answer, toolResults });
  warnings.push(...factResult.warnings);
  confidenceAdjustment += factResult.confidenceAdjustment;

  return { warnings, confidenceAdjustment, attributions: attrResult.attributions };
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

// ─── Source Attribution ──────────────────────────────────────────────
// Verifies that numeric claims in the response can be traced to tool results.

function checkSourceAttribution({
  answer,
  toolResults
}: {
  answer: string;
  toolResults: Map<string, unknown>;
}): { attributions: SourceAttribution[]; warnings: string[] } {
  const attributions: SourceAttribution[] = [];
  const warnings: string[] = [];

  if (toolResults.size === 0) {
    return { attributions, warnings };
  }

  // Extract dollar claims from the answer (e.g., "$10,000", "$1,855.00")
  const dollarPattern = /\$[\d,]+(?:\.\d{1,2})?/g;
  const dollarClaims = answer.match(dollarPattern) ?? [];

  // Build a single stringified version of all tool results for lookup
  const resultStrings = new Map<string, string>();
  for (const [toolName, result] of toolResults) {
    resultStrings.set(toolName, JSON.stringify(result));
  }

  for (const claim of dollarClaims) {
    const amount = Number(claim.replace(/[$,]/g, ''));
    if (!Number.isFinite(amount) || amount === 0) continue;

    let found = false;
    let source = '';

    for (const [toolName, resultStr] of resultStrings) {
      // Check multiple representations: 1793.76, 1793.8, 1794
      if (
        resultStr.includes(String(amount)) ||
        resultStr.includes(amount.toFixed(2)) ||
        resultStr.includes(amount.toFixed(1)) ||
        resultStr.includes(String(Math.round(amount)))
      ) {
        found = true;
        source = toolName;
        break;
      }

      // Also check if the amount is a computed sum (e.g. totalValue) that
      // could be derived from individual holdings — allow ±2% tolerance
      // for rounding differences in computed totals
      const numericPattern = /[\d.]+/g;
      let numMatch: RegExpExecArray | null;
      while ((numMatch = numericPattern.exec(resultStr)) !== null) {
        const toolVal = Number(numMatch[0]);
        if (toolVal > 0 && Math.abs(toolVal - amount) / Math.max(toolVal, 1) < 0.02) {
          found = true;
          source = toolName;
          break;
        }
      }
      if (found) break;
    }

    attributions.push({ claim, source, verified: found });
  }

  // Only warn if there are a manageable number of unverified claims
  const unverified = attributions.filter((a) => !a.verified);
  if (unverified.length > 0 && unverified.length <= 5) {
    for (const attr of unverified) {
      warnings.push(
        `Numeric claim "${attr.claim}" could not be traced to any tool result — possible hallucination.`
      );
    }
  }

  return { attributions, warnings };
}

// ─── Fact Consistency ────────────────────────────────────────────────
// Cross-validates key numeric assertions against tool results.

function checkFactConsistency({
  answer,
  toolResults
}: {
  answer: string;
  toolResults: Map<string, unknown>;
}): { warnings: string[]; confidenceAdjustment: number } {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  const snapshot = toolResults.get('getPortfolioSnapshot') as
    | PortfolioSnapshotResult
    | undefined;

  if (!snapshot?.totalValue) {
    return { warnings, confidenceAdjustment };
  }

  // Check if the response claims a total value that differs significantly
  const totalValueMatch = answer.match(
    /total\s+(?:portfolio\s+)?value[^$]*\$([\d,]+(?:\.\d{1,2})?)/i
  );
  if (totalValueMatch) {
    const claimed = Number(totalValueMatch[1].replace(/,/g, ''));
    const actual = snapshot.totalValue.amount;
    const tolerance = Math.max(actual * 0.02, 1); // 2% or $1 minimum
    if (Math.abs(claimed - actual) > tolerance) {
      warnings.push(
        `Total value claim $${claimed.toFixed(2)} differs from tool result $${actual.toFixed(2)} by more than 2%.`
      );
      confidenceAdjustment += 0.15;
    }
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
