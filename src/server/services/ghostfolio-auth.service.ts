import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';
import { decrypt } from '../lib/encrypt';

/**
 * Manages per-user Ghostfolio JWTs.
 * Each user has their own Ghostfolio access token (stored encrypted in DB).
 * This service exchanges it for a JWT and caches it.
 */
export class GhostfolioAuthService {
  /**
   * Get a valid JWT for the given internal user ID.
   * Uses cached JWT if available, otherwise exchanges the stored access token.
   */
  async getJwt(userId: string): Promise<string> {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // If we have a cached JWT, return it
    if (user.ghostfolioJwt) {
      return user.ghostfolioJwt;
    }

    // Otherwise exchange the access token for a JWT
    if (!user.ghostfolioToken) {
      throw new Error('User has no Ghostfolio access token. Account may not be provisioned.');
    }

    const accessToken = decrypt(user.ghostfolioToken);
    const jwt = await this.exchangeAccessToken(accessToken);

    // Cache the JWT
    await prisma.user.update({
      where: { id: userId },
      data: { ghostfolioJwt: jwt }
    });

    return jwt;
  }

  /**
   * Exchange a Ghostfolio access token for a JWT.
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
   * Invalidate cached JWT so it gets refreshed on next call.
   */
  async invalidateJwt(userId: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.user.update({
      where: { id: userId },
      data: { ghostfolioJwt: null }
    });
  }
}
