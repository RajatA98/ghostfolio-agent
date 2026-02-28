# Ghostfolio Subrepo Integration

This guide embeds `ghostfolio-agent` into a Ghostfolio fork while sharing Ghostfolio auth and user identity.

## 1) Add this repo as a submodule

From your Ghostfolio fork root:

```bash
git submodule add <your-agent-repo-url> apps/agent
git submodule update --init --recursive
```

## 2) Use shared-auth mode

Set these env vars for the embedded agent service:

```bash
AGENT_AUTH_MODE=ghostfolio_shared
AGENT_SINGLE_TENANT=false
GHOSTFOLIO_API_URL=http://<ghostfolio-api-base>
```

In shared-auth mode:

- The host Ghostfolio app must forward `Authorization: Bearer <ghostfolio_jwt>`.
- The host Ghostfolio app must forward `x-ghostfolio-user-id: <ghostfolio_user_id>`.
- The agent uses the forwarded JWT directly; it does not use Supabase.

## 3) Route integration in your Ghostfolio fork

Wire the host app so agent API calls are authenticated with the same Ghostfolio user context:

1. Read the current authenticated Ghostfolio user + JWT/session.
2. Proxy or forward requests to the agent with:
   - `Authorization: Bearer <ghostfolio_jwt>`
   - `x-ghostfolio-user-id: <ghostfolio_user_id>`
3. Keep `AGENT_SINGLE_TENANT=false` in all multi-user environments.

## 4) Prevent shared-account leakage

The agent now blocks shared `GHOSTFOLIO_JWT` fallback for real users by default.

- Shared fallback is allowed only when:
  - Request is explicit dev mode (`dev-user`), or
  - `AGENT_SINGLE_TENANT=true`.
- In production multi-user mode, provisioning failures return a 503 instead of silently using a shared JWT.
