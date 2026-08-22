# JARVIS Trade Agent — GitHub-hosted scanner + Telegram confirm/deny execution

This repo has four pieces:

- `docs/index.html` — the dashboard. Still works exactly as before; now also reflects trades confirmed or denied via Telegram.
- `agent/scan.js` — checks order-book/volume signals, calls Anthropic (with web search) only when something trips a threshold, and sends each recommendation to Telegram with **Confirm / Deny buttons**. Holds no trading key.
- `agent/poll_telegram.js` — checks Telegram for button taps, and **only on a Confirm tap from your authorized chat**, places the trade via the Hyperliquid SDK. This is the one script that holds a trading key.
- Two workflows: `scan.yml` (every 15 min, finds and proposes trades) and `telegram-poll.yml` (every 5 min, listens for your response and executes).

**Read this before wiring up real execution:**

- Confirming in Telegram is a straight accept/deny of the AI's proposal — unlike the dashboard, you can't edit size/stop/leverage from Telegram itself. If you want to adjust a trade before placing it, deny it in Telegram and use the dashboard's Review & Confirm instead (it shows the same recommendation).
- Response time isn't instant. The poller runs every 5 minutes and long-polls Telegram for ~4 of those minutes, so in practice you'll usually get a response within well under a minute, but worst case it's a few minutes.
- `HL_EXEC_NETWORK` defaults to **testnet** even if you point signal-scanning (`HL_NETWORK`) at mainnet for real market data. You have to deliberately set it to `mainnet` to trade with real funds — this default is intentional.
- Every confirmed trade is re-validated at execution time against your `MAX_POSITION_PCT` / `MAX_LEVERAGE`, re-priced against the live market (aborts if price drifted >2.5% since the recommendation), and checked that the stop-loss still makes directional sense — the AI's suggested numbers are a starting point, not what gets executed unchecked.
- Recommendations expire (`EXECUTION_WINDOW_MIN`, default 180 min) — after that, Confirm does nothing and the message updates to show it expired.

## Setup

Steps 1–4 are the same as before (create the repo, turn on GitHub Pages for `docs/`, create a Telegram bot via @BotFather, get your chat ID). If you've already done those, skip to the new secrets below.

### Additional Secrets (Settings → Secrets and variables → Actions → Secrets)

| Name | Value |
|---|---|
| `HL_AGENT_PRIVATE_KEY` | Your Hyperliquid **agent/API wallet** key — not your main wallet's key. Agent keys can trade but can't withdraw. |
| `HL_ACCOUNT_ADDRESS` | Your main Hyperliquid account address (public, but keep it with the others for convenience) |

### Additional Variables (same page, Variables tab)

| Name | Value | Notes |
|---|---|---|
| `HL_EXEC_NETWORK` | `testnet` | Change to `mainnet` only when you're ready to trade real funds |
| `MAX_POSITION_PCT` | `5` | Should match what you'd set in the dashboard |
| `MAX_LEVERAGE` | `3` | Should match what you'd set in the dashboard |
| `EXECUTION_WINDOW_MIN` | `180` | How long a recommendation stays confirmable |

### Enable the second workflow

Both `scan.yml` and `telegram-poll.yml` run automatically once merged to `main` — nothing extra to turn on. Check the **Actions** tab to confirm both show up and are running.

## How a trade flows end to end

1. `scan.yml` runs, checks signals, calls Anthropic only if something trips.
2. If it finds an idea, it messages you on Telegram with the full setup and two buttons.
3. You tap **Confirm** or **Deny**.
4. Within a few minutes, `telegram-poll.yml` picks up your tap, re-validates against current price and your risk limits, and either places the bracket order (entry + stop-loss + optional take-profit) or tells you why it didn't.
5. The Telegram message updates in place to show the outcome. The dashboard's Agent tab reflects the same status the next time it syncs (about once a minute while open).

## Security summary

- `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`: used only by `scan.js`, never touch trading.
- `HL_AGENT_PRIVATE_KEY`, `HL_ACCOUNT_ADDRESS`: used only by `poll_telegram.js`, and only when a Confirm tap arrives from your `TELEGRAM_CHAT_ID` specifically — taps from anyone else are logged and ignored.
- Use an **agent/API wallet key**, never your main wallet's private key, here or in the dashboard. Agent keys can't withdraw or transfer funds even if a secret were ever exposed.
- Start on `HL_EXEC_NETWORK=testnet` and watch a few end-to-end cycles before ever switching to mainnet.
