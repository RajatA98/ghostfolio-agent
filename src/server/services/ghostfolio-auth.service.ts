import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';
import { decrypt } from '../lib/encrypt';

/**
 * Manages per-user Ghostfolio JWTs.
 * Each user has their own Ghostfolio security token (stored encrypted in DB).
 * This service exchanges it for a JWT and caches it with a 6-month expiry.
 */
export class GhostfolioAuthService {
  private static readonly JWT_LIFETIME_MS = 6 * 30 * 24 * 60 * 60 * 1000; // ~6 months

  /**
   * Get a valid JWT for the given internal user ID.
   * Uses cached JWT if not expired, otherwise exchanges the stored security token.
   */
  async getJwt(userId: string): Promise<string> {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // Return cached JWT if still valid (expires > now)
    if (
      user.ghostfolioJwt &&
      user.ghostfolioJwtExpiresAt &&
      user.ghostfolioJwtExpiresAt > new Date()
    ) {
      return user.ghostfolioJwt;
    }

    // Otherwise exchange the security token for a fresh JWT
    if (!user.ghostfolioSecurityToken) {
      throw new Error('User has no Ghostfolio security token. Account may not be provisioned.');
    }

    const securityToken = decrypt(user.ghostfolioSecurityToken);
    const jwt = await this.exchangeAccessToken(securityToken);

    // Cache the JWT with 6-month expiry
    await prisma.user.update({
      where: { id: userId },
      data: {
        ghostfolioJwt: jwt,
        ghostfolioJwtExpiresAt: new Date(Date.now() + GhostfolioAuthService.JWT_LIFETIME_MS)
      }
    });

    return jwt;
  }

  /**
   * Exchange a Ghostfolio security/access token for a JWT.
   */
  async exchangeAccessToken(accessToken: string): Promise<string> {
    const baseUrl = (agentConfig.ghostfolioInternalUrl || agentConfig.ghostfolioApiUrl).replace(/\/$/, '');
    const authUrl = `${baseUrl}/api/v1/auth/anonymous`;

    const res = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken })
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ghostfolio auth failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { authToken?: string };
    if (!data.authToken) {
      throw new Error('Ghostfolio did not return an auth token');
    }
    return data.authToken;
  }

  /**
   * Fetch with automatic 401 retry — re-exchanges token on auth failure.
   */
  async authenticatedFetch(userId: string, url: string, init?: RequestInit): Promise<Response> {
    const jwt = await this.getJwt(userId);
    const headers = { ...((init?.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${jwt}` };

    const res = await fetch(url, { ...init, headers });

    if (res.status === 401) {
      // JWT expired server-side — invalidate and retry
      await this.invalidateJwt(userId);
      const newJwt = await this.getJwt(userId);
      const retryHeaders = { ...((init?.headers as Record<string, string>) ?? {}), Authorization: `Bearer ${newJwt}` };
      return fetch(url, { ...init, headers: retryHeaders });
    }

    return res;
  }

  /**
   * Invalidate cached JWT so it gets refreshed on next call.
   */
  async invalidateJwt(userId: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.user.update({
      where: { id: userId },
      data: { ghostfolioJwt: null, ghostfolioJwtExpiresAt: null }
    });
  }
}
