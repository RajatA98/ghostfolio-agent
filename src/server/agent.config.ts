export const agentConfig = {
  get ghostfolioApiUrl(): string {
    return (
      process.env.GHOSTFOLIO_API_URL ||
      'https://agentforge-production-e263.up.railway.app'
    );
  },

  get ghostfolioJwt(): string {
    return process.env.GHOSTFOLIO_JWT || '';
  },

  get ghostfolioAccessToken(): string {
    return process.env.GHOSTFOLIO_ACCESS_TOKEN || '';
  },

  get defaultAccountId(): string {
    return process.env.AGENT_DEFAULT_ACCOUNT_ID || '';
  },

  get enableExternalMarketData(): boolean {
    return process.env.AGENT_ENABLE_MARKET === 'true';
  },

  get valuationFallback(): 'cost_basis' | 'error' {
    return (process.env.AGENT_VALUATION_FALLBACK || 'cost_basis') as
      | 'cost_basis'
      | 'error';
  },

  get defaultLookbackDays(): number {
    return Number(process.env.AGENT_DEFAULT_LOOKBACK_DAYS || 30);
  },

  get allowEducationalGuidance(): boolean {
    return process.env.AGENT_ALLOW_EDU === 'true' || true;
  },

  get anthropicApiKey(): string {
    return process.env.ANTHROPIC_API_KEY || '';
  },

  get anthropicModel(): string {
    return process.env.AGENT_MODEL || 'claude-sonnet-4-20250514';
  },

  get maxTokens(): number {
    return Number(process.env.AGENT_MAX_TOKENS || 4096);
  },

  get temperature(): number {
    return Number(process.env.AGENT_TEMPERATURE || 0.2);
  },

  get langsmithTracing(): boolean {
    return process.env.LANGSMITH_TRACING === 'true';
  },
  get langsmithApiKey(): string {
    return process.env.LANGSMITH_API_KEY || '';
  },
  get langsmithProject(): string {
    return process.env.LANGSMITH_PROJECT || 'ghostfolio-agent';
  },

  get langfuseEnabled(): boolean {
    return !!(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY);
  },
  get langfuseSecretKey(): string {
    return process.env.LANGFUSE_SECRET_KEY || '';
  },
  get langfusePublicKey(): string {
    return process.env.LANGFUSE_PUBLIC_KEY || '';
  },
  get langfuseBaseUrl(): string {
    return process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com';
  },

  get port(): number {
    return Number(process.env.PORT || 3334);
  },

  get corsOrigin(): string {
    return process.env.CORS_ORIGIN || 'http://localhost:5173';
  },

  // --- Plaid ---
  get plaidClientId(): string {
    return process.env.PLAID_CLIENT_ID || '';
  },
  get plaidSecret(): string {
    return process.env.PLAID_SECRET || '';
  },
  get plaidEnv(): string {
    return process.env.PLAID_ENV || 'sandbox';
  },
  get enablePlaid(): boolean {
    return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  },

  // --- Supabase ---
  get supabaseUrl(): string {
    return process.env.SUPABASE_URL || '';
  },
  get supabaseAnonKey(): string {
    return process.env.SUPABASE_ANON_KEY || '';
  },
  get supabaseServiceRoleKey(): string {
    return process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  },

  // --- Ghostfolio Internal (self-hosted on Railway) ---
  get ghostfolioInternalUrl(): string {
    return process.env.GHOSTFOLIO_INTERNAL_URL || process.env.GHOSTFOLIO_API_URL || '';
  },
  get ghostfolioAdminToken(): string {
    return process.env.GHOSTFOLIO_ADMIN_TOKEN || '';
  },

  // --- Encryption ---
  get encryptionKey(): string {
    return process.env.ENCRYPTION_KEY || '';
  },

  // --- Database ---
  get databaseUrl(): string {
    return process.env.DATABASE_URL || '';
  }
};
