import { Snaptrade } from 'snaptrade-typescript-sdk';
import { agentConfig } from '../agent.config';
import { BrokerageService } from '../agent.types';
import { encryptForUser, decryptWithFallback } from '../lib/encrypt';
import { getPrisma } from '../lib/prisma';

export class SnapTradeService implements BrokerageService {
  private client: Snaptrade;

  constructor() {
    this.client = new Snaptrade({
      clientId: agentConfig.snaptradeClientId,
      consumerKey: agentConfig.snaptradeConsumerKey
    });
  }

  /**
   * Register user with SnapTrade (idempotent).
   * If already registered, returns existing credentials from DB.
   */
  async registerUser(
    userId: string,
    supabaseUserId: string
  ): Promise<{ snaptradeUserId: string; userSecret: string }> {
    const prisma = getPrisma();

    // Check if already registered
    const existing = await prisma.brokerageConnection.findFirst({
      where: { userId }
    });

    if (existing) {
      const { plaintext, wasLegacy } = decryptWithFallback(
        existing.userSecretEncrypted,
        supabaseUserId
      );

      // Lazy re-encrypt with per-user key if it was legacy
      if (wasLegacy) {
        await prisma.brokerageConnection.update({
          where: { id: existing.id },
          data: { userSecretEncrypted: encryptForUser(plaintext, supabaseUserId) }
        });
      }

      return {
        snaptradeUserId: existing.snaptradeUserId,
        userSecret: plaintext
      };
    }

    // Register with SnapTrade — use our internal userId as the SnapTrade userId
    let snaptradeUserId: string;
    let userSecret: string;

    try {
      const response = await this.client.authentication.registerSnapTradeUser({
        userId
      });
      snaptradeUserId = response.data.userId ?? userId;
      userSecret = response.data.userSecret ?? '';
    } catch (regError: unknown) {
      // Personal keys only allow 1 user — if already registered under a different
      // userId, reuse the existing one by resetting the user secret.
      const body = (regError as { responseBody?: { code?: string } })?.responseBody;
      if (body?.code === '1012') {
        // List existing users and reuse
        const listRes = await this.client.authentication.listSnapTradeUsers();
        const existingUsers = listRes.data ?? [];
        if (existingUsers.length === 0) throw regError;

        snaptradeUserId = existingUsers[0] as string;
        // Reset user secret to get a new one
        const resetRes = await this.client.authentication.resetSnapTradeUserSecret({
          userId: snaptradeUserId,
          userSecret: '' // not needed for reset
        });
        userSecret = (resetRes.data as { userSecret?: string })?.userSecret ?? '';
        if (!userSecret) throw new Error('Failed to reset SnapTrade user secret');
      } else {
        throw regError;
      }
    }

    // Store encrypted with per-user key
    await prisma.brokerageConnection.create({
      data: {
        userId,
        snaptradeUserId,
        userSecretEncrypted: encryptForUser(userSecret, supabaseUserId)
      }
    });

    return { snaptradeUserId, userSecret };
  }

  /**
   * Get SnapTrade Connection Portal URL for user to link their brokerage.
   */
  async getConnectUrl(userId: string, supabaseUserId: string, callbackUrl?: string): Promise<{ redirectURI: string }> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const response = await this.client.authentication.loginSnapTradeUser({
      userId: snaptradeUserId,
      userSecret,
      ...(callbackUrl ? { customRedirect: callbackUrl } : {})
    });

    const data = response.data as { redirectURI?: string };
    if (!data.redirectURI) {
      throw new Error('Failed to get SnapTrade connection portal URL');
    }

