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
  ): Promise<void> {
    const response = await this.client.itemPublicTokenExchange({
      public_token: publicToken
    });
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    const prisma = getPrisma();
    await prisma.plaidItem.upsert({
      where: { itemId },
      create: {
        userId,
        itemId,
        accessToken: encrypt(accessToken),
        institutionId: institutionId ?? null,
        institutionName: institutionName ?? null
      },
      update: {
        accessToken: encrypt(accessToken),
        institutionId: institutionId ?? null,
        institutionName: institutionName ?? null
      }
    });
  }

  async getInvestmentHoldings(userId: string): Promise<{
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
      const accessToken = decrypt(item.accessToken);
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
}
