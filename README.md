# Ghostfolio Agent

Standalone AI agent service and frontend for Ghostfolio.

## Requirements checklist

| Requirement | Status |
|-------------|--------|
| Agent responds to natural language queries (portfolio domain) | ✓ |
| At least 3 functional tools | ✓ (`getPortfolioSnapshot`, `getPerformance`, `simulateAllocationChange`; optional `getMarketPrices`) |
| Tool calls execute and return structured results | ✓ |
| Agent synthesizes tool results into coherent responses | ✓ |
| Conversation history maintained across turns | ✓ (client sends `conversationHistory` to API) |
| Basic error handling (graceful failure, not crashes) | ✓ |
| At least one domain-specific verification check | ✓ (advice boundary, allocation sum, cost-basis labeling in `agent.verifier`) |
| Simple evaluation: 5+ test cases with expected outcomes | ✓ (Jest: 5 unit tests; golden set: 16 deterministic data-retrieval cases in `golden-set.yaml`; scenario set in `scenario-set.yaml`) |
| Deployed and publicly accessible | Deploy via Railway, Docker, or VPS (see below) |

## What it does

- Exposes a chat API at `POST /api/chat`
- Uses Claude tool-calling
- Fetches portfolio data from Ghostfolio over HTTP using the user JWT
- Serves a minimal standalone frontend

## Quick start

1. Copy `.env.template` to `.env` and fill in values.
2. Install deps: `npm install`
3. Start the agent API: `npm run dev`
4. In another terminal, start the client: `npm run dev:client`
5. Open `http://localhost:5173`

Ghostfolio API must be reachable at `GHOSTFOLIO_API_URL`. For the deployed app use `https://agentforge-production-e263.up.railway.app` (set in `.env` or use the default).

## See the agent (chat UI) — simple connect flow

1. Start the agent: `npm run dev` (listens on `http://localhost:3334`).
2. In another terminal, start the client: `npm run dev:client` (serves the chat UI at `http://localhost:5173`).
3. Open `http://localhost:5173` in your browser.
4. The UI uses same-origin requests (`/api/...`) and Vite proxies them to the agent in dev mode.
5. **Connect with Ghostfolio** — either:
   - **JWT**: Log in at Ghostfolio in another tab; copy the JWT from the URL (e.g. `…/auth/eyJhbGciOi…`) and paste it in the agent UI, then click **Connect**, or  
   - **Access token**: If your Ghostfolio account has an access token (Settings → Account), paste it and click **Connect** (the agent will exchange it for a JWT).
6. Type a message and click Send to talk to the agent.

If the connect box stays visible, check the agent terminal for `Could not auto-exchange access token` and verify Ghostfolio is running and `GHOSTFOLIO_ACCESS_TOKEN` is the security token from Create Account.

## Using deployed Ghostfolio

Ghostfolio is deployed at **https://agentforge-production-e263.up.railway.app**. The agent is already configured to use this URL by default.

- **JWT**: Log in at [Ghostfolio](https://agentforge-production-e263.up.railway.app/en/home), copy the JWT from the URL after redirect (e.g. `…/auth/eyJhbG…`), and paste it in the agent UI → **Connect**.
- **Access token**: In Ghostfolio go to Settings → Account, create/copy your access token, paste it in the agent UI → **Connect** (the agent exchanges it for a JWT).

If your agent UI is served from a different origin (e.g. another domain), set `CORS_ORIGIN` in `.env` to that origin so the browser can send the JWT to the agent.

## Evaluation

- **Unit tests**: `npm test` runs 5 Jest tests (agent service: direct response, portfolio snapshot, performance, synthesis, tool error handling).
- **Golden set evals**: 16 data-retrieval cases in `src/server/evals/golden-set.yaml` using four deterministic check types — tool selection, source citation, content validation, negative validation. All checks are code evals: binary pass/fail, no LLM needed. See [docs/golden-set-checks.md](docs/golden-set-checks.md) for details.
- **Scenario evals**: advice/behavior cases in `src/server/evals/scenario-set.yaml` (e.g., buy/sell advice, prediction, tax-advice prompts). These are still deterministic checks but do not block CI by default.
- **Run golden set** against a live agent: set `EVAL_BASE_URL` and `EVAL_JWT` in `.env` (or use `GHOSTFOLIO_JWT` / `GHOSTFOLIO_ACCESS_TOKEN`), then:
  ```bash
  npm run evals:golden
  ```
- **Run scenarios**:
  ```bash
  npm run evals:scenarios
  ```
  Without `EVAL_BASE_URL` in `.env`, either command loads cases and prints what would run (dry run).

## Production build

1. Build server + client: `npm run build`
2. Start the server: `npm start`
3. Open `http://localhost:3334`

The server serves both the API and the built frontend from a single origin.

## Deploying the agent

### Option A: Railway (recommended)

1. Install the [Railway CLI](https://docs.railway.app/develop/cli) or connect the repo in the [Railway dashboard](https://railway.app).
2. Create a new project and add this service (from this repo).
3. Set **Root Directory** to this repo (or leave default if it’s the only app).
4. **Build**: Railway will use the `Dockerfile` if present, or Nixpacks. To force Docker: add a `railway.toml` with `builder = "DOCKERFILE"` or set the builder in the dashboard.
5. **Env vars**: In Railway → Variables, set at least:
   - `ANTHROPIC_API_KEY` (required)
   - `GHOSTFOLIO_API_URL` (default is the production Ghostfolio URL; override if needed)
   - `CORS_ORIGIN` = your agent’s public URL (e.g. `https://your-agent.up.railway.app`) so the browser can call the API when needed.
   - Optional: `GHOSTFOLIO_ACCESS_TOKEN` or `GHOSTFOLIO_JWT` so users don’t have to connect manually.
6. Deploy. The app listens on `PORT` (Railway sets this automatically).

### Option B: Docker

```bash
# Build
docker build -t ghostfolio-agent .

# Run (pass env or use --env-file)
docker run -p 3334:3334 \
  -e ANTHROPIC_API_KEY=your_key \
  -e CORS_ORIGIN=https://your-public-url \
  ghostfolio-agent
```

For production, use a platform that runs the container (Railway, Render, Fly.io, ECS, etc.) and set the same env vars there.

### Option C: Build and run on a VPS

```bash
npm ci
npm run build
PORT=3334 node dist/server/main.js
```

Use a process manager (e.g. systemd or PM2) and a reverse proxy (e.g. nginx) with HTTPS. Set env from `.env` or the process manager config.
