import Big from 'big.js';

import { AllocationRow, MarketPricesResult, PaperTradeResult, PortfolioSnapshotResult } from './agent.types';

const PRICE_DRIFT_THRESHOLD_PERCENT = 2.0;

const ALLOCATION_SUM_TOLERANCE = 1.0;

const FORBIDDEN_ADVICE_PATTERNS = [
  /you should (buy|sell|invest in|divest from)/i,
  /I recommend (buying|selling|investing|purchasing)/i,
  /you must (buy|sell|invest)/i,
  /guaranteed (returns?|profits?|gains?)/i,
  /I (advise|suggest) (you )?(buy|sell|purchase)/i,
  /allocate exactly/i
];

// ─── Tone Compliance ─────────────────────────────────────────────────
// Detects if the LLM's response has slipped into unprofessional language.

const SLANG_PATTERNS = [
  /\bbruh\b/i,
  /\bgonna\b/i,
  /\bwanna\b/i,
  /\bgotta\b/i,
  /\bfam\b(?!il)/i,
  /\bngl\b/i,
  /\btbh\b/i,
  /\blmao\b/i,
  /\blol\b/i,
  /\brofl\b/i,
  /\bimho\b/i,
  /\bno\s+cap\b/i,
  /\bsus\b(?!pect|tain|pend|pens)/i,
  /\bvibes?\b/i,
  /\bdope\b/i,
  /\bbased\b(?!\s+(on|upon|in))/i,
];

const ROLEPLAY_PATTERNS = [
  /\barrr+\b/i,
  /\bahoy\b/i,
  /\bmatey?\b/i,
  /\bshiver me timbers\b/i,
  /\baye\s+aye\b/i,
  /\bme hearties?\b/i,
  /(?<!\*)\*(?!\*)[^*]+\*(?!\*)/,
  /\bdude\b/i,
  /\bbro\b(?!ker|wser|ad|nz|wn)/i,
];

const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;
const EMOJI_THRESHOLD = 3;

/**
 * Functional status symbols used in professional/analytical content (e.g. portfolio health
 * check, pass/fail lists). These are NOT decorative emojis and should not trigger
 * excessive_emoji. Includes: ✓ ✗ ✔ ❌ ✘ ⨯
 */
const STATUS_INDICATOR_REGEX = /[\u{2713}\u{2714}\u{2717}\u{274C}\u{274E}\u{2A2F}]/gu;

const SARCASM_PATTERNS = [
  /\bsuuure+\b/i,
  /\byeaah+\b/i,
  /\briiiight\b/i,
  /\bwhatever\b/i,
  /\b(haha|hehe|lmfao)\b/i,
  /\bsure,?\s+buddy\b/i,
  /\bnice\s+try\b/i,
];

const PROFANITY_PATTERNS = [
  /\bdamn\b/i,
  /\bwtf\b/i,
  /\bstfu\b/i,
  /\bsh[i!1]t\b/i,
  /\bf[u*@#]ck/i,
  /\bass\b(?!et|ess|ign|um|oc|ist|ay)/i,
];

interface ToneViolation {
  category: string;
  match: string;
}

export function checkToneCompliance(answer: string): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;
  const violations: ToneViolation[] = [];

  for (const pattern of SLANG_PATTERNS) {
    const match = answer.match(pattern);
    if (match) {
      violations.push({ category: 'slang', match: match[0] });
    }
  }

  for (const pattern of ROLEPLAY_PATTERNS) {
    const match = answer.match(pattern);
    if (match) {
      violations.push({ category: 'roleplay', match: match[0] });
    }
  }

  const emojiMatches = answer.match(EMOJI_REGEX) ?? [];
  const statusIndicatorMatches = answer.match(STATUS_INDICATOR_REGEX) ?? [];
  // Exclude functional status symbols (✓ ✗ ✔ ❌) from emoji count — they're used
  // in professional contexts (e.g. "✗ Diversification: No holdings") not as decor
  const decorativeEmojiCount = Math.max(0, emojiMatches.length - statusIndicatorMatches.length);
  if (decorativeEmojiCount >= EMOJI_THRESHOLD) {
    violations.push({
      category: 'excessive_emoji',
      match: `${decorativeEmojiCount} decorative emojis detected`
    });
  }

  for (const pattern of SARCASM_PATTERNS) {
    const match = answer.match(pattern);
    if (match) {
      violations.push({ category: 'sarcasm', match: match[0] });
    }
  }

  for (const pattern of PROFANITY_PATTERNS) {
    const match = answer.match(pattern);
    if (match) {
      violations.push({ category: 'profanity', match: match[0] });
    }
  }

  if (violations.length > 0) {
    const categories = [...new Set(violations.map((v) => v.category))];
    warnings.push(
      `Response contains unprofessional tone indicators (${categories.join(', ')}). ` +
      `The agent should maintain a professional, analytical tone at all times.`
    );

    if (violations.length === 1) {
      confidenceAdjustment = 0.15;
    } else if (violations.length <= 3) {
      confidenceAdjustment = 0.25;
    } else {
      confidenceAdjustment = 0.35;
    }
  }

  return { warnings, confidenceAdjustment };
}

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
  confidenceCeiling?: number;
  attributions?: SourceAttribution[];
  metrics?: {
    factMismatchCount: number;
    unverifiedClaimCount: number;
    warningCount: number;
  };
}

