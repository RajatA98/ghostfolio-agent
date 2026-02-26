# CLAUDE.md — Ghostfolio Agent

## Golden Set Eval Rules

When generating, running, or fixing evals, follow these rules exactly.

---

### Golden Set Structure

Every case MUST have all 6 fields. Never omit any.

```yaml
- id: "gs-tool-001"
  query: "user question here"
  expected_tools:
    - getPortfolioSnapshot
  expected_sources:
    - getPortfolioSnapshot
  must_contain:
    - "key fact"
    - "another fact"
  must_not_contain:
    - "I don't know"
    - "no information"
```

---

### The 4 Check Types

Every tool must have all 4 types covered across its golden cases.

**1. Tool Selection** — Did the agent call the right tool?
```
expected_tools: [getPortfolioSnapshot]
```

**2. Source Citation** — Did the agent successfully get data from the right tool?
```
expected_sources: [getPortfolioSnapshot]
```

**3. Content Validation** — Does the response contain the expected facts?
```
must_contain: ["allocation", "$500"]
```

**4. Negative Validation** — Does the response avoid hallucination or giving up?
```
must_not_contain: ["I don't know", "no information", "guaranteed"]
```

---

### Size and Cadence

- 10–20 cases per tool — quality beats quantity
- At least 2–3 cases per tool at minimum
- Include at least 1 ambiguous case per tool (non-obvious tool choice)
- Include at least 1 edge case per tool (out-of-scope or empty result)
- Must run in under 5 minutes total
- Run on EVERY commit — treat like unit tests

---

### File Locations (this project)

```
src/server/evals/
  golden_sets/
    {tool_name}.eval.yaml     ← one file per tool
  scenario_sets/
    edge_cases.eval.yaml
    adversarial.eval.yaml
    multi_step.eval.yaml
  run-evals.ts                ← TypeScript runner (not Python)
  golden-set.yaml             ← legacy, prefer golden_sets/
```

**Run commands:**
```bash
npm run evals:golden      # runs golden_sets/
npm run evals:scenarios   # runs scenario_sets/
npm run evals:all         # runs everything
```

---

### Evaluator Requirements

When writing or modifying `run-evals.ts`:

- Support `--verbose` flag (show full response on failure)
- Support `--id gs-001` flag (run a single case)
- Print for every failure: case ID + which assertion failed + actual output
- Print summary: X/Y passed (Z%)
- Exit with code 1 if ANY case fails (makes CI pipelines work)
- Never catch and swallow assertion errors silently

---

### Hard Rules

- **NEVER** change expected output just to make a failing test pass
- **NEVER** use vague checks ("response is helpful", "answer is good")
- **NEVER** use token count as a quality proxy
- **ALWAYS** add a new golden case when a production bug is found
- **ALL** checks must be deterministic and binary — no LLM judge in golden sets
