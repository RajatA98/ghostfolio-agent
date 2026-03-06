import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode
} from 'plaid';

import { agentConfig } from '../agent.config';
import { encrypt, decrypt } from '../lib/encrypt';
import { getPrisma } from '../lib/prisma';

function getPlaidClient(): PlaidApi {
  const config = new Configuration({
    basePath: PlaidEnvironments[agentConfig.plaidEnv] ?? PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': agentConfig.plaidClientId,
        'PLAID-SECRET': agentConfig.plaidSecret
      }
    }
  });
  return new PlaidApi(config);
}

export interface PlaidHolding {
  symbol: string;
  name: string;
  quantity: number;
  costBasis: number | null;
  value: number;
  currency: string;
  institutionName: string | null;
}

export class PlaidService {
  private readonly client: PlaidApi;

  constructor() {
    this.client = getPlaidClient();
  }

  /**
   * Create a Plaid Link token so the frontend can launch Link UI.
   */
  async createLinkToken(userId: string): Promise<string> {
    const response = await this.client.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'Ghostfolio Agent',
      products: [Products.Investments],
      country_codes: [CountryCode.Us],
      language: 'en'
    });
    return response.data.link_token;
  }

  /**
   * Exchange a public_token from Link for an access_token and persist it.
   */
  async exchangePublicToken(
    userId: string,
    publicToken: string,
    institutionId?: string,
    institutionName?: string
  ): Promise<{ itemId: string }> {
    const response = await this.client.itemPublicTokenExchange({
      public_token: publicToken
    });

    const { access_token, item_id } = response.data;

    const prisma = getPrisma();
    await prisma.plaidItem.upsert({
      where: { itemId: item_id },
      update: {
        accessTokenEncrypted: encrypt(access_token),
        institutionId: institutionId ?? null,
        institutionName: institutionName ?? null,
        updatedAt: new Date()
      },
      create: {
        userId,
        itemId: item_id,
        accessTokenEncrypted: encrypt(access_token),
        institutionId: institutionId ?? null,
        institutionName: institutionName ?? null
      }
    });

    return { itemId: item_id };
  }

  /**
   * Fetch investment holdings from Plaid for a user.
   * Returns read-only holding data — never executes trades.
   */
  async getHoldings(userId: string): Promise<PlaidHolding[]> {
    const prisma = getPrisma();
    const items = await prisma.plaidItem.findMany({
      where: { userId }
    });

    if (items.length === 0) {
      return [];
    }

    const allHoldings: PlaidHolding[] = [];

    for (const item of items) {
      const accessToken = decrypt(item.accessTokenEncrypted);

      const response = await this.client.investmentsHoldingsGet({
        access_token: accessToken
      });

      const securitiesMap = new Map<string, { symbol: string; name: string }>();
      for (const sec of response.data.securities ?? []) {
        securitiesMap.set(sec.security_id, {
          symbol: sec.ticker_symbol ?? sec.name ?? 'UNKNOWN',
          name: sec.name ?? sec.ticker_symbol ?? 'Unknown'
        });
      }

      for (const h of response.data.holdings ?? []) {
        const sec = securitiesMap.get(h.security_id) ?? {
          symbol: 'UNKNOWN',
          name: 'Unknown'
        };

        allHoldings.push({
          symbol: sec.symbol,
          name: sec.name,
          quantity: h.quantity,
          costBasis: h.cost_basis ?? null,
          value: h.institution_value,
          currency: h.iso_currency_code ?? 'USD',
          institutionName: item.institutionName
        });
      }

      // Update sync timestamp
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { lastSyncedAt: new Date() }
      });
    }

    return allHoldings;
  }

  /**
   * Remove a Plaid item (unlink brokerage).
   */
  async removeItem(userId: string, itemId: string): Promise<void> {
    const prisma = getPrisma();
    const item = await prisma.plaidItem.findFirst({
      where: { userId, itemId }
    });

    if (!item) {
      throw new Error('Plaid item not found');
    }

    const accessToken = decrypt(item.accessTokenEncrypted);
    await this.client.itemRemove({ access_token: accessToken });

    await prisma.plaidItem.delete({ where: { id: item.id } });
  }
}
