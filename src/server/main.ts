import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { agentConfig } from './agent.config';
import { AgentService } from './agent.service';
import { AgentChatRequest, AgentStreamEvent } from './agent.types';
import { AuthenticatedRequest, requireAuth } from './middleware/auth';
import { requireGhostfolioSharedAuth } from './middleware/ghostfolio-shared-auth';
import { GhostfolioUserService } from './services/ghostfolio-user.service';
import { GhostfolioAuthService } from './services/ghostfolio-auth.service';

const app = express();
const agentService = new AgentService();
const ghostfolioUserService = new GhostfolioUserService();
const ghostfolioAuthService = new GhostfolioAuthService();

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

// --- All /api routes require auth ---
app.use(
  '/api',
  agentConfig.authMode === 'ghostfolio_shared'
    ? requireGhostfolioSharedAuth
    : requireAuth
);

// --- Auth routes ---
app.get('/api/auth/status', (req, res) => {
  const authReq = req as AuthenticatedRequest;
  res.json({ authenticated: true, userId: authReq.userId });
});

if (agentConfig.authMode !== 'ghostfolio_shared') {
  app.post('/api/auth/signup', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      await ghostfolioUserService.createGhostfolioAccount(authReq.userId!);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: `Signup provisioning failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  });
}

// --- Chat route ---
app.post('/api/chat', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId!;

    // Determine JWT source by auth mode.
    let jwt: string;
    if (authReq.ghostfolioJwt) {
      // Shared-auth mode: host Ghostfolio app forwards user JWT directly.
      jwt = authReq.ghostfolioJwt;
    } else if (authReq.devJwt) {
      // Dev mode: use the raw JWT passed directly in the Authorization header
      jwt = authReq.devJwt;
    } else {
      try {
        jwt = await ghostfolioAuthService.getJwt(userId);
      } catch {
        // If JWT fetch fails, try full provisioning
        try {
          jwt = await ghostfolioUserService.ensureProvisioned(userId);
        } catch (provisionError) {
          // Shared fallback is only allowed for explicit single-tenant mode.
          const allowSharedFallback =
            userId === 'dev-user' || agentConfig.singleTenantFallback;

          if (allowSharedFallback && agentConfig.ghostfolioJwt) {
            jwt = agentConfig.ghostfolioJwt;
          } else {
            const msg = provisionError instanceof Error ? provisionError.message : String(provisionError);
            if (!allowSharedFallback) {
              res.status(503).json({
                error:
                  'Agent request failed: Ghostfolio account could not be provisioned for this user. Configure GHOSTFOLIO_ADMIN_TOKEN and disable shared JWT fallback in multi-user mode.'
              });
              return;
            }
            if (msg.includes('GHOSTFOLIO_ADMIN_TOKEN') || msg.includes('required')) {
              res.status(503).json({
                error: 'Agent request failed: Ghostfolio is not configured (missing GHOSTFOLIO_ADMIN_TOKEN).'
              });
              return;
            }
            if (msg.includes('Ghostfolio auth failed') || msg.includes('Failed to create Ghostfolio user')) {
              res.status(503).json({
                error: 'Agent request failed: Cannot reach Ghostfolio. Check GHOSTFOLIO_API_URL is correct and the service is running.'
              });
              return;
            }
            throw provisionError;
          }
        }
      }
    }

    const body = req.body as AgentChatRequest;
    if (!body?.message || typeof body.message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const response = await agentService.chat(body, {
      userId,
      baseCurrency: body.baseCurrency ?? 'USD',
      language: body.language ?? 'en',
      jwt
    });

    res.json(response);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isNetwork = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Load failed/i.test(msg);
    res.status(500).json({
      error: isNetwork
        ? 'Agent request failed: Cannot reach Ghostfolio. Check GHOSTFOLIO_API_URL and that the Ghostfolio instance is running.'
        : `Agent request failed: ${msg}`
    });
  }
});

// --- Streaming chat route (SSE) ---
app.post('/api/chat/stream', async (req, res) => {
  let sawDoneEvent = false;
  const sendEvent = (event: AgentStreamEvent): void => {
    if (event.type === 'done') {
      sawDoneEvent = true;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Flush immediately so the client receives each SSE event without buffering
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Disable Nagle's algorithm for immediate delivery
    res.socket?.setNoDelay?.(true);

    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId!;

    // Determine JWT source by auth mode.
    let jwt: string;
    if (authReq.ghostfolioJwt) {
      jwt = authReq.ghostfolioJwt;
    } else if (authReq.devJwt) {
      jwt = authReq.devJwt;
    } else {
      try {
        jwt = await ghostfolioAuthService.getJwt(userId);
      } catch {
        try {
          jwt = await ghostfolioUserService.ensureProvisioned(userId);
        } catch (provisionError) {
          const allowSharedFallback =
            userId === 'dev-user' || agentConfig.singleTenantFallback;

          if (allowSharedFallback && agentConfig.ghostfolioJwt) {
            jwt = agentConfig.ghostfolioJwt;
          } else {
            const msg = provisionError instanceof Error ? provisionError.message : String(provisionError);
            if (!allowSharedFallback) {
              sendEvent({
                type: 'error',
                message:
                  'Agent request failed: Ghostfolio account could not be provisioned for this user. Configure GHOSTFOLIO_ADMIN_TOKEN and disable shared JWT fallback in multi-user mode.'
              });
              res.end();
              return;
            }
            if (msg.includes('GHOSTFOLIO_ADMIN_TOKEN') || msg.includes('required')) {
              sendEvent({
                type: 'error',
                message: 'Agent request failed: Ghostfolio is not configured (missing GHOSTFOLIO_ADMIN_TOKEN).'
              });
              res.end();
              return;
            }
            if (msg.includes('Ghostfolio auth failed') || msg.includes('Failed to create Ghostfolio user')) {
              sendEvent({
                type: 'error',
                message: 'Agent request failed: Cannot reach Ghostfolio. Check GHOSTFOLIO_API_URL is correct and the service is running.'
              });
              res.end();
              return;
            }
            throw provisionError;
          }
        }
      }
    }

    const body = req.body as AgentChatRequest;
    if (!body?.message || typeof body.message !== 'string') {
      sendEvent({ type: 'error', message: 'message is required' });
      res.end();
      return;
    }

    const response = await agentService.chat(
      body,
      {
        userId,
        baseCurrency: body.baseCurrency ?? 'USD',
        language: body.language ?? 'en',
        jwt
      },
      sendEvent
    );

    // Safety: if no done event was emitted (unexpected path), emit one now.
    if (!sawDoneEvent) {
      sendEvent({
        type: 'done',
        answer: response.answer,
        confidence: response.confidence,
        warnings: response.warnings,
        toolTrace: response.toolTrace,
        loopMeta: response.loopMeta
      });
    }
    res.end();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isNetwork = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Load failed/i.test(msg);
    sendEvent({
      type: 'error',
      message: isNetwork
        ? 'Agent request failed: Cannot reach Ghostfolio. Check GHOSTFOLIO_API_URL and that the Ghostfolio instance is running.'
        : `Agent request failed: ${msg}`
    });
    res.end();
  }
});

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
app.listen(agentConfig.port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Ghostfolio Agent listening on 0.0.0.0:${agentConfig.port}`);
});

// Catch unhandled errors so Railway logs show them
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
