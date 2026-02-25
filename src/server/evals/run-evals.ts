#!/usr/bin/env ts-node

import * as fs from 'node:fs';
import * as path from 'node:path';

interface EvalExpects {
  tools?: string[];
  mustMention?: string[];
  mustNotMention?: string[];
  allowedIfUnavailable?: boolean;
  ifUnavailableMustMention?: string[];
  confidenceMax?: number;
  [key: string]: unknown;
}

interface EvalCase {
  id: string;
  message: string;
  expects: EvalExpects;
  setup?: Record<string, unknown>;
}

interface ChatResponse {
  answer: string;
  toolTrace: { tool: string; ok: boolean }[];
  confidence?: number;
  data?: { valuationMethod?: string };
}

async function runCase(
  baseUrl: string,
  jwt: string,
  evalCase: EvalCase
): Promise<{ passed: boolean; reason?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`
    },
    body: JSON.stringify({ message: evalCase.message })
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      passed: false,
      reason: `HTTP ${res.status}: ${text.slice(0, 200)}`
    };
  }

  const data = (await res.json()) as ChatResponse;
  const { answer, toolTrace, confidence } = data;
  const expects = evalCase.expects;

  if (expects.tools && Array.isArray(expects.tools)) {
    const invoked = new Set(toolTrace.map((t) => t.tool));
    const missing = expects.tools.filter((t) => !invoked.has(t));
    if (missing.length > 0) {
      return {
        passed: false,
        reason: `Expected tools [${expects.tools.join(', ')}]; missing: ${missing.join(', ')}`
      };
    }
  }

  if (expects.mustMention && Array.isArray(expects.mustMention)) {
    const lower = answer.toLowerCase();
    const missing = expects.mustMention.filter(
      (phrase) => !lower.includes(phrase.toLowerCase())
    );
    if (missing.length > 0 && !expects.allowedIfUnavailable) {
      return {
        passed: false,
        reason: `Answer must mention: ${missing.join(', ')}`
      };
    }
    if (missing.length > 0 && expects.allowedIfUnavailable && expects.ifUnavailableMustMention) {
      const hasUnavailablePhrase = expects.ifUnavailableMustMention.some((p) =>
        lower.includes(p.toLowerCase())
      );
      if (!hasUnavailablePhrase) {
        return {
          passed: false,
          reason: `When data unavailable, answer should mention one of: ${expects.ifUnavailableMustMention.join(', ')}`
        };
      }
    }
  }

  if (expects.mustNotMention && Array.isArray(expects.mustNotMention)) {
    const lower = answer.toLowerCase();
    const found = expects.mustNotMention.filter((phrase) =>
      lower.includes(phrase.toLowerCase())
    );
    if (found.length > 0) {
      return {
        passed: false,
        reason: `Answer must not mention: ${found.join(', ')}`
      };
    }
  }

  if (
    typeof expects.confidenceMax === 'number' &&
    typeof confidence === 'number' &&
    confidence > expects.confidenceMax
  ) {
    return {
      passed: false,
      reason: `Expected confidence <= ${expects.confidenceMax}, got ${confidence}`
    };
  }

  return { passed: true };
}

async function runEvals(): Promise<void> {
  const evalsPath = path.join(__dirname, 'agent.evals.json');
  const evalCases: EvalCase[] = JSON.parse(
    fs.readFileSync(evalsPath, 'utf-8')
  );

  // eslint-disable-next-line no-console
  console.log(`Loaded ${evalCases.length} eval cases.`);

  const baseUrl = process.env.EVAL_BASE_URL;
  const jwt = process.env.EVAL_JWT || process.env.GHOSTFOLIO_JWT || '';

  if (!baseUrl) {
    // eslint-disable-next-line no-console
    console.log(
      'Set EVAL_BASE_URL (and optionally EVAL_JWT) to run integration evals against a live agent.'
    );
    // eslint-disable-next-line no-console
    console.log('Example: EVAL_BASE_URL=http://localhost:3334 EVAL_JWT=… npm run evals');
    return;
  }

  if (!jwt) {
    // eslint-disable-next-line no-console
    console.warn('No EVAL_JWT or GHOSTFOLIO_JWT set; requests may get 401.');
  }

  let passed = 0;
  let failed = 0;

  for (const evalCase of evalCases) {
    const result = await runCase(baseUrl, jwt, evalCase);
    if (result.passed) {
      passed++;
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${evalCase.id}`);
    } else {
      failed++;
      // eslint-disable-next-line no-console
      console.log(`  ✗ ${evalCase.id}: ${result.reason ?? 'unknown'}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\nEvals: ${passed} passed, ${failed} failed.`);

  if (failed > 0) {
    process.exit(1);
  }
}

runEvals().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
