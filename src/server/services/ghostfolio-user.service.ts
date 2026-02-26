import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';
import { encrypt } from '../lib/encrypt';
import { GhostfolioAuthService } from './ghostfolio-auth.service';

/**
 * Creates and provisions Ghostfolio accounts for new users.
 * Each user gets their own Ghostfolio account (invisible to them).
 */
export class GhostfolioUserService {
  private readonly authService = new GhostfolioAuthService();

  /**
   * Ensure the user has a fully provisioned Ghostfolio account.
   * If the user's ghostfolioToken is empty, create a new Ghostfolio user.
   * Returns the user's JWT.
   */
  async ensureProvisioned(userId: string): Promise<string> {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // Already provisioned — just get JWT
    if (user.ghostfolioToken) {
      return this.authService.getJwt(userId);
    }

    // Create a new Ghostfolio user via admin API
    const accessToken = await this.createGhostfolioUser();

    // Store encrypted access token
    await prisma.user.update({
      where: { id: userId },
      data: { ghostfolioToken: encrypt(accessToken) }
    });

    // Exchange for JWT and cache it
    const jwt = await this.authService.exchangeAccessToken(accessToken);
    await prisma.user.update({
      where: { id: userId },
      data: { ghostfolioJwt: jwt }
    });

    return jwt;
  }

  /**
   * Create a new anonymous user in Ghostfolio via the admin API.
   * Returns the new user's access token.
   */
  private async createGhostfolioUser(): Promise<string> {
    const baseUrl = (agentConfig.ghostfolioInternalUrl || agentConfig.ghostfolioApiUrl).replace(/\/$/, '');
    const adminToken = agentConfig.ghostfolioAdminToken;

    if (!adminToken) {
      throw new Error('GHOSTFOLIO_ADMIN_TOKEN is required to create user accounts');
    }

    // First, get admin JWT
    const adminJwt = await this.authService.exchangeAccessToken(adminToken);

    // Create a new user via admin endpoint
    const createRes = await fetch(`${baseUrl}/api/v1/admin/user`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminJwt}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(`Failed to create Ghostfolio user: ${createRes.status} ${text}`);
    }

    const newUser = (await createRes.json()) as { accessToken?: string; id?: string };
    if (!newUser.accessToken) {
      throw new Error('Ghostfolio admin API did not return an access token for new user');
    }

    return newUser.accessToken;
  }
}
