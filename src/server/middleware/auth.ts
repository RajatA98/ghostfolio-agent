import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';

export interface AuthenticatedRequest extends Request {
  userId?: string; // internal Prisma User.id
  supabaseUserId?: string;
}

/**
 * Dev fallback: when Supabase is not configured, allow direct token auth
 * (for local development and evals).
 */
function isDevMode(): boolean {
  return !agentConfig.supabaseUrl || !agentConfig.supabaseAnonKey;
}

/**
 * Auth middleware.
 * - Production: Supabase auth (expects `Authorization: Bearer <supabase_access_token>`)
 * - Dev fallback: Direct token auth when Supabase is not configured
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';

  if (!token) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  // Dev fallback: skip Supabase, use token directly
  if (isDevMode()) {
    req.userId = 'dev-user';
    req.supabaseUserId = 'dev-user';
    next();
    return;
  }

  // Eval/dev bypass: if token matches EVAL_JWT, skip Supabase
  const evalJwt = process.env.EVAL_JWT || '';
  if (evalJwt && token === evalJwt) {
    req.userId = 'dev-user';
    req.supabaseUserId = 'dev-user';
    next();
    return;
  }

  try {
    const supabase = createClient(agentConfig.supabaseUrl, agentConfig.supabaseAnonKey);
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const supabaseUserId = data.user.id;
    const email = data.user.email ?? null;

    // Look up or create internal user record
    const prisma = getPrisma();
    let user = await prisma.user.findUnique({ where: { supabaseUserId } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          supabaseUserId,
          email
        }
      });
    }

    req.userId = user.id;
    req.supabaseUserId = supabaseUserId;
    next();
  } catch (err) {
    res.status(500).json({
      error: `Auth failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}
