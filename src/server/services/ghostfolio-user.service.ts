import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';
import { encrypt } from '../lib/encrypt';
import { GhostfolioAuthService } from './ghostfolio-auth.service';

/**
 * Creates and provisions Ghostfolio accounts for new users.
 * Each user gets their own Ghostfolio account (invisible to them).
 */
export class GhostfolioUserService {
  private readonly authService: GhostfolioAuthService;

  constructor(authService?: GhostfolioAuthService) {
    this.authService = authService ?? new GhostfolioAuthService();
  }

  /**
   * Public API: create a Ghostfolio account for the user.
   * Idempotent — if already provisioned, just returns the JWT.
   */
  async createGhostfolioAccount(userId: string): Promise<string> {
    return this.ensureProvisioned(userId);
  }

  /**
   * Ensure the user has a fully provisioned Ghostfolio account.
   * If the user's ghostfolioSecurityToken is empty, create a new Ghostfolio user.
   * Returns the user's JWT.
   */
  async ensureProvisioned(userId: string): Promise<string> {
    const prisma = getPrisma();
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }

    // Already provisioned — just get JWT
    if (user.ghostfolioSecurityToken) {
      return this.authService.getJwt(userId);
    }

    // Create a new Ghostfolio user via admin API
    const { accessToken, accountId } = await this.createGhostfolioUser();

    // Store encrypted security token + account ID
    await prisma.user.update({
      where: { id: userId },
      data: {
        ghostfolioSecurityToken: encrypt(accessToken),
        ghostfolioAccountId: accountId
      }
    });

    // Exchange for JWT and cache it with expiry
    const jwt = await this.authService.exchangeAccessToken(accessToken);
    await prisma.user.update({
      where: { id: userId },
      data: {
        ghostfolioJwt: jwt,
        ghostfolioJwtExpiresAt: new Date(Date.now() + 6 * 30 * 24 * 60 * 60 * 1000)
      }
    });

    return jwt;
  }

  /**
   * Create a new anonymous user in Ghostfolio via the admin API.
   * Returns the new user's access token and account ID.
   */
  private async createGhostfolioUser(): Promise<{ accessToken: string; accountId: string }> {
    const baseUrl = (agentConfig.ghostfolioInternalUrl || agentConfig.ghostfolioApiUrl).replace(/\/$/, '');
    const adminToken = agentConfig.ghostfolioAdminToken;

    if (!adminToken) {
      throw new Error('GHOSTFOLIO_ADMIN_TOKEN is required to create user accounts');
    }

    // Get admin JWT
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
    if (!newUser.accessToken || !newUser.id) {
      throw new Error('Ghostfolio admin API did not return expected fields (accessToken, id)');
    }

    return { accessToken: newUser.accessToken, accountId: newUser.id };
  }
}
