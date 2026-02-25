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
}

interface AllocationRow {
  key: string;
  percent: number;
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

// ─── Run a Single Case ──────────────────────────────────────────────

async function runCase(
  baseUrl: string,
  jwt: string,
  evalCase: EvalCase
): Promise<CaseResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({ message: evalCase.query })
  });

  if (!res.ok) {
    const text = await res.text();
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

  const passed = checks.every((c) => c.passed);
  const snippet =
    answer.length > 140 ? answer.slice(0, 140).trim() + '…' : answer.trim();
  const actual: ActualResponse = {
    tools: toolTrace.map((t) => t.tool),
    confidence,
    answerSnippet: snippet.replace(/\s+/g, ' ').replace(/"/g, "'")
  };
  return { id: evalCase.id, passed, checks, actual };
}

// ─── Main ───────────────────────────────────────────────────────────

type EvalSet = 'golden' | 'scenarios';

function parseEvalSetArg(): EvalSet {
  const setArg = process.argv.find((arg) => arg.startsWith('--set='));
  const setFromEquals = setArg?.split('=')[1];
  const setIndex = process.argv.indexOf('--set');
  const setFromNext = setIndex >= 0 ? process.argv[setIndex + 1] : undefined;
  const selected = (setFromEquals ?? setFromNext ?? 'golden').toLowerCase();
  return selected === 'scenarios' ? 'scenarios' : 'golden';
}

async function runEvalSet(): Promise<void> {
  const set = parseEvalSetArg();
  const isGolden = set === 'golden';
  const setPath = path.join(
    __dirname,
    isGolden ? 'golden-set.yaml' : 'scenario-set.yaml'
  );
  const raw = fs.readFileSync(setPath, 'utf-8');
  const cases = yaml.load(raw) as EvalCase[];
  const setLabel = isGolden ? 'Golden Set' : 'Scenario Set';

  console.log(`\n🏆 ${setLabel}: ${cases.length} cases loaded\n`);

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
    for (const c of cases) {
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

  for (const evalCase of cases) {
    const result = await runCase(baseUrl, jwt, evalCase);
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
    `${setLabel}: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ''}${failed} failed${RESET}${failed > 0 ? RESET : ''} out of ${cases.length}`
  );

  if (failures.length > 0) {
    console.log(`\n${RED}Failed cases:${RESET}`);
    for (const f of failures) {
      const failedChecks = f.checks.filter((c) => !c.passed);
      const types = Array.from(new Set(failedChecks.map((c) => c.check)));
      console.log(`  ${RED}❌ ${f.id}${RESET} — ${types.join(', ')}`);
    }
  }

  console.log('');

  if (isGolden && failed > 0) {
    process.exit(1);
  }
}

runEvalSet().catch((error) => {
  console.error(error);
  process.exit(1);
});
