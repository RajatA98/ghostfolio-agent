# Decision Log

Chronological record of major technical decisions and the reasoning behind them.

---

### 2026-03-13 — Remove Ghostfolio dependency entirely

**Decision:** Strip all Ghostfolio integration (auth, portfolio service, sync service, trade tools, HTTP client) and make the agent a standalone product.

**Why:** The agent was tightly coupled to Ghostfolio for portfolio data, user management, and trade execution. Separating it makes the agent independently deployable with its own auth (Supabase) and brokerage connectivity (SnapTrade). Users no longer need a self-hosted Ghostfolio instance.

**Impact:** Deleted 8 files, rewrote 15+ files. Agent is now read-only (no trading). Portfolio data comes exclusively from SnapTrade holdings enriched with Yahoo Finance prices.

---

### 2026-03-13 — Read-only agent, no trade execution

**Decision:** Remove all trade-related tools (`portfolioTrade`, `snaptradeSync`) and guardrails (`trade-guardrail.ts`). The agent is strictly read-only.

**Why:** User decided the agent should analyze and advise, not execute trades. This simplifies the system, removes confirmation flows, and eliminates the risk of unintended trades. Legal and compliance surface area is significantly reduced.

**Impact:** Removed `PaperTradeInput/Result` types, `trade_blocked` termination reason, trade confirmation guardrail block in agent loop, `requiresConfirmation` from tool registry.

---

### 2026-03-13 — Yahoo Finance via curl instead of yahoo-finance2 npm package

**Decision:** Use `execSync('curl ...')` to fetch Yahoo Finance v8 chart API instead of the `yahoo-finance2` npm package.

**Why:** The `yahoo-finance2` package uses Node.js `fetch` which gets TLS-fingerprinted and blocked by Yahoo. Using `curl` with a browser User-Agent string bypasses this reliably.

**Impact:** Custom `lib/yahoo.ts` module with `fetchYahooQuote()` and `toYahooSymbol()`. 60-second in-memory price cache to minimize requests.

---

### 2026-03-13 — Point-in-time performance only (no time series)

**Decision:** `getPerformance` returns current gain/loss vs cost basis, not historical time series.

**Why:** SnapTrade does not provide historical portfolio values. Without a separate data store for daily snapshots, time-series performance is not possible. The response includes `reasonIfUnavailable` to explain this limitation to the user.

**Impact:** Simpler performance tool. Future enhancement could add daily snapshot persistence.

---

### 2026-03-13 — Supabase for auth instead of Ghostfolio JWT

**Decision:** Use Supabase Auth (email/password + Google OAuth) with JWT verification middleware.

**Why:** Standalone product needs its own auth. Supabase provides managed auth with social login, email verification, and JWT tokens — no custom auth server needed.

**Impact:** Client uses `@supabase/supabase-js` for login. Server verifies JWTs via Supabase SDK. Dev mode skips verification for local development.

---

### 2026-03-13 — Per-user encryption keys for SnapTrade credentials

**Decision:** Derive a unique AES-256-GCM encryption key per user using PBKDF2(supabaseUserId, ENCRYPTION_SALT, 100k iterations, SHA-512). Replace the shared `ENCRYPTION_KEY` approach for new encryptions.

**Why:** With a single shared key, anyone with database access AND the `ENCRYPTION_KEY` could decrypt all users' SnapTrade secrets. Per-user keys ensure that even a DB admin cannot read another user's credentials — you'd need both the `ENCRYPTION_SALT` and the specific user's `supabaseUserId` to derive their key. This provides true zero-knowledge for the operator.

**Impact:** Updated `lib/encrypt.ts` with `encryptForUser`/`decryptForUser`/`decryptWithFallback`. Legacy secrets (shared key) are lazily re-encrypted with per-user keys on next access. Requires new `ENCRYPTION_SALT` env var. All SnapTrade service methods now accept `supabaseUserId` parameter.

---

### 2026-03-13 — Replace SnapTrade with SnapTrade

**Decision:** Remove SnapTrade entirely and use SnapTrade for brokerage connectivity. SnapTrade provides a Connection Portal (popup) and read-only access to holdings across brokerages.

**Why:** SnapTrade offers broader brokerage coverage, simpler integration (no webhook handling), and a managed connection portal UI. The agent only needs read-only access to holdings.

**Impact:** Deleted SnapTradeService, SnapTradeItem model, SnapTrade Link integration. Added SnapTradeService, BrokerageConnection model, SnapTrade Connection Portal popup flow. All env vars changed from PLAID_* to SNAPTRADE_*.

---

### 2026-03-13 — No portfolio data persistence

**Decision:** Do not store holdings, prices, or portfolio snapshots in the database. Fetch live from SnapTrade on each request with a 60-second in-memory cache.

**Why:** Avoids data staleness issues, reduces database complexity, and minimizes the amount of sensitive financial data stored. The tradeoff is slightly higher latency on cache-miss requests.

**Impact:** PortfolioService has an in-memory `Map<string, CachedSnapshot>` with 60s TTL. Cache is per-process (not shared across instances).

---

### 2026-03-13 — Synthetic tool injection on first iteration

**Decision:** On the first iteration of the ReAct loop, if the user's message implies a portfolio or performance question, auto-inject the relevant tool call even if the LLM doesn't request it.

**Why:** Reduces latency by 1 round-trip. Common queries like "show my portfolio" always need a snapshot — waiting for the LLM to decide this wastes time and tokens.

**Impact:** `injectSyntheticToolCalls()` in AgentService. Only fires on iteration 0. The LLM still processes the tool results normally in subsequent iterations.
