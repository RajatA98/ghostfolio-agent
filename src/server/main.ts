import 'dotenv/config';

import cors from 'cors';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { agentConfig } from './agent.config';
import { AgentService } from './agent.service';
import { AgentChatRequest } from './agent.types';
import { AuthenticatedRequest, requireAuth } from './middleware/auth';
import { GhostfolioUserService } from './services/ghostfolio-user.service';
import { GhostfolioAuthService } from './services/ghostfolio-auth.service';
import { GhostfolioPortfolioService } from './services/ghostfolio-portfolio.service';
import { PlaidService } from './services/plaid.service';
import { SyncService } from './services/sync.service';

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

// --- All /api routes require Supabase auth ---
app.use('/api', requireAuth);

// --- Auth routes ---
app.get('/api/auth/status', (req, res) => {
  const authReq = req as AuthenticatedRequest;
  res.json({ authenticated: true, userId: authReq.userId });
});

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

// --- Chat route ---
app.post('/api/chat', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.userId!;

    // Get per-user Ghostfolio JWT
    let jwt: string;
    if (authReq.devJwt) {
      // Dev mode: use the raw JWT passed directly in the Authorization header
      jwt = authReq.devJwt;
    } else {
      try {
        jwt = await ghostfolioAuthService.getJwt(userId);
      } catch {
        // If JWT fetch fails, try full provisioning
        jwt = await ghostfolioUserService.ensureProvisioned(userId);
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
    res.status(500).json({
      error: `Agent request failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    });
  }
});

// --- Plaid routes (conditionally available) ---
if (agentConfig.enablePlaid) {
  const plaidService = new PlaidService();
  const portfolioService = new GhostfolioPortfolioService(ghostfolioAuthService);
  const syncService = new SyncService(plaidService, portfolioService);

  app.post('/api/plaid/link-token', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await plaidService.createLinkToken(authReq.userId!);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post('/api/plaid/exchange-token', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const body = req.body as {
        publicToken: string;
        institutionId?: string;
        institutionName?: string;
      };
      if (!body?.publicToken) {
        res.status(400).json({ error: 'publicToken is required' });
        return;
      }
      const result = await plaidService.exchangePublicToken(
        authReq.userId!,
        body.publicToken,
        body.institutionId,
        body.institutionName
      );
      res.json({ success: true, itemId: result.itemId });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/api/plaid/holdings', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const result = await plaidService.getHoldings(authReq.userId!);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post('/api/plaid/sync', async (req, res) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const body = req.body as { itemId: string };
      if (!body?.itemId) {
        res.status(400).json({ error: 'itemId is required' });
        return;
      }
      const result = await syncService.syncHoldingsToGhostfolio(authReq.userId!, body.itemId);
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
  console.log(`Ghostfolio Agent listening on http://localhost:${agentConfig.port}`);
});
