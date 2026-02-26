#!/usr/bin/env ts-node
/**
 * Golden Set Evaluator
 *
 * PASS/FAIL IS DETERMINED BY CODE ONLY — NO LLM.
 * This file never calls any LLM (Anthropic, OpenAI, etc.) to judge responses.
 * Pass/fail is computed only from: tool names, success flags, string includes,
 * and numeric comparisons. The agent (under test) may use an LLM; the evaluator does not.
 *
 * GOLDEN SET CRITERIA (all must hold):
 * 1. DETERMINISTIC — Same agent response → same pass/fail. No randomness, no Date, no LLM.
 * 2. BINARY — Each check returns only pass or fail. No partial credit or scoring.
 * 3. CODE-ONLY — All checks are programmatic: set membership, substring, numeric comparison. Zero LLM calls for evaluation (zero API cost for the eval logic).
 * 4. FOUR CHECK TYPES — Tool selection, Source citation, Content validation, Negative validation; each implemented as explicit asserts.
 *
 * Implemented guarantees:
 * - Tool selection: expected_tools ⊆ actual tool names (Set membership).
 * - Source citation: expected_sources ⊆ tools that succeeded (Set membership).
 * - Content/Negative: substring in normalized response text (whitespace collapsed, case-insensitive).
 * - Extended: confidence ≤ threshold, allocation sum within tolerance; all arithmetic on response data only.
 *
 * Loads .env from project root. Set EVAL_BASE_URL and JWT; run: npm run evals
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

// Load .env from project root so EVAL_BASE_URL and JWT are available
import { config } from 'dotenv';

// Do not add any LLM/AI SDK imports (e.g. @anthropic-ai/sdk, openai). Pass/fail must stay code-only.
const projectRoot = path.resolve(__dirname, '../../..');
config({ path: path.join(projectRoot, '.env') });

// Terminal colors for PASS / FAIL
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ─── Types ──────────────────────────────────────────────────────────

interface MarketModeOverrides {
  expected_tools?: string[];
  expected_sources?: string[];
  must_contain?: string[];
  must_not_contain?: string[];
}

interface EvalCase {
  id: string;
  query: string;
  setup?: Record<string, unknown>;

  expected_tools: string[];
  expected_sources: string[];

  must_contain: string[];
  must_not_contain: string[];

  max_confidence?: number;
  must_satisfy?: string[];
  allow_unavailable?: boolean;
  if_unavailable_must_contain?: string[];
  if_valuation_method?: Record<string, { must_contain?: string[] }>;

  // Conditional overrides based on AGENT_ENABLE_MARKET
  if_market_enabled?: MarketModeOverrides;
  if_market_disabled?: MarketModeOverrides;

  // Multi-turn conversation history (simulates prior turns)
  conversation_history?: { role: 'user' | 'assistant'; content: string }[];

  // Operational bounds (latency, cost, iterations)
  max_latency_ms?: number;
  max_cost_usd?: number;
  max_iterations?: number;

  // Labeled scenario metadata (ignored in checks, used for reporting)
  category?: string;
  subcategory?: string;
  difficulty?: string;
  tags?: string[];
}

interface AllocationRow {
  key: string;
  percent: number;
}

interface LoopMeta {
  iterations: number;
  totalMs: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  terminationReason: string;
}

interface AgentResponse {
  answer: string;
  toolTrace: { tool: string; ok: boolean; ms: number; error?: string | null }[];
  confidence: number;
  data?: {
    valuationMethod?: string;
    allocationBySymbol?: AllocationRow[];
    totalValue?: { currency: string; amount: number };
  };
  warnings?: string[];
  loopMeta?: LoopMeta;
}

interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
}

interface ActualResponse {
  tools: string[];
  confidence: number;
  answerSnippet: string;
}

interface CaseResult {
  id: string;
  passed: boolean;
  checks: CheckResult[];
  actual?: ActualResponse | null;
  loopMeta?: LoopMeta | null;
}

// ─── Pass/fail by code only (no LLM) ───────────────────────────────
// Every function below computes pass/fail from response data using only
// Set membership, string.includes, and numeric comparison. No AI/LLM is called.

function checkToolSelection(
  expected: string[],
  actual: { tool: string; ok: boolean }[]
): CheckResult[] {
  const results: CheckResult[] = [];
  const invokedSet = new Set(actual.map((t) => t.tool));

  for (const tool of expected) {
    const found = invokedSet.has(tool);
    results.push({
      check: 'tool_selection',
      passed: found,
      detail: found
        ? `✓ "${tool}" in actual_tools`
        : `✗ "${tool}" NOT in actual_tools`
    });
  }

  return results;
}

function checkSourceCitation(
  expectedSources: string[],
  toolTrace: { tool: string; ok: boolean }[]
): CheckResult[] {
  const results: CheckResult[] = [];
  const succeededTools = new Set(
    toolTrace.filter((t) => t.ok).map((t) => t.tool)
  );

  for (const source of expectedSources) {
    const grounded = succeededTools.has(source);
    results.push({
      check: 'source_citation',
      passed: grounded,
      detail: grounded
        ? `✓ "${source}" called and succeeded`
        : `✗ "${source}" not called or failed — answer may not be grounded`
    });
  }

  return results;
}

/** Normalize for deterministic substring checks: collapse whitespace, lowercase. Same logical text → same result. */
function normalizeForAssert(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function checkContentValidation(
  mustContain: string[],
  responseText: string
): CheckResult[] {
  const results: CheckResult[] = [];
  const normalized = normalizeForAssert(responseText);

  for (const phrase of mustContain) {
    const needle = normalizeForAssert(phrase);
    const found = needle.length === 0 || normalized.includes(needle);
    results.push({
      check: 'content_validation',
      passed: found,
      detail: found
        ? `✓ "${phrase}" in response_text`
        : `✗ "${phrase}" NOT in response_text`
    });
  }

  return results;
}

function checkNegativeValidation(
  mustNotContain: string[],
  responseText: string
): CheckResult[] {
  const results: CheckResult[] = [];
  const normalized = normalizeForAssert(responseText);

  for (const phrase of mustNotContain) {
    const needle = normalizeForAssert(phrase);
    const passed = needle.length === 0 || !normalized.includes(needle);
    results.push({
      check: 'negative_validation',
      passed,
      detail: passed
        ? `✓ "${phrase}" not in response_text`
        : `✗ "${phrase}" FOUND in response_text — possible hallucination`
    });
  }

  return results;
}

// ─── Structural Validators (mustSatisfy) ────────────────────────────

/** Fixed tolerance for allocation sum (deterministic: same data → same result). */
const ALLOCATION_SUM_TOLERANCE_PERCENT = 1.0;

function checkAllocationSum(data?: AgentResponse['data']): CheckResult {
  const rows = data?.allocationBySymbol ?? [];
  if (rows.length === 0) {
    return {
      check: 'content_validation',
      passed: true,
      detail: '✓ allocationPercentsSumApprox100 — no allocation rows (skipped)'
    };
  }
  const sum = rows.reduce((s, r) => s + r.percent, 0);
  const ok = Math.abs(sum - 100) <= ALLOCATION_SUM_TOLERANCE_PERCENT;
  return {
    check: 'content_validation',
    passed: ok,
    detail: ok
      ? `✓ allocation percents sum to ${sum.toFixed(2)}% (≈100 ±${ALLOCATION_SUM_TOLERANCE_PERCENT}%)`
      : `✗ allocation percents sum to ${sum.toFixed(2)}% — expected 100 ±${ALLOCATION_SUM_TOLERANCE_PERCENT}%`
  };
}

// ─── Operational Checks (latency, cost, iterations) ─────────────────

/** Approximate cost per token for Claude Sonnet. */
const COST_PER_INPUT_TOKEN = 3.0 / 1_000_000;   // $3/MTok
const COST_PER_OUTPUT_TOKEN = 15.0 / 1_000_000;  // $15/MTok

function checkLatency(maxMs: number, actualMs: number): CheckResult {
  const ok = actualMs <= maxMs;
  return {
    check: 'latency',
    passed: ok,
    detail: ok
      ? `✓ latency ${actualMs}ms <= ${maxMs}ms`
      : `✗ latency ${actualMs}ms > ${maxMs}ms — too slow`
  };
}

function checkCost(
  maxUsd: number,
  tokenUsage: { inputTokens: number; outputTokens: number }
): CheckResult {
  const cost =
    tokenUsage.inputTokens * COST_PER_INPUT_TOKEN +
    tokenUsage.outputTokens * COST_PER_OUTPUT_TOKEN;
  const ok = cost <= maxUsd;
  return {
    check: 'cost',
    passed: ok,
    detail: ok
      ? `✓ cost $${cost.toFixed(4)} <= $${maxUsd.toFixed(4)}`
      : `✗ cost $${cost.toFixed(4)} > $${maxUsd.toFixed(4)} — over budget`
  };
}

function checkIterationCount(maxIter: number, actualIter: number): CheckResult {
  const ok = actualIter <= maxIter;
  return {
    check: 'iterations',
    passed: ok,
    detail: ok
      ? `✓ iterations ${actualIter} <= ${maxIter}`
      : `✗ iterations ${actualIter} > ${maxIter} — loop ran too long`
  };
}

// ─── Market Mode Resolution ─────────────────────────────────────────

function resolveMarketMode(cases: EvalCase[]): EvalCase[] {
  const marketEnabled = process.env.AGENT_ENABLE_MARKET === 'true';
  const modeLabel = marketEnabled ? 'enabled' : 'disabled';
  console.log(`  Market mode: ${modeLabel} (AGENT_ENABLE_MARKET=${process.env.AGENT_ENABLE_MARKET ?? 'unset'})\n`);

  return cases.map((c) => {
    const overrides = marketEnabled ? c.if_market_enabled : c.if_market_disabled;
    if (!overrides) return c;

    return {
      ...c,
      expected_tools: overrides.expected_tools ?? c.expected_tools,
      expected_sources: overrides.expected_sources ?? c.expected_sources,
      must_contain: overrides.must_contain ?? c.must_contain,
      must_not_contain: overrides.must_not_contain ?? c.must_not_contain
    };
  });
}

// ─── Retry helpers ──────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5_000; // 5s, 10s, 20s exponential backoff

function isRetryableError(answer: string): boolean {
  return answer.includes('overloaded_error') || answer.includes('529');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Run a Single Case ──────────────────────────────────────────────

async function runCase(
  baseUrl: string,
  jwt: string,
  evalCase: EvalCase
): Promise<CaseResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`      ⏳ Retry ${attempt}/${MAX_RETRIES} for ${evalCase.id} after ${delayMs / 1000}s…`);
      await sleep(delayMs);
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`
      },
      body: JSON.stringify({
        message: evalCase.query,
        ...(evalCase.conversation_history?.length
          ? { conversationHistory: evalCase.conversation_history }
          : {})
      })
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 529 && attempt < MAX_RETRIES) continue;
      return {
        id: evalCase.id,
        passed: false,
        checks: [
          {
            check: 'http',
            passed: false,
            detail: `✗ HTTP ${res.status}: ${text.slice(0, 200)}`
          }
        ],
        actual: null
      };
    }

    const response = (await res.json()) as AgentResponse;

    // Retry if the agent caught a 529 from the upstream LLM API
    if (isRetryableError(response.answer) && attempt < MAX_RETRIES) continue;

    const { answer, toolTrace, confidence, data } = response;
    const checks: CheckResult[] = [];

    // 1. Tool selection
    checks.push(...checkToolSelection(evalCase.expected_tools, toolTrace));

    // 2. Source citation
    checks.push(...checkSourceCitation(evalCase.expected_sources, toolTrace));

    // 3. Content validation
    checks.push(...checkContentValidation(evalCase.must_contain, answer));

    // 4. Negative validation
    checks.push(...checkNegativeValidation(evalCase.must_not_contain, answer));

    // ─── Extended checks ─────────────────────────────────────────────

    // Confidence ceiling (e.g. empty portfolio should have low confidence)
    if (typeof evalCase.max_confidence === 'number') {
      const ok = confidence <= evalCase.max_confidence;
      checks.push({
        check: 'negative_validation',
        passed: ok,
        detail: ok
          ? `✓ confidence ${confidence} <= ${evalCase.max_confidence}`
          : `✗ confidence ${confidence} > ${evalCase.max_confidence} — agent too confident`
      });
    }

    // Structural validators (mustSatisfy)
    if (evalCase.must_satisfy?.length) {
      for (const name of evalCase.must_satisfy) {
        if (name === 'allocationPercentsSumApprox100') {
          checks.push(checkAllocationSum(data));
        }
      }
    }

    // Valuation method conditional (source citation refinement)
    if (evalCase.if_valuation_method && data?.valuationMethod) {
      const branch = evalCase.if_valuation_method[data.valuationMethod];
      if (branch?.must_contain?.length) {
        checks.push(
          ...checkContentValidation(branch.must_contain, answer).map((c) => ({
            ...c,
            check: 'source_citation' as const,
            detail: c.detail.replace('content_validation', `source_citation (valuationMethod=${data.valuationMethod})`)
          }))
        );
      }
    }

    // Unavailable data fallback (deterministic: same toolTrace + answer → same result)
    if (
      evalCase.allow_unavailable &&
      evalCase.if_unavailable_must_contain?.length
    ) {
      const toolsFailed = evalCase.expected_tools.some((t) => {
        const trace = toolTrace.find((tr) => tr.tool === t);
        return !trace || !trace.ok;
      });
      if (toolsFailed) {
        const normalizedAnswer = normalizeForAssert(answer);
        const hasPhrase = evalCase.if_unavailable_must_contain.some((p) =>
          normalizedAnswer.includes(normalizeForAssert(p))
        );
        checks.push({
          check: 'content_validation',
          passed: hasPhrase,
          detail: hasPhrase
            ? `✓ data unavailable and answer explains why`
            : `✗ data unavailable but answer doesn't mention: ${evalCase.if_unavailable_must_contain.join(', ')}`
        });
      }
    }

    // ─── Operational checks (latency, cost, iterations) ─────────────
    if (response.loopMeta) {
      if (typeof evalCase.max_latency_ms === 'number') {
        checks.push(checkLatency(evalCase.max_latency_ms, response.loopMeta.totalMs));
      }
      if (typeof evalCase.max_cost_usd === 'number') {
        checks.push(checkCost(evalCase.max_cost_usd, response.loopMeta.tokenUsage));
      }
      if (typeof evalCase.max_iterations === 'number') {
        checks.push(checkIterationCount(evalCase.max_iterations, response.loopMeta.iterations));
      }
    }

    const passed = checks.every((c) => c.passed);
    const snippet =
      answer.length > 140 ? answer.slice(0, 140).trim() + '…' : answer.trim();
    const actual: ActualResponse = {
      tools: toolTrace.map((t) => t.tool),
      confidence,
      answerSnippet: snippet.replace(/\s+/g, ' ').replace(/"/g, "'")
    };
    return { id: evalCase.id, passed, checks, actual, loopMeta: response.loopMeta ?? null };
  }

  // All retries exhausted — return failure
  return {
    id: evalCase.id,
    passed: false,
    checks: [
      {
        check: 'http',
        passed: false,
        detail: `✗ All ${MAX_RETRIES} retries exhausted (upstream LLM overloaded)`
      }
    ],
    actual: null
  };
}

