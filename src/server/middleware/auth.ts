import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';

export interface AuthenticatedRequest extends Request {
  userId?: string; // internal Prisma User.id
  supabaseId?: string;
}

/**
 * Supabase auth middleware.
 * Expects `Authorization: Bearer <supabase_access_token>` header.
 * Validates the token, looks up or creates the internal User record,
 * and attaches `userId` + `supabaseId` to the request.
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

  try {
    const supabase = createClient(agentConfig.supabaseUrl, agentConfig.supabaseAnonKey);
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const supabaseId = data.user.id;
    const email = data.user.email ?? null;

    // Look up or create internal user record
    const prisma = getPrisma();
    let user = await prisma.user.findUnique({ where: { supabaseId } });

    if (!user) {
      // User will be fully provisioned (Ghostfolio account) on first chat
      // For now just create the DB row with placeholder token
      user = await prisma.user.create({
        data: {
          supabaseId,
          email,
          ghostfolioToken: '' // will be populated by GhostfolioUserService
        }
      });
    }

    req.userId = user.id;
    req.supabaseId = supabaseId;
    next();
  } catch (err) {
    res.status(500).json({
      error: `Auth failed: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}