export interface TradePriceVerification {
  symbol: string;
  proposedPrice: number;
  marketPrice: number | null;
  source: string | null;
  asOf: string | null;
  priceDriftPercent: number | null;
  isVerified: boolean;
  warning: string | null;
  /** Ready-to-embed citation, e.g. "source: Yahoo Finance, as of 2026-02-27" */
  citationText: string | null;
}

/**
 * Verifies that a proposed trade price matches the live market data fetched
 * during the current agent turn. Returns a citation string when verified and
 * a warning when the price cannot be confirmed or has drifted > 2%.
 */
export function verifyTradePrice({
  symbol,
  proposedPrice,
  toolResults
}: {
  symbol: string;
  proposedPrice: number;
  toolResults: Map<string, unknown>;
}): TradePriceVerification {
  const marketPrices = toolResults.get('getMarketPrices') as MarketPricesResult | undefined;

  if (!marketPrices?.rows?.length) {
    return {
      symbol,
      proposedPrice,
      marketPrice: null,
      source: null,
      asOf: null,
      priceDriftPercent: null,
      isVerified: false,
      warning: `No market price data was fetched for ${symbol}. The price $${proposedPrice.toFixed(2)}/share is unverified — it may not reflect current market conditions.`,
      citationText: null
    };
  }

  const row = marketPrices.rows.find(
    (r) => r.symbol.toUpperCase() === symbol.toUpperCase()
  );

  if (!row || row.price.amount <= 0) {
    return {
      symbol,
      proposedPrice,
      marketPrice: null,
      source: null,
      asOf: null,
      priceDriftPercent: null,
      isVerified: false,
      warning: `${symbol} was not found in market price data. Price $${proposedPrice.toFixed(2)}/share is unverified.`,
      citationText: null
    };
  }

  const marketPrice = row.price.amount;
  const driftPercent = Math.abs((proposedPrice - marketPrice) / marketPrice) * 100;
  const citationText = `source: ${row.source}, as of ${row.asOf}`;

  if (driftPercent > PRICE_DRIFT_THRESHOLD_PERCENT) {
    return {
      symbol,
      proposedPrice,
      marketPrice,
      source: row.source,
      asOf: row.asOf,
      priceDriftPercent: driftPercent,
      isVerified: false,
      warning: `Trade price $${proposedPrice.toFixed(2)}/share differs from ${row.source} live price $${marketPrice.toFixed(2)}/share by ${driftPercent.toFixed(1)}%. Using the verified market price below.`,
      citationText
    };
  }

  return {
    symbol,
    proposedPrice,
    marketPrice,
    source: row.source,
    asOf: row.asOf,
    priceDriftPercent: driftPercent,
    isVerified: true,
    warning: null,
    citationText
  };
}

