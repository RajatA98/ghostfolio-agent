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
import { PlaidService } from './services/plaid.service';

const app = express();
const agentService = new AgentService();
const ghostfolioUserService = new GhostfolioUserService();
const ghostfolioAuthService = new GhostfolioAuthService();

// Legacy in-memory JWT cache for non-Supabase mode (backward compat).
let cachedJwt: string = agentConfig.ghostfolioJwt;

async function exchangeAccessToken(accessToken: string): Promise<string> {
  const baseUrl = agentConfig.ghostfolioApiUrl.replace(/\/$/, '');
  const authUrl = `${baseUrl}/api/v1/auth/anonymous`;

  const authRes = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken })
  });

  if (!authRes.ok) {
    const text = await authRes.text();
    throw new Error(`Ghostfolio auth failed: ${authRes.status} ${text}`);
  }

  const data = (await authRes.json()) as { authToken?: string };
  const authToken = typeof data?.authToken === 'string' ? data.authToken : '';
  if (!authToken) throw new Error('Ghostfolio did not return an auth token');
  return authToken;
}

app.use(
  cors({
    origin: agentConfig.corsOrigin
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, authenticated: !!cachedJwt });
});

app.get('/api/auth/status', (_req, res) => {
  res.json({ authenticated: !!cachedJwt });
});

// Exchange Ghostfolio access token or JWT — called from the UI when the server has no cached JWT.
// This is the legacy auth flow (non-Supabase). Kept for backward compatibility.
app.post('/api/auth/ghostfolio', async (req, res) => {
  try {
    const body = req.body as { accessToken?: string };
    const input = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';

    if (!input) {
      res.status(400).json({ error: 'accessToken is required' });
      return;
    }

    // If the input itself looks like a JWT, cache and return it directly.
    const isJwt = input.split('.').length === 3 && input.length > 50;
    if (isJwt) {
      cachedJwt = input;
      res.json({ authToken: input });
      return;
    }

    let authToken: string;
    try {
      authToken = await exchangeAccessToken(input);
    } catch (fetchError) {
      const err = fetchError instanceof Error ? fetchError.message : String(fetchError);
      const reachable = err.includes('fetch failed') || err.includes('ECONNREFUSED');
      res.status(503).json({
        error: reachable
          ? `Cannot reach Ghostfolio at ${agentConfig.ghostfolioApiUrl}. Is it running? Check GHOSTFOLIO_API_URL in .env.`
          : err
      });
      return;
    }

    cachedJwt = authToken;
    res.json({ authToken });
  } catch (error) {
    res.status(500).json({
      error: `Auth request failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    // Support both Supabase auth (per-user JWT) and legacy mode (cachedJwt)
    const authReq = req as AuthenticatedRequest;
    let jwt: string;
    let userId: string;

    if (authReq.userId) {
      // Supabase-authenticated: provision Ghostfolio account and get per-user JWT
      userId = authReq.userId;
      try {
        jwt = await ghostfolioUserService.ensureProvisioned(userId);
      } catch {
        // Fallback to cached JWT if provisioning fails
        jwt = cachedJwt;
      }
    } else {
      // Legacy mode: use Authorization header or cached JWT
      const authHeader = req.headers.authorization ?? '';
      const jwtFromHeader = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : '';
      jwt = jwtFromHeader || cachedJwt;
      userId = 'unknown';
    }

    if (!jwt) {
      res.status(401).json({
        error:
          'Not authenticated. Set GHOSTFOLIO_ACCESS_TOKEN or GHOSTFOLIO_JWT in .env, or connect via the UI.'
      });
      return;
    }

    const body = req.body as AgentChatRequest;
    if (!body?.message || typeof body.message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const response = await agentService.chat(body, {
      userId: body.userId ?? userId,
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

  app.post('/api/plaid/link-token', async (req, res) => {
    try {
      const authHeader = req.headers.authorization ?? '';
      const jwt = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : cachedJwt;
      if (!jwt) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }
      const userId = (req.body as { userId?: string })?.userId ?? 'default';
      const result = await plaidService.createLinkToken(userId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post('/api/plaid/exchange-token', async (req, res) => {
    try {
      const authHeader = req.headers.authorization ?? '';
      const jwt = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : cachedJwt;
      if (!jwt) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }
      const body = req.body as {
        publicToken: string;
        institutionId?: string;
        institutionName?: string;
        userId?: string;
      };
      if (!body?.publicToken) {
        res.status(400).json({ error: 'publicToken is required' });
        return;
      }
      await plaidService.exchangePublicToken(
        body.userId ?? 'default',
        body.publicToken,
        body.institutionId,
        body.institutionName
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get('/api/plaid/holdings', async (req, res) => {
    try {
      const authHeader = req.headers.authorization ?? '';
      const jwt = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : cachedJwt;
      if (!jwt) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }
      const userId = (req.query.userId as string) ?? 'default';
      const result = await plaidService.getInvestmentHoldings(userId);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });
}

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

async function start(): Promise<void> {
  // Auto-exchange GHOSTFOLIO_ACCESS_TOKEN for JWT at startup if GHOSTFOLIO_JWT is not set.
  if (!cachedJwt && agentConfig.ghostfolioAccessToken) {
    try {
      // eslint-disable-next-line no-console
      console.log('Exchanging GHOSTFOLIO_ACCESS_TOKEN for JWT…');
      cachedJwt = await exchangeAccessToken(agentConfig.ghostfolioAccessToken);
      // eslint-disable-next-line no-console
      console.log('Ghostfolio JWT obtained. UI auth step not required.');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`Could not auto-exchange access token: ${err instanceof Error ? err.message : err}`);
      // eslint-disable-next-line no-console
      console.warn('Users will need to connect manually in the UI.');
    }
  }

  app.listen(agentConfig.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Ghostfolio Agent listening on http://localhost:${agentConfig.port}`);
  });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start agent:', err);
  process.exit(1);
});
