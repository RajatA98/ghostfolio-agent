#!/usr/bin/env ts-node

import * as fs from 'node:fs';
import * as path from 'node:path';

interface EvalCase {
  id: string;
  message: string;
  expects: {
    tools?: string[];
    mustMention?: string[];
    mustNotMention?: string[];
  };
}

async function runEvals(): Promise<void> {
  const evalsPath = path.join(__dirname, 'agent.evals.json');
  const evalCases: EvalCase[] = JSON.parse(fs.readFileSync(evalsPath, 'utf-8'));

  // eslint-disable-next-line no-console
  console.log(`Loaded ${evalCases.length} eval cases.`);
  // eslint-disable-next-line no-console
  console.log(
    'Run your service and execute integration evals against POST /api/chat in your CI pipeline.'
  );
}

runEvals().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
