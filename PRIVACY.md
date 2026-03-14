# Privacy Analysis

## Data Classification

### Stored (PostgreSQL via Prisma)

| Data | Model | Classification | Protection |
|------|-------|----------------|------------|
| Supabase User ID | `User.supabaseUserId` | PII identifier | Unique index |
| Email | `User.email` | PII | Plaintext (optional field) |
| SnapTrade User Secret | `BrokerageConnection.userSecretEncrypted` | Critical secret | Per-user AES-256-GCM (PBKDF2-derived key) |
| SnapTrade User ID | `BrokerageConnection.snaptradeUserId` | Service identifier | Plaintext |
| Institution Name | `BrokerageConnection.institutionName` | Financial metadata | Plaintext |

### Transient (in-memory only, not persisted)

| Data | Location | TTL | Classification |
|------|----------|-----|----------------|
| Portfolio holdings | `PortfolioService` cache | 60 seconds | Financial PII |
| Market prices | `priceCache` in `lib/yahoo.ts` | 60 seconds | Public data |
| Chat messages | Request/response cycle | Request duration | User content |
| Supabase JWT | HTTP Authorization header | Request duration | Auth credential |
| Anthropic API key | Environment variable | Process lifetime | Critical secret |

### Sent to Third Parties

| Data | Destination | Purpose | Retention |
|------|-------------|---------|-----------|
| Chat messages + tool results | Anthropic (Claude API) | LLM inference | Per Anthropic's data policy |
| Chat messages + tool results | Langfuse (if enabled) | Observability traces | Configurable in Langfuse |
| Chat messages + tool results | LangSmith (if enabled) | LLM tracing | Configurable in LangSmith |
| SnapTrade user secret (decrypted) | SnapTrade API | Fetch holdings | Per SnapTrade's data policy |
| Stock symbols | Yahoo Finance | Price lookup | Public API, no auth |

## Security Controls

### Per-User Encryption

SnapTrade credentials are encrypted with **per-user derived keys** so that even a database administrator cannot decrypt another user's secrets:

```
Key derivation: PBKDF2(supabaseUserId, ENCRYPTION_SALT, 100000 iterations, 32 bytes, SHA-512)
Cipher: AES-256-GCM with random 12-byte IV per encryption
Format: base64(IV || AUTH_TAG || CIPHERTEXT)
```

**What this means:**
- Each user's SnapTrade secret is encrypted with a unique key derived from their Supabase identity
- A database dump alone is useless — you also need the `ENCRYPTION_SALT` env var AND the user's `supabaseUserId`
- Compromising one user's key does not expose any other user's data
- Legacy secrets (encrypted with the shared `ENCRYPTION_KEY`) are lazily re-encrypted with per-user keys on next access

**What is NOT stored:**
- No portfolio holdings, balances, or transaction history in the database
- No chat messages persisted server-side
- No market prices or valuations stored

### Authentication
- Supabase JWT verification on all `/api/*` routes (except `/health`).
- Dev mode bypass only when `SUPABASE_URL` is not configured (local development).
- Eval bypass requires matching `EVAL_JWT` token.

### Authorization
- Users can only access their own data — `userId` from JWT is used for all Prisma queries.
- No admin endpoints. No cross-user data access.

### Agent Guardrails
- **Read-only:** No trade execution tools. System prompt explicitly prohibits trade instructions.
- **No financial advice:** Disclaimers injected into responses mentioning tax or selling.
- **Forbidden phrases:** "tax advice" automatically replaced with "personalized tax guidance."

## Data Flow Diagram

```
User Browser
  |-- Supabase Auth (email/Google) --> Supabase Cloud
  |-- Chat message + JWT --> Express Server
        |-- JWT verification --> Supabase Cloud
        |-- User lookup/create --> PostgreSQL
        |-- Decrypt SnapTrade secret (per-user key) --> PostgreSQL
        |-- Fetch holdings --> SnapTrade API
        |-- Fetch prices --> Yahoo Finance (via curl)
        |-- LLM inference --> Anthropic Claude API
        |-- Trace logging --> Langfuse/LangSmith (optional)
        |-- Response --> User Browser
```

## Recommendations

1. **Chat history:** Currently not stored server-side. If persistence is added, encrypt at rest and implement retention policies.
2. **Email hashing:** Consider storing email as a hash if only used for display, not for login (Supabase handles auth).
3. **Langfuse/LangSmith:** These services receive full chat content and tool results. Review their data retention and privacy policies before enabling in production.
4. **ENCRYPTION_SALT rotation:** Rotating the salt requires re-encrypting all existing secrets. Build a migration script that decrypts with old salt and re-encrypts with new salt.
5. **Rate limiting:** No per-user rate limiting on `/api/chat`. Consider adding to prevent abuse of Anthropic API credits.
