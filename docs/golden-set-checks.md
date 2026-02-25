# Golden Set — How It Works

Golden sets define what "correct" looks like. Small (10-20 cases). Fast to run. If these fail, something is fundamentally broken.

## Golden Set Criteria (All Met)

| Criterion | Meaning | How we guarantee it |
|-----------|---------|----------------------|
| **Deterministic** | Same agent response → same pass/fail every time | No `Date`, no `Math.random()`, no LLM in the evaluator. All checks are pure functions of the response (tool list, confidence, answer text, structured data). Text checks use normalized strings (whitespace collapsed, case-insensitive) so minor formatting changes don’t flip results. |
| **Binary** | Each check is pass or fail only | Every check returns `passed: true` or `passed: false`. A case passes iff all checks pass. No partial scores or thresholds. |
| **Code-only** | No human or LLM judge | Pass/fail is determined by code only. The evaluator never calls any LLM (Anthropic, OpenAI, etc.) to check responses. Only programmatic asserts: set membership (tools, succeeded tools), substring in/not in normalized text, numeric comparison (confidence, allocation sum). Zero LLM calls for evaluation → zero extra API cost. |
| **Four check types** | Tool selection, Source citation, Content validation, Negative validation | Each implemented as explicit checks in `run-evals.ts`; extended checks (e.g. allocation sum, confidence cap) use the same deterministic rules. |

## Format

Each case in `golden-set.yaml`:

```yaml
- id: "gs-001"
  query: "What's my portfolio allocation by symbol?"
  expected_tools:
    - getPortfolioSnapshot
  expected_sources:
    - getPortfolioSnapshot
  must_contain:
    - "allocation"
  must_not_contain:
    - "I don't know"
    - "no information"
```

## Four Types of Checks

| Check               | What it catches                  | How we check (deterministic)                    |
|---------------------|----------------------------------|-------------------------------------------------|
| Tool selection      | Agent used the wrong tool        | `assert "getPortfolioSnapshot" in actual_tools`  |
| Source citation     | Agent cited the wrong source     | `assert "getPerformance" called and succeeded`   |
| Content validation  | Response is missing key facts    | `assert "allocation" in response_text`           |
| Negative validation | Agent hallucinated or gave up    | `assert "I don't know" not in response_text`     |

These are **code evals** — deterministic, binary, no LLM needed. Zero API cost. Zero ambiguity.

## The Evaluator

```
# Tool selection
assert "getPortfolioSnapshot" in actual_tools     # ✓ or ✗

# Source citation
assert "getPerformance" called and succeeded       # ✓ or ✗

# Content validation
assert "2026-01-01" in response_text               # ✓ or ✗
assert "$500" in response_text                     # ✓ or ✗

# Negative validation
assert "I don't know" not in response_text         # ✓ or ✗
```

Each check returns ✓ or ✗. A case passes only if **all** checks pass.

## Extended Checks

Beyond the four core types, the evaluator supports:

- **`max_confidence`** — Agent must not be overconfident (e.g. empty portfolio → confidence ≤ 0.4)
- **`must_satisfy`** — Structural validators on response data (e.g. `allocationPercentsSumApprox100`)
- **`if_valuation_method`** — Conditional content checks based on `data.valuationMethod`
- **`allow_unavailable` + `if_unavailable_must_contain`** — When tools fail, agent must explain why

All extended checks are still deterministic — they compare response data to expected values.

## Case Categories (20 cases)

| Category            | Count | What they test                                          |
|---------------------|-------|---------------------------------------------------------|
| Happy path          | 8     | Allocation, performance, simulation, total value        |
| Edge cases          | 5     | Ambiguous timeframe, empty portfolio, cost basis, sums  |
| Adversarial/Safety  | 4     | Buy/sell advice, stock predictions, tax advice          |
| Multi-step          | 3     | Chained tool calls (allocation + simulation, etc.)      |

## Four Rules

1. **Start small** — 10-20 quality cases beats 100 sloppy ones
2. **Run on every commit** — These are your regression tests
3. **Add from production bugs** — Every bug becomes a test case
4. **Never** change expected output just to make tests pass

## Running

Set in `.env` (or pass on the CLI):

- `EVAL_BASE_URL` — agent API base (e.g. `http://localhost:3334`)
- `EVAL_JWT` — JWT for `/api/chat` (or use `GHOSTFOLIO_JWT` / `GHOSTFOLIO_ACCESS_TOKEN`)

Then:

```bash
# Dry run (loads cases, prints what would run) if EVAL_BASE_URL is unset
npm run evals

# Against a live agent (with EVAL_BASE_URL and JWT in .env)
npm run evals
```
