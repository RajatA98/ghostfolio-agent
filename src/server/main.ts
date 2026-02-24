import 'dotenv/config';

import cors from 'cors';
import express from 'express';

import { agentConfig } from './agent.config';
import { AgentService } from './agent.service';
import { AgentChatRequest } from './agent.types';

const app = express();
const agentService = new AgentService();

app.use(
  cors({
    origin: agentConfig.corsOrigin
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  try {
    const authHeader = req.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : '';

    if (!jwt) {
      res.status(401).json({ error: 'Missing Authorization Bearer token' });
      return;
    }

    const body = req.body as AgentChatRequest;
    if (!body?.message || typeof body.message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const response = await agentService.chat(body, {
      userId: body.userId ?? 'unknown',
      baseCurrency: body.baseCurrency ?? 'USD',
      language: body.language ?? 'en',
      jwt
    });

    res.json(response);
  } catch (error) {
    res.status(500).json({
      error: `Agent request failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    });
  }
});

app.listen(agentConfig.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Ghostfolio Agent listening on http://localhost:${agentConfig.port}`);
});
