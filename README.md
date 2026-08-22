# JARVIS Trade Agent — full setup walkthrough

This repo has four pieces:

- `docs/index.html` — the trading dashboard (charts, positions, balances, order entry, and the Agent tab).
- `agent/scan.js` — checks order-book/volume signals for your watchlist, and only calls Anthropic (with web search) when a coin actually trips a threshold. Sends each recommendation to Telegram with **Confirm / Deny** buttons. Holds no trading key.
- `agent/poll_telegram.js` — listens for your button tap, and **only on a Confirm from your authorized chat**, places the trade via the Hyperliquid SDK. This is the one script that holds a trading key.
- Two workflows: `scan.yml` (every 15 min, finds and proposes trades) and `telegram-poll.yml` (every 5 min, listens for your response and executes).

Trade execution always requires your explicit tap or dashboard click — nothing here places an order unattended.

---

## 1. Create the GitHub repo

1. Create a new repository on GitHub (public or private — private repos have a smaller free Actions minutes budget, but this setup is cheap either way).
2. Upload everything in this folder, preserving the structure:
   ```
   docs/index.html
   docs/recommendations.json
   agent/scan.js
   agent/poll_telegram.js
   agent/package.json
   agent/state.json
   .github/workflows/scan.yml
   .github/workflows/telegram-poll.yml
   README.md
   ```
3. Commit and push to the `main` branch.

## 2. Turn on GitHub Pages (hosts the dashboard)

1. In the repo, go to **Settings → Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch".
3. Branch: `main`, folder: `/docs`. Save.
4. After a minute or two, your dashboard is live at `https://<your-username>.github.io/<repo-name>/`. Bookmark it — this is now your persistent dashboard URL, no local file needed.

## 3. Create a Telegram bot

1. In Telegram, message **@BotFather**.
2. Send `/newbot`, give it a name and a username (must end in `bot`). BotFather replies with a **token** like `123456:ABC-DEF...` — save it.
3. Message your new bot anything (e.g. "hi") so it has a chat to reply into.
4. In a browser, visit:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   Find `"chat":{"id":123456789,...}` in the response — that number is your **chat ID**.

## 4. Add secrets (Settings → Secrets and variables → Actions → Secrets tab)

These are never shown again after saving, and never appear in logs.

| Name | Value | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | scanner (research) |
| `TELEGRAM_BOT_TOKEN` | The token from BotFather | scanner + poller |
| `TELEGRAM_CHAT_ID` | The chat ID from step 3 | scanner + poller |
| `HL_AGENT_PRIVATE_KEY` | Your Hyperliquid **agent/API wallet** key — not your main wallet's key | poller (execution) |
| `HL_ACCOUNT_ADDRESS` | Your main Hyperliquid account address | poller (execution) |

Use an **agent/API wallet key** (create one in the Hyperliquid app → Settings → API), never your main wallet's private key. Agent keys can trade but cannot withdraw or transfer funds, so a leaked secret here can't drain your account.

## 5. Add variables (same page, Variables tab)

Not secret, just config — you can change these anytime without touching code.

| Name | Value | Notes |
|---|---|---|
| `WATCHLIST` | `BTC,ETH,SOL,HYPE` | Comma-separated, should match the dashboard's watchlist. Ignored if `SCAN_MODE=filtered` |
| `SCAN_MODE` | `watchlist` | `watchlist` or `filtered`. Filtered mode ranks the whole Hyperliquid perp universe by 24h volume, drops anything below your OI/volume floors, and scans the top N that remain — no ticker list to maintain |
| `FILTERED_TOP_N` | `20` | Only used in filtered mode — how many top-ranked coins to actually scan |
| `FILTERED_MIN_OI` | `1000000` | Only used in filtered mode — minimum open interest (USD) to be eligible |
| `FILTERED_MIN_VOLUME_24H` | `2000000` | Only used in filtered mode — minimum 24h volume (USD) to be eligible |
| `HL_NETWORK` | `mainnet` | Signal data should come from mainnet even if you execute on testnet — testnet volume isn't real |
| `HL_EXEC_NETWORK` | `testnet` | **Where trades actually execute.** Change to `mainnet` only when you're ready to risk real funds |
| `AUTO_SCAN_INTERVAL_MIN` | `30` | Minimum minutes between full (paid) research scans |
| `SIGNAL_SENSITIVITY` | `medium` | `low` / `medium` / `high` — how easily a volume spike or book imbalance triggers a scan |
| `MAX_POSITION_PCT` | `5` | Hard cap on position size as % of equity — should match your dashboard setting |
| `MAX_LEVERAGE` | `3` | Hard cap on leverage — should match your dashboard setting |
| `EXECUTION_WINDOW_MIN` | `180` | How long a recommendation stays confirmable before it expires |

## 6. Run it

