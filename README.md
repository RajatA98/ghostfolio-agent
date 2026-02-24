# Ghostfolio Agent

Standalone AI agent service and frontend for Ghostfolio.

## What it does

- Exposes a chat API at `POST /api/chat`
- Uses Claude tool-calling
- Fetches portfolio data from Ghostfolio over HTTP using the user JWT
- Serves a minimal standalone frontend

## Quick start

1. Copy `.env.template` to `.env` and fill in values.
2. Install deps: `npm install`
3. Run in dev mode: `npm run dev`

Ghostfolio API must be running at `GHOSTFOLIO_API_URL`.