export function verifyAgentResponse({
  answer,
  toolResults,
  userMessage,
  conversationHistory = []
}: {
  answer: string;
  toolResults: Map<string, unknown>;
  userMessage?: string;
  conversationHistory?: { role: string; content: string }[];
}): VerificationResult {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;

  // Existing: advice boundary check
  const adviceResult = checkAdviceBoundary(answer);
  warnings.push(...adviceResult.warnings);
  confidenceAdjustment += adviceResult.confidenceAdjustment;

  // Tone compliance check — affects confidence only; do NOT surface to user.
  // The guardrail should prevent tone change via pre-request blocking, not post-hoc warnings.
  const toneResult = checkToneCompliance(answer);
  confidenceAdjustment += toneResult.confidenceAdjustment;

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

  const userInputText = [userMessage, ...conversationHistory.map((m) => m.content)].filter(Boolean).join(' ');
  const attrResult = checkSourceAttribution({ answer, toolResults, userInputText });
  warnings.push(...attrResult.warnings);

  const factResult = checkFactConsistency({ answer, toolResults, userInputText });
  warnings.push(...factResult.warnings);
  confidenceAdjustment += factResult.confidenceAdjustment;

  // Confidence ceiling — cap score for severe issues
  const hasToneViolation = toneResult.warnings?.length > 0 || toneResult.confidenceAdjustment > 0;
  const hasSevereIssue =
    factResult.factMismatchCount > 0 ||
    attrResult.unverifiedClaimCount >= 2 ||
    hasToneViolation;
  const confidenceCeiling = hasSevereIssue
    ? 0.75
    : warnings.length > 0
      ? 0.9
      : 1.0;

  return {
    warnings,
    confidenceAdjustment,
    confidenceCeiling,
    attributions: attrResult.attributions,
    metrics: {
      factMismatchCount: factResult.factMismatchCount,
      unverifiedClaimCount: attrResult.unverifiedClaimCount,
      warningCount: warnings.length
    }
  };
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

/**
 * Checks whether a dollar amount can be explained as price × integer_quantity
 * using prices returned by the getMarketPrices tool, OR matches the total of
 * a logged paper trade (quantity × unitPrice). This prevents false-positive
 * hallucination warnings for LLM-computed totals that derive from real data.
 */
function isComputedFromToolResults(
  amount: number,
  toolResults: Map<string, unknown>
): { verified: boolean; source: string } {
  // Check price × integer_quantity for any symbol in getMarketPrices
  const marketPrices = toolResults.get('getMarketPrices') as MarketPricesResult | undefined;
  if (marketPrices?.rows) {
    for (const row of marketPrices.rows) {
      const price = row.price.amount;
      if (price <= 0) continue;
      const impliedQty = amount / price;
      // Valid if implied quantity is a plausible integer (fractional shares allowed up to 0.001 lots)
      if (
        impliedQty >= 0.001 &&
        impliedQty <= 1_000_000 &&
        Math.abs(impliedQty - Math.round(impliedQty)) < 0.02
      ) {
        return {
          verified: true,
          source: `getMarketPrices (${row.symbol} × ${Math.round(impliedQty)} @ ${row.source})`
        };
      }
    }
  }

  // Check if amount matches the total of an executed trade
  const tradeResult = toolResults.get('logPaperTrade') as PaperTradeResult | undefined;
  if (tradeResult && tradeResult.quantity > 0 && tradeResult.unitPrice > 0) {
    const tradeTotal = tradeResult.quantity * tradeResult.unitPrice;
    if (Math.abs(tradeTotal - amount) < 0.02) {
      return { verified: true, source: 'logPaperTrade (quantity × unitPrice)' };
    }
  }

  return { verified: false, source: '' };
}

function checkSourceAttribution({
  answer,
  toolResults,
  userInputText = ''
}: {
  answer: string;
  toolResults: Map<string, unknown>;
  userInputText?: string;
}): { attributions: SourceAttribution[]; warnings: string[]; unverifiedClaimCount: number } {
  const attributions: SourceAttribution[] = [];
  const warnings: string[] = [];

  if (toolResults.size === 0) {
    return { attributions, warnings, unverifiedClaimCount: 0 };
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

    // 1. Check for literal appearance in any tool result
    for (const [toolName, resultStr] of resultStrings) {
      if (
        resultStr.includes(String(amount)) ||
        resultStr.includes(amount.toFixed(2))
      ) {
        found = true;
        source = toolName;
        break;
      }
    }

    if (!found) {
      const arithmetic = isComputedFromToolResults(amount, toolResults);
      if (arithmetic.verified) {
        found = true;
        source = arithmetic.source;
      }
    }

    if (!found && userInputText) {
      if (
        userInputText.includes(String(amount)) ||
        userInputText.includes(amount.toFixed(2)) ||
        userInputText.includes(claim)
      ) {
        found = true;
        source = 'user input';
      }
    }

    attributions.push({ claim, source, verified: found });
  }

  // Only warn if there are a manageable number of genuinely unverified claims
  const unverified = attributions.filter((a) => !a.verified);
  const unverifiedClaimCount = unverified.length;
  if (unverifiedClaimCount > 0 && unverifiedClaimCount <= 5) {
    for (const attr of unverified) {
      warnings.push(
        `Numeric claim "${attr.claim}" could not be traced to any tool result — possible hallucination.`
      );
    }
  }

  return { attributions, warnings, unverifiedClaimCount };
}

// ─── Fact Consistency ────────────────────────────────────────────────
// Cross-validates key numeric assertions against tool results.

function checkFactConsistency({
  answer,
  toolResults,
  userInputText = ''
}: {
  answer: string;
  toolResults: Map<string, unknown>;
  userInputText?: string;
}): { warnings: string[]; confidenceAdjustment: number; factMismatchCount: number } {
  const warnings: string[] = [];
  let confidenceAdjustment = 0;
  let factMismatchCount = 0;

  const snapshot = toolResults.get('getPortfolioSnapshot') as
    | PortfolioSnapshotResult
    | undefined;

  if (!snapshot?.totalValue) {
    return { warnings, confidenceAdjustment, factMismatchCount };
  }

  const totalValueMatch = answer.match(
    /total\s+(?:portfolio\s+)?value[^$]*\$([\d,]+(?:\.\d{1,2})?)/i
  );
  if (totalValueMatch) {
    const claimed = Number(totalValueMatch[1].replace(/,/g, ''));
    const actual = snapshot.totalValue.amount;
    const tolerance = Math.max(actual * 0.02, 1);

    const claimedInUserInput =
      userInputText &&
      (userInputText.includes(String(claimed)) ||
        userInputText.includes(claimed.toFixed(2)) ||
        userInputText.includes(claimed.toLocaleString()));

    if (claimedInUserInput) {
      return { warnings, confidenceAdjustment, factMismatchCount };
    }

    if (Math.abs(claimed - actual) > tolerance) {
      warnings.push(
        `Total value claim $${claimed.toFixed(2)} differs from tool result $${actual.toFixed(2)} by more than 2%.`
      );
      confidenceAdjustment += 0.15;
      factMismatchCount++;
    }
  }

  return { warnings, confidenceAdjustment, factMismatchCount };
}

export function computeConfidence({
  hasErrors: _hasErrors,
  isPriceDataMissing,
  toolsSucceeded,
  toolsFailed,
  hasHoldings: _hasHoldings,
  terminationReason
}: {
  hasErrors: boolean;
  isPriceDataMissing: boolean;
  toolsSucceeded: number;
  toolsFailed: number;
  hasHoldings: boolean;
  terminationReason?: string;
}): number {
  const totalTools = toolsSucceeded + toolsFailed;

  // No tools called — chat-only response (greeting, clarification, etc.)
  if (totalTools === 0) return 0.8;

  // Trade/fund movement blocked — confirmation pending, not a failure
  if (terminationReason === 'trade_blocked') return 0.3;

  // All tools failed — API is down or auth broken
  if (toolsSucceeded === 0) return 0.15;

  // Start at 1.0 — at least some tools succeeded
  let score = 1.0;

  // Deduct proportionally for partial tool failures
  if (toolsFailed > 0) {
    const failureRatio = toolsFailed / totalTools;
    score -= failureRatio * 0.3;
  }

  // Deduct for degraded data quality (cost basis fallback)
  if (isPriceDataMissing) score -= 0.1;

  return score;
}
