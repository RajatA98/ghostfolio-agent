import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { agentConfig } from './agent.config';
import { AgentService, StreamEvent } from './agent.service';
import { AgentChatRequest } from './agent.types';
import { AuthenticatedRequest, requireAuth } from './middleware/auth';
import { SnapTradeService } from './services/snaptrade.service';

const app = express();
const agentService = new AgentService();

app.use(
  cors({
    origin: agentConfig.corsOrigin
  })
);
app.use(express.json({ limit: '1mb' }));

// --- Health check (no auth) ---
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// --- SnapTrade callback (no auth — loaded in popup after brokerage connect) ---
app.get('/snaptrade/callback', (_req, res) => {
  res.send(`<!DOCTYPE html><html><body>
<p>Brokerage connected! This window will close automatically.</p>
<script>
  if (window.opener) window.opener.postMessage('snaptrade-connected', '*');
  setTimeout(() => window.close(), 500);
</script>
</body></html>`);
});

// --- All /api routes require Supabase auth ---
app.use('/api', requireAuth);

// --- Auth routes ---
app.get('/api/auth/status', (req, res) => {
  const authReq = req as AuthenticatedRequest;
  res.json({ authenticated: true, userId: authReq.userId });
});

// --- Chat route ---
app.post('/api/chat', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId!;

    const body = req.body as AgentChatRequest;
    if (!body?.message || typeof body.message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const response = await agentService.chat(body, {
      userId,
      supabaseUserId: authReq.supabaseUserId,
      baseCurrency: body.baseCurrency ?? 'USD',
      language: body.language ?? 'en'
    });

    res.json(response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      error: `Agent request failed: ${msg}`
    });
  }
});

// --- Streaming chat route (SSE) ---
app.post('/api/chat/stream', async (req, res) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.userId!;

  const body = req.body as AgentChatRequest;
  if (!body?.message || typeof body.message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendSSE = (event: StreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const response = await agentService.chat(
      body,
      {
        userId,
        supabaseUserId: authReq.supabaseUserId,
        baseCurrency: body.baseCurrency ?? 'USD',
        language: body.language ?? 'en'
      },
      sendSSE
    );

    // Send final done event
    sendSSE({
      type: 'done',
      answer: response.answer,
      confidence: response.confidence,
      warnings: response.warnings,
      toolTrace: response.toolTrace,
      loopMeta: response.loopMeta
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendSSE({ type: 'error', message: msg });
  }

  res.end();
});

// --- SnapTrade routes (conditionally available) ---
if (agentConfig.enableSnapTrade) {
  const snapTradeService = new SnapTradeService();

  app.post('/api/snaptrade/register', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      console.log('[snaptrade/register] userId:', authReq.userId, 'supabaseUserId:', authReq.supabaseUserId);
      const result = await snapTradeService.registerUser(authReq.userId!, authReq.supabaseUserId!);
      res.json({ snaptradeUserId: result.snaptradeUserId });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      // Log full error for debugging
      console.error('[snaptrade/register] error:', error);
      // Try to extract SnapTrade API error body
      const apiBody = (error as { body?: unknown })?.body ?? (error as { response?: { data?: unknown } })?.response?.data;
      res.status(500).json({
        error: apiBody ? JSON.stringify(apiBody) : msg
      });
    }
  });

  app.get('/api/snaptrade/connect-url', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const protocol = req.headers['x-forwarded-proto'] ?? req.protocol;
      const host = req.headers['x-forwarded-host'] ?? req.get('host');
      const callbackUrl = `${protocol}://${host}/snaptrade/callback`;
      const result = await snapTradeService.getConnectUrl(authReq.userId!, authReq.supabaseUserId!, callbackUrl);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/api/snaptrade/connections', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const connections = await snapTradeService.listConnections(authReq.userId!, authReq.supabaseUserId!);
      res.json({ connections });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/api/snaptrade/accounts', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const accounts = await snapTradeService.listAccounts(authReq.userId!, authReq.supabaseUserId!);
      res.json({ accounts });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/api/snaptrade/holdings', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await snapTradeService.getHoldings(authReq.userId!, authReq.supabaseUserId!);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

// --- Serve built client ---
const clientDistPath = path.resolve(__dirname, '../client');
const clientIndexPath = path.join(clientDistPath, 'index.html');
const hasBuiltClient = existsSync(clientIndexPath);

if (hasBuiltClient) {
  app.use(express.static(clientDistPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/health') {
      next();
      return;
    }
    res.sendFile(clientIndexPath);
  });
}

// --- Start ---
app.listen(agentConfig.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Portfolio Analyzer listening on http://localhost:${agentConfig.port}`);
});

// Catch unhandled errors so Railway logs show them
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