// ─── File Loading Helpers ─────────────────────────────────────────

function loadYamlCases(filePath: string): EvalCase[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return (yaml.load(raw) as EvalCase[]) || [];
}

function loadCasesFromDir(dirPath: string): { cases: EvalCase[]; files: string[] } {
  if (!fs.existsSync(dirPath)) return { cases: [], files: [] };
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.eval.yaml')).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    cases.push(...loadYamlCases(path.join(dirPath, file)));
  }
  return { cases, files };
}

// ─── Per-Tool Reporting ──────────────────────────────────────────

interface ToolStats {
  passed: number;
  failed: number;
  total: number;
}

function printPerToolSummary(
  cases: EvalCase[],
  results: CaseResult[]
): void {
  const toolStats = new Map<string, ToolStats>();
  for (let i = 0; i < cases.length; i++) {
    const evalCase = cases[i];
    const result = results[i];
    for (const tool of evalCase.expected_tools) {
      if (!toolStats.has(tool)) {
        toolStats.set(tool, { passed: 0, failed: 0, total: 0 });
      }
      const stats = toolStats.get(tool)!;
      stats.total++;
      if (result.passed) stats.passed++;
      else stats.failed++;
    }
  }

  if (toolStats.size > 0) {
    console.log(`\n${DIM}Per-tool pass rate:${RESET}`);
    for (const [tool, stats] of Array.from(toolStats.entries()).sort()) {
      const rate = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(1) : '0.0';
      const color = stats.failed > 0 ? RED : GREEN;
      console.log(`  ${color}${tool}${RESET}: ${stats.passed}/${stats.total} (${rate}%)`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────

type EvalSet = 'golden' | 'scenarios' | 'all';

function parseEvalSetArg(): EvalSet {
  const setArg = process.argv.find((arg) => arg.startsWith('--set='));
  const setFromEquals = setArg?.split('=')[1];
  const setIndex = process.argv.indexOf('--set');
  const setFromNext = setIndex >= 0 ? process.argv[setIndex + 1] : undefined;
  const selected = (setFromEquals ?? setFromNext ?? 'golden').toLowerCase();
  if (selected === 'scenarios') return 'scenarios';
  if (selected === 'all') return 'all';
  return 'golden';
}

async function runEvalSet(): Promise<void> {
  const set = parseEvalSetArg();

  // Load cases based on set selection
  let goldenCases: EvalCase[] = [];
  let scenarioCases: EvalCase[] = [];

  if (set === 'golden' || set === 'all') {
    const goldenDir = path.join(__dirname, 'golden_sets');
    const { cases: dirCases } = loadCasesFromDir(goldenDir);
    goldenCases = dirCases;
  }

  if (set === 'scenarios' || set === 'all') {
    const scenarioDir = path.join(__dirname, 'scenario_sets');
    const { cases: dirCases } = loadCasesFromDir(scenarioDir);
    scenarioCases = dirCases;
  }

  const allCases = resolveMarketMode([...goldenCases, ...scenarioCases]);
  const setLabel =
    set === 'golden' ? 'Golden Set' :
    set === 'scenarios' ? 'Scenario Set' :
    'All Evals';

  console.log(`\n🏆 ${setLabel}: ${allCases.length} cases loaded`);
  if (set === 'all') {
    console.log(`   (${goldenCases.length} golden + ${scenarioCases.length} scenarios)`);
  }
  console.log('');

  const baseUrl = process.env.EVAL_BASE_URL;
  const jwt =
    process.env.EVAL_JWT ||
    process.env.GHOSTFOLIO_JWT ||
    process.env.GHOSTFOLIO_ACCESS_TOKEN ||
    '';

  if (!baseUrl) {
    console.log(
      `Set EVAL_BASE_URL (and optionally EVAL_JWT) to run ${setLabel.toLowerCase()} against a live agent.\n`
    );
    console.log(
      `Example: EVAL_BASE_URL=http://localhost:3334 EVAL_JWT=… npm run evals:${set}\n`
    );

    console.log('Cases that would run:');
    for (const c of allCases) {
      console.log(`  ${c.id}: "${c.query}"`);
    }
    return;
  }

  if (!jwt) {
    console.warn(
      '⚠  No EVAL_JWT or GHOSTFOLIO_JWT set; requests may get 401.\n'
    );
  }

  let passed = 0;
  let failed = 0;
  const failures: CaseResult[] = [];
  const allResults: CaseResult[] = [];

  for (const evalCase of allCases) {
    const result = await runCase(baseUrl, jwt, evalCase);
    allResults.push(result);
    const expectedParts: string[] = [];
    expectedParts.push(`tools: [${evalCase.expected_tools.join(', ')}]`);
    if (evalCase.must_contain.length) {
      expectedParts.push(`must contain: [${evalCase.must_contain.slice(0, 3).join(', ')}${evalCase.must_contain.length > 3 ? '…' : ''}]`);
    }
    if (evalCase.must_not_contain.length) {
      expectedParts.push(`must not: [${evalCase.must_not_contain.slice(0, 2).join(', ')}${evalCase.must_not_contain.length > 2 ? '…' : ''}]`);
    }
    const expectedSummary = expectedParts.join('; ');

    const actualLine =
      result.actual != null
        ? `tools: [${result.actual.tools.join(', ')}]; confidence: ${result.actual.confidence}; answer: "${result.actual.answerSnippet}"`
        : '—';

    if (result.passed) {
      passed++;
      console.log(`  ${GREEN}PASS ✅${RESET} ${result.id}`);
      console.log(`      ${DIM}Query: "${evalCase.query.slice(0, 60)}${evalCase.query.length > 60 ? '…' : ''}"${RESET}`);
      console.log(`      ${DIM}Expected: ${expectedSummary}${RESET}`);
      console.log(`      ${DIM}Actual: ${actualLine}${RESET}`);
    } else {
      failed++;
      failures.push(result);
      console.log(`  ${RED}FAIL ❌${RESET} ${result.id}`);
      console.log(`      ${DIM}Query: "${evalCase.query.slice(0, 60)}${evalCase.query.length > 60 ? '…' : ''}"${RESET}`);
      console.log(`      ${DIM}Expected: ${expectedSummary}${RESET}`);
      console.log(`      ${DIM}Actual: ${actualLine}${RESET}`);
      for (const check of result.checks.filter((c) => !c.passed)) {
        console.log(`      ${RED}${check.detail}${RESET}`);
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(50)}`);
  console.log(
    `${setLabel}: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}${failed > 0 ? RESET : ''} out of ${allCases.length}`
  );

  // Per-tool pass rate
  printPerToolSummary(allCases, allResults);

  // ─── Operational stats ──────────────────────────────────────────
  const withMeta = allResults.filter((r) => r.loopMeta);
  if (withMeta.length > 0) {
    const latencies = withMeta.map((r) => r.loopMeta!.totalMs);
    const costs = withMeta.map((r) => {
      const u = r.loopMeta!.tokenUsage;
      return u.inputTokens * COST_PER_INPUT_TOKEN + u.outputTokens * COST_PER_OUTPUT_TOKEN;
    });
    const iterations = withMeta.map((r) => r.loopMeta!.iterations);

    console.log(`\n${DIM}Operational stats:${RESET}`);
    console.log(`  Avg latency: ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`);
    console.log(`  Max latency: ${Math.max(...latencies)}ms`);
    console.log(`  Avg iterations: ${(iterations.reduce((a, b) => a + b, 0) / iterations.length).toFixed(1)}`);
    console.log(`  Total cost: $${costs.reduce((a, b) => a + b, 0).toFixed(4)}`);
    console.log(`  Avg cost/query: $${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(4)}`);
  }

  if (failures.length > 0) {
    console.log(`\n${RED}Failed cases:${RESET}`);
    for (const f of failures) {
      const failedChecks = f.checks.filter((c) => !c.passed);
      const types = Array.from(new Set(failedChecks.map((c) => c.check)));
      console.log(`  ${RED}❌ ${f.id}${RESET} — ${types.join(', ')}`);
    }
  }

  console.log('');

  // Exit 1 if golden set has failures (CI-friendly)
  const goldenFailCount = failures.filter((f) =>
    goldenCases.some((gc) => gc.id === f.id)
  ).length;
  if ((set === 'golden' || set === 'all') && goldenFailCount > 0) {
    process.exit(1);
  }
}

runEvalSet().catch((error) => {
  console.error(error);
  process.exit(1);
});
