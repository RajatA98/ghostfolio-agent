import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode
} from 'plaid';
import { agentConfig } from '../agent.config';
import { getPrisma } from '../lib/prisma';
import { encrypt, decrypt } from '../lib/encrypt';
import { GhostfolioAuthService } from './ghostfolio-auth.service';

export class PlaidService {
  private client: PlaidApi;

  constructor() {
    const config = new Configuration({
      basePath: PlaidEnvironments[agentConfig.plaidEnv as keyof typeof PlaidEnvironments],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': agentConfig.plaidClientId,
          'PLAID-SECRET': agentConfig.plaidSecret
        }
      }
    });
    this.client = new PlaidApi(config);
  }

  async createLinkToken(userId: string): Promise<{ linkToken: string; expiration: string }> {
    const response = await this.client.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Ghostfolio Agent',
      products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: 'en'
    });
    return {
      linkToken: response.data.link_token,
      expiration: response.data.expiration
    };
  }

  async exchangePublicToken(
    userId: string,
    publicToken: string,
    institutionId?: string,
    institutionName?: string
  ): Promise<{ itemId: string }> {
    const response = await this.client.itemPublicTokenExchange({
      public_token: publicToken
    });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    // Create a Ghostfolio brokerage account for this connection
    let ghostfolioAccountId: string | null = null;
    try {
      const authService = new GhostfolioAuthService();
      const jwt = await authService.getJwt(userId);
      const baseUrl = (agentConfig.ghostfolioInternalUrl || agentConfig.ghostfolioApiUrl).replace(/\/$/, '');
      const accountRes = await fetch(`${baseUrl}/api/v1/account`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: institutionName ?? 'Brokerage',
          currency: 'USD'
        })
      });
      if (accountRes.ok) {
        const data = (await accountRes.json()) as { id?: string };
        ghostfolioAccountId = data.id ?? null;
      }
    } catch {
      // Non-fatal — account creation in Ghostfolio failed, holdings can still be synced
    }

    const prisma = getPrisma();
    await prisma.plaidItem.upsert({
      where: { itemId },
      create: {
        userId,
        itemId,
        accessTokenEncrypted: encrypt(accessToken),
        institutionId: institutionId ?? null,
        institutionName: institutionName ?? null,
        ghostfolioAccountId
      },
      update: {
        accessTokenEncrypted: encrypt(accessToken),
        institutionId: institutionId ?? null,
        institutionName: institutionName ?? null,
        ghostfolioAccountId
      }
    });

    return { itemId };
  }

  async getHoldings(userId: string): Promise<{
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
    const prisma = getPrisma();
    const items = await prisma.plaidItem.findMany({
      where: { userId }
    });

    if (items.length === 0) {
      throw new Error(
        'No brokerage connections found. Use the Connect Brokerage tool first.'
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

    for (const item of items) {
      const accessToken = decrypt(item.accessTokenEncrypted);
      const response = await this.client.investmentsHoldingsGet({
        access_token: accessToken
      });

      const securities = new Map(
        response.data.securities.map((s) => [s.security_id, s])
      );

      for (const holding of response.data.holdings) {
        const security = securities.get(holding.security_id);
        allHoldings.push({
          symbol: security?.ticker_symbol ?? 'UNKNOWN',
          name: security?.name ?? 'Unknown Security',
          quantity: holding.quantity ?? 0,
          costBasis: holding.cost_basis ?? null,
          currentValue: holding.institution_value ?? null,
          currency: holding.iso_currency_code ?? 'USD',
          institutionName: item.institutionName ?? 'Unknown'
        });
      }
    }

    return { holdings: allHoldings };
  }

  async getTransactions(userId: string): Promise<{ transactions: unknown[] }> {
    const prisma = getPrisma();
    const items = await prisma.plaidItem.findMany({ where: { userId } });

    if (items.length === 0) {
      throw new Error('No brokerage connections found.');
    }

    const allTransactions: unknown[] = [];
    for (const item of items) {
      const accessToken = decrypt(item.accessTokenEncrypted);
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())
        .toISOString()
        .split('T')[0];
      const endDate = now.toISOString().split('T')[0];
      const response = await this.client.investmentsTransactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate
      });
      allTransactions.push(...response.data.investment_transactions);
    }

    return { transactions: allTransactions };
  }
}