    return { redirectURI: data.redirectURI };
  }

  /**
   * List brokerage connections (authorizations) for a user.
   */
  async listConnections(
    userId: string,
    supabaseUserId: string
  ): Promise<Array<{ id: string; brokerageName: string }>> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const response = await this.client.connections.listBrokerageAuthorizations({
      userId: snaptradeUserId,
      userSecret
    });

    const connections = response.data ?? [];

    // Update institution names in DB
    const prisma = getPrisma();
    for (const conn of connections) {
      const name = conn.brokerage?.name;
      if (name) {
        await prisma.brokerageConnection.updateMany({
          where: { userId, snaptradeUserId },
          data: { institutionName: name }
        });
      }
    }

    return connections.map((c) => ({
      id: c.id ?? '',
      brokerageName: c.brokerage?.name ?? 'Unknown'
    }));
  }

  /**
   * List accounts across all connected brokerages.
   */
  async listAccounts(
    userId: string,
    supabaseUserId: string
  ): Promise<Array<{
    id: string;
    name: string;
    number: string;
    institutionName: string;
  }>> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const response = await this.client.accountInformation.listUserAccounts({
      userId: snaptradeUserId,
      userSecret
    });

    return (response.data ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? '',
      number: a.number,
      institutionName: a.institution_name
    }));
  }

  /**
   * Get holdings across all connected accounts.
   * Returns the same shape that PortfolioService expects.
   */
  async getHoldings(
    userId: string,
    supabaseUserId: string
  ): Promise<{
    holdings: Array<{
      symbol: string;
      name: string;
      quantity: number;
      costBasis: number | null;
      currentValue: number | null;
      currency: string;
      institutionName: string;
    }>;
  }> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    // Get all accounts first
    const accountsRes = await this.client.accountInformation.listUserAccounts({
      userId: snaptradeUserId,
      userSecret
    });

    const accounts = accountsRes.data ?? [];
    if (accounts.length === 0) {
      throw new Error(
        'No brokerage accounts found. Connect your brokerage first.'
      );
    }

    const allHoldings: Array<{
      symbol: string;
      name: string;
      quantity: number;
      costBasis: number | null;
      currentValue: number | null;
      currency: string;
      institutionName: string;
    }> = [];

    for (const account of accounts) {
      const holdingsRes = await this.client.accountInformation.getUserHoldings({
        accountId: account.id,
        userId: snaptradeUserId,
        userSecret
      });

      const positions = holdingsRes.data.positions ?? [];

      for (const pos of positions) {
        const units = pos.units ?? pos.fractional_units ?? 0;
        if (units <= 0) continue;

        const ticker = pos.symbol?.symbol?.symbol ?? 'UNKNOWN';
        const description = pos.symbol?.symbol?.description ?? ticker;
        const price = pos.price ?? null;
        const avgCost = pos.average_purchase_price ?? null;
        const currency = (pos.currency as { code?: string })?.code ?? 'USD';

        allHoldings.push({
          symbol: ticker,
          name: description,
          quantity: units,
          costBasis: avgCost != null ? avgCost * units : null,
          currentValue: price != null ? price * units : null,
          currency,
          institutionName: account.institution_name
        });
      }
    }

    return { holdings: allHoldings };
  }

  /**
   * Get decrypted SnapTrade credentials for a user.
   * Lazily re-encrypts with per-user key if legacy shared key was used.
   */
  private async getCredentials(
    userId: string,
    supabaseUserId: string
  ): Promise<{
    snaptradeUserId: string;
    userSecret: string;
  }> {
    const prisma = getPrisma();
    const conn = await prisma.brokerageConnection.findFirst({
      where: { userId }
    });

    if (!conn) {
      throw new Error(
        'No SnapTrade registration found. Please register first.'
      );
    }

    const { plaintext, wasLegacy } = decryptWithFallback(
      conn.userSecretEncrypted,
      supabaseUserId
    );

    // Lazy re-encrypt with per-user key
    if (wasLegacy) {
      await prisma.brokerageConnection.update({
        where: { id: conn.id },
        data: { userSecretEncrypted: encryptForUser(plaintext, supabaseUserId) }
      });
    }

    return {
      snaptradeUserId: conn.snaptradeUserId,
      userSecret: plaintext
    };
  }
}
