import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from './auth';

/**
 * Shared-auth mode for embedded Ghostfolio deployments.
 * Expects upstream Ghostfolio to forward:
 * - Authorization: Bearer <ghostfolio_jwt>
 * - x-ghostfolio-user-id: <ghostfolio_user_id>
 */
export async function requireGhostfolioSharedAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : '';
  const ghostfolioUserId = String(req.headers['x-ghostfolio-user-id'] ?? '').trim();

  if (!token) {
    res.status(401).json({
      error: 'Missing Authorization header (expected Ghostfolio JWT in shared-auth mode)'
    });
    return;
  }

  if (!ghostfolioUserId) {
    res.status(401).json({
      error: 'Missing x-ghostfolio-user-id header in shared-auth mode'
    });
    return;
  }

  req.userId = ghostfolioUserId;
  req.ghostfolioUserId = ghostfolioUserId;
  req.ghostfolioJwt = token;
  next();
}