Both workflows run automatically once merged to `main` — nothing extra to enable. To test immediately: go to the **Actions** tab → pick a workflow → **Run workflow**.

Check each run's logs to see what it decided (skipped on cooldown, no signal tripped, found something and messaged Telegram, or a Telegram button was handled).

## 7. (Optional) Sync dashboard settings to the bot

By default, the dashboard's Settings (watchlist, scan mode, filtered-universe thresholds, max position %, max leverage, default take-profit) are separate from the GitHub Variables above — they only affect the dashboard's own manual/in-browser scanning. To have one save update both:

1. Create a **fine-grained GitHub personal access token**: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Scope it to **this one repository only**, with **Contents: Read and write** permission and nothing else.
2. In the dashboard's Settings, under "Sync to GitHub bot", enter your repo as `owner/repo-name` and paste the token.
3. Either check "Auto-publish these settings to the bot whenever I save", or just click **Publish now** whenever you want to push a change.
4. This writes `docs/agent-config.json` in your repo. Both `scan.js` and `poll_telegram.js` read it automatically and use it in place of the matching GitHub Variables — no code changes, no re-running workflows manually.

This token can only edit files in this repo — it can't touch other repos, your account, or (unlike the Hyperliquid keys) any funds. Still, keep its scope as narrow as shown above.

---

## How a trade flows end to end

1. `scan.yml` runs every 15 minutes, checks signals for your watchlist, and only calls Anthropic if a coin trips a threshold.
2. If it finds a genuine quick-turnaround idea, it messages you on Telegram with the full setup — catalyst, rationale, entry, stop, target, suggested size — and two buttons.
3. You tap **✅ Confirm** or **❌ Deny**.
4. Within a few minutes, `telegram-poll.yml` (running every 5 min, long-polling Telegram in between) picks up your tap. On Confirm, it re-checks the price hasn't drifted more than 2.5% since the recommendation, re-validates against your `MAX_POSITION_PCT` / `MAX_LEVERAGE`, sizes off your live account equity, and places the bracket order (entry + stop-loss + optional take-profit). On Deny, it just closes it out.
5. The Telegram message updates in place to show the outcome. The dashboard's Agent tab reflects the same status within about a minute of you opening it.

**Two things worth knowing:**
- Confirming in Telegram is a straight accept/deny — you can't edit size/stop/leverage from Telegram itself. If you want to adjust before placing, deny it and use the dashboard's Review & Confirm on the same recommendation instead.
- Response time isn't instant — usually well under a minute while the poller's mid-cycle, but worst case a few minutes if your tap lands right after a cycle ends.

## Cost notes

- **GitHub Actions**: free tier comfortably covers both workflows at these cadences — most runs finish in a few seconds unless they're actually calling Anthropic or executing a trade.
- **Anthropic**: you're only billed on runs where a signal actually trips — the local order-book/volume check is the whole point of keeping this cheap.
- **Telegram**: free.

## How the agent thinks now

The agent's primary evidence is technical: for every coin it researches, it pulls ~120 recent 15-minute candles and computes RSI(14), SMA(20/50), MACD, Bollinger Bands, volume vs. its 20-bar average, and checks for a handful of classic candlestick patterns (bullish/bearish engulfing, hammer, shooting star, doji) — all done in plain JS, not left to the model to eyeball. Only when that technical picture is genuinely compelling (a real pattern, confirmed by volume, with at least one indicator agreeing) does it do a quick supplementary web search for sentiment/news — used only to confirm or flag a conflict, never as the primary reason for a trade. Every recommendation now carries `pattern`, `indicators_confirming`, and a short `sentiment_note` instead of the old catalyst-first framing.

## Pausing

The Agent tab has a **Pause auto-scan** button. Toggling it stops the dashboard's own in-browser auto-scan immediately, and — if you've set up GitHub sync (below) — publishes the paused state to `docs/agent-config.json`, so the backend scanner skips its scheduled runs too until you resume. Manual "Scan for opportunities" and the Telegram poller (for already-pending recommendations) both keep working while paused; pausing only stops *new* automatic scans from firing.

## Security summary

- `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` are used only by the scanner — they never touch trading.
- `HL_AGENT_PRIVATE_KEY` / `HL_ACCOUNT_ADDRESS` are used only by the poller, and only when a Confirm tap arrives from your specific `TELEGRAM_CHAT_ID` — taps from anyone else are logged and ignored.
- No key is ever committed to the repo or visible in workflow logs — everything sensitive lives in GitHub Secrets.
- Trade execution keys entered directly in the dashboard (for manual trading there) stay local to your browser's storage and are never sent to GitHub.
- Start on `HL_EXEC_NETWORK=testnet` and watch a few full end-to-end cycles — scan → Telegram alert → confirm → execution — before ever switching to mainnet.
