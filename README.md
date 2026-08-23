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
| `AUTO_SCAN_INTERVAL_MIN` | `30` | Minimum minutes between *Anthropic calls specifically* — technical checks always run regardless of this. Only matters if `AI_RESEARCH_ENABLED` is `true` |
| `AI_RESEARCH_ENABLED` | `true` | `true` or `false`. Off = technicals-only forever, no Anthropic key needed, no cooldown applies |
| `SIGNAL_SENSITIVITY` | `medium` | `low` / `medium` / `high` — how easily a volume spike or book imbalance triggers a scan |
| `MAX_POSITION_PCT` | `5` | Hard cap on position size as % of equity — should match your dashboard setting |
| `MAX_LEVERAGE` | `3` | Hard cap on leverage — should match your dashboard setting |
| `MAX_STOP_LOSS_PCT` | `5` | Hard cap on how far a stop-loss can sit from entry (%) — rejects execution if the AI's (or your manually-entered) stop is wider than this |
| `DEFAULT_TAKE_PROFIT_PCT` | `3` | Used to fill in a take-profit whenever one is left blank |
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

## AI research toggle and cooldown architecture

Technical checks — order-book imbalance, volume spikes, multi-timeframe (15m/1h/4h) alignment, support/resistance — now run **every scheduled cycle, unconditionally**. None of that is gated by any cooldown; it's free, so it always runs.

What *is* gated is the Anthropic call specifically, by two independent things:

1. **The AI research toggle** (Settings → "Enable AI research", or `AI_RESEARCH_ENABLED` as a GitHub Variable). Off means the pipeline never calls Anthropic at all — every aligned setup goes straight to the rules-based technicals-only engine (requires 2+ of: candlestick pattern, MACD direction, RSI extreme, Bollinger Band edge, all agreeing). No Anthropic key is even required in this mode.
2. **`AUTO_SCAN_INTERVAL_MIN`**, which — when the toggle is on — throttles how often the *paid* call can fire. If a new aligned setup shows up before that many minutes have passed since the last AI call, you get a technicals-only idea instead of waiting; nothing is ever blocked or delayed, it just falls back.

This means you can run entirely on technicals (toggle off) with zero API cost and no artificial delay between ideas, or run with AI on and let the cooldown control spend — your choice, and it's a single checkbox to switch between them.

A duplicate-recommendation guard was added alongside this: if a coin already has a pending (unconfirmed) recommendation outstanding, a new cycle won't propose another one for that same coin until the existing one is confirmed, denied, or expires. This matters more now that technicals checks run on every cycle rather than being spaced out by a cooldown.

## Resilience and risk-level logic

- **If Anthropic is unreachable** (out of credits, rate-limited, network hiccup), the scanner doesn't just fail silently — it falls back to a rules-based technicals-only signal (requiring at least 2 of: a candlestick pattern, MACD histogram direction, RSI extreme, or price at a Bollinger Band edge, all agreeing). These are marked `technicals only` in the dashboard and flagged clearly in Telegram, sized conservatively (half your normal max position %, 1x leverage), since there's no sentiment/news confirmation behind them.
- **Every recommendation's stop-loss and take-profit are independently resolved**, not just trusted as given: if the AI's stop is within your max stop-loss distance, it's used as-is; if it's missing or too wide, a technically-grounded stop (just beyond the recent swing high/low) is calculated instead; only if neither is available does it fall back to a flat % from your settings. Take-profit follows the same priority — AI value, then a 1.5x risk:reward target off the resolved stop, then the flat default % as a last resort. The settings values are genuinely a safety net here, not the primary driver.

## If balances show $0.00 but you have funds

This is almost always one of two things, not a dashboard bug:

1. **Spot vs. Perps.** Hyperliquid keeps these separate. Testnet faucet USDC (or a deposit) can land in your Spot balance without automatically funding your Perps account — and only Perps equity shows here, since that's what trading actually uses. The Balances tab now detects this directly: if Perps shows $0 but Spot has funds, it tells you so and to transfer Spot → Perps in the Hyperliquid app.
2. **Wrong address or network.** The Balances tab also shows exactly which address and network (testnet/mainnet) it's querying — worth a quick visual double-check against where you actually deposited.

## Portfolio chart

A **Market / Portfolio** toggle sits above the main chart. Portfolio mode pulls your account's real value history from Hyperliquid (`day` / `week` / `month` / `all` periods) and buckets it into OHLC candles so it renders in the same candlestick view — open/close are the first/last value in each bucket, high/low are the bucket's extremes. It's a real equity curve, just expressed as candles instead of a line.

## Emergency exit

The Positions tab has a **🚨 Emergency Exit — Close All Positions** button, visible whenever you have open positions. It asks for a native confirm (listing exactly what it's about to close) before firing reduce-only market orders to flatten every open position at once. It reuses the same per-position close logic as the individual "Close position" buttons, just applied to everything at once — one failure won't stop it from attempting the rest.

## Multi-timeframe confirmation

Before a coin ever reaches Claude, it now has to clear a second, still-free gate on top of the volume/imbalance trigger: technicals are computed across **15m, 1h, and 4h** candles independently, each timeframe gets a simple directional bias (price vs. SMA20, MACD histogram sign, RSI above/below 50 — majority wins), and at least **2 of the 3 timeframes must agree** on direction before any Anthropic call happens. A coin with a volume spike but no cross-timeframe agreement gets skipped entirely — logged, no API cost. This applies to both the backend scanner and the dashboard's manual/auto scan.

Each timeframe also gets its own **support/resistance analysis**: local pivot highs/lows are detected and clustered into levels (nearby pivots within 0.5% are treated as the same level), and each level's **test count** — how many times price has approached it — is reported. More tests generally means a more significant level. These levels, with their test counts, are fed directly into the prompt so the AI's stop-loss and take-profit reasoning can reference real, quantified structure instead of guessing — and they're relayed straight through to the Telegram message too (`• Resistance: $67,240 (3x touched)...`), not just used internally.

Pattern detection covers both single/two-candle patterns (bullish/bearish engulfing, hammer, shooting star, doji) and multi-candle structures (three white soldiers, three black crows, morning star, evening star) — a single spike candle and a genuine three-candle reversal or continuation structure are treated as distinct signals, not conflated.

## Pattern coverage

Candlestick pattern detection now covers roughly 50 patterns instead of the original 6 — single-candle (doji variants, hammer, hanging man, inverted hammer, shooting star, belt holds), two-candle (engulfing, harami/harami cross, piercing line, dark cloud cover, kicking, meeting/separating lines, matching low, on-neck/in-neck/thrusting, side-by-side lines), three-candle (three soldiers/crows plus advance block and deliberation as their "weakening" variants, morning/evening star and their doji variants, abandoned baby, tri-star, three inside/outside up/down, stick sandwich, unique three river bottom, three stars in the south), and multi-candle continuation structures (three-line strike, rising/falling three methods).

**Honest limitation:** a handful of classic patterns (Breakaway, Concealing Baby Swallow, Ladder Bottom, Mat Hold, Upside/Downside Gap Three Methods, Upside/Downside Tasuki Gap) are defined around a genuine price *gap* between sessions — a concept that barely applies to a continuously-traded, 24/7 market like Hyperliquid perps. Rather than fake a "gap" with a loose threshold and produce a pattern that fires constantly or never, these were left out. Everything else on the reference pattern poster that doesn't fundamentally require a gap is implemented.

**Chart patterns** were added on top of candlesticks, built on the existing pivot/support-resistance infrastructure: double top, double bottom, head and shoulders, inverse head and shoulders (each reporting its neckline price and whether it's actually been confirmed by a close beyond it, versus still forming), plus ascending/descending triangles, rising/falling wedges, and symmetrical triangles (via simple trendline-slope comparison across recent pivot highs and lows). These feed into the prompt and the technicals-only fallback engine alongside candlestick patterns.

## USDC balances on the dashboard

The header now shows **both** Perps USDC and Spot USDC as separate chips, refreshed on every account poll — not just diagnostically when something looks like zero. This directly surfaces the Spot-vs-Perps distinction that's caused confusion before, without needing to open Settings or the Balances tab.

## Telegram message format

Recommendation messages are plain bullet lists — coin/direction/conviction header (with confluence score and self-consistency badge), pattern, confirming indicators, confluence factors, rationale, the counterthesis and why it's proposed anyway, horizon, entry/stop/target, resistance and support levels with touch counts, chart patterns, sizing, and any risk flags. No "not financial advice" disclaimer and no mention of which AI provider is behind it — just the trade information itself. Execution results (confirmed/failed/auto-traded) follow the same bullet format, including per-order fill status and the account snapshot.

## The AI research pipeline

This changed substantially from earlier versions — worth understanding as one piece:

- **No web search, no sentiment, no news.** The model's entire basis is technical and market-structure analysis: candlestick and chart patterns, indicators, support/resistance with touch counts, order-book imbalance, and open-interest momentum. It has no other input and is told so directly in the prompt.
- **Conviction is computed, not claimed.** The model reports which of 7 confluence factors are genuinely present (candlestick pattern, chart pattern, MACD agreement, RSI agreement, Bollinger position, support/resistance confluence, OI momentum) — honestly, since padding the list doesn't change anything downstream. Conviction (high/medium/low) is then derived from that count in code. The model never gets to just assert "high conviction."
- **Open interest momentum** is tracked across runs (persisted in `state.json`): rising OI with rising price reads as a fresh long buildup — a stronger signal than the same price move on falling OI, which usually just means short-covering. This is fed into every prompt.
- **Devil's advocate**: before finalizing each idea, the model has to name the single strongest reason the trade could fail (`counterthesis`) and briefly justify proposing it anyway (`counterthesis_response`). If it can't credibly do both, it's told to drop the idea.
- **Self-consistency (ensemble) check**: every AI-researched cycle calls Anthropic twice in parallel with the identical prompt. Only recommendations that reproduce on *both* passes — same coin, same direction — survive; everything else is silently dropped. Surviving recs merge conservatively: the tighter (safer) of the two stops, the smaller of the two sizes/leverages. This roughly doubles the API cost of a triggered scan but meaningfully raises the bar for what actually reaches you.
- **Entry, stop-loss, and take-profit are all set by the AI's own analysis, but all three are bounded by your settings — never trusted blindly:**
  - **Entry price** is checked against the live market price. If the AI's suggestion deviates more than `maxEntryDeviationPct` (default 2%), it's replaced with the live price.
  - **Stop-loss** uses the AI's value if it's within `maxStopLossPct`; otherwise a technically-computed swing-based stop; otherwise a flat cap at the max — in that priority order.
  - **Take-profit** uses the AI's value if valid; otherwise a 1.5x risk:reward target off the resolved stop; otherwise the flat `defaultTakeProfitPct`. Whatever the source, the final distance is always capped at `maxTakeProfitPct` (default 15%) — previously uncapped entirely.
  - All three get re-validated a second time at actual execution against the live price, not just at proposal time.

## Auto-trade (execute without a tap)

A new toggle — **off by default** — lets confirmed ideas execute without you tapping Confirm. Turning it on doesn't relax any of the risk checks above; it only removes the human-approval step.

- When on, `scan.js` tags new recommendations `auto_trade: true` and sends a Telegram message with a single **❌ Cancel** button instead of Confirm/Deny.
- `poll_telegram.js` still long-polls for that Cancel tap first (same ~4-minute window as normal), and only *after* that window sweeps for anything still pending and marked for auto-trade, executing it through the exact same code path (and the exact same price/stop/take-profit/size/leverage checks) as a manual confirm.
- Every outcome — executed, failed, or cancelled — still gets the full Telegram report: fill status, account snapshot, or the specific error.
- Toggle it in Settings (syncs to the backend via the GitHub publish flow) or set `AUTO_TRADE_ENABLED=true` as a GitHub Variable directly.

## Configurable risk variables (GitHub Variables)

| Variable | Default | What it bounds |
|---|---|---|
| `MAX_STOP_LOSS_PCT` | 5 | Max stop-loss distance from entry |
| `MAX_TAKE_PROFIT_PCT` | 15 | Max take-profit distance from entry |
| `MAX_ENTRY_DEVIATION_PCT` | 2 | Max deviation between AI-suggested entry and live price, checked both at proposal and execution time |
| `DEFAULT_TAKE_PROFIT_PCT` | 3 | Flat fallback take-profit %, only used when no AI value and no valid technical target exist |
| `MAX_POSITION_PCT` | 5 | Max position size as % of equity |
| `MAX_LEVERAGE` | 3 | Max leverage |
| `AI_RESEARCH_ENABLED` | true | Off = technicals-only forever, no Anthropic key needed |
| `AUTO_TRADE_ENABLED` | false | On = confirmed ideas execute without a tap (see above) |

The 1.5x risk:reward multiple used for the *technically-driven* take-profit target (when no AI value is valid) is still hardcoded in `resolveRiskLevels()`, not a separate variable — ask if you'd like that exposed too.

## Telegram/agent reliability

A real bug got fixed here: Telegram messages were sent with `parse_mode: Markdown`, which silently fails to send or edit if the text (AI-generated rationale, or an error message) contains a stray `*`, `_`, or `` ` ``. Combined with failures only being logged to GitHub's console (never back to you), a tap on Confirm could look like it did nothing even when something real happened or failed behind the scenes. Fixed properly, not worked around:

- All Telegram messages are now plain text — no more silent parse failures.
- Confirming now gets an **immediate acknowledgment** ("checking price and risk limits…") before execution even starts, so a tap always visibly registers right away.
- If editing the original message ever fails for any reason, it falls back to sending a **brand new message** instead of going silent.
- Every outcome — executed, denied, expired, or failed — now includes **real per-order fill status** (filled/resting/error, parsed straight from Hyperliquid's response) and a **live account snapshot** (value, margin used, withdrawable, open position count), not just a generic "done."
- A top-level safety net around the whole callback handler means any unexpected error still reaches you as a Telegram message, with a pointer to check the workflow's logs — nothing fails purely into a GitHub Actions log you'd never think to open.
- The dashboard's own confirm flow got the same fill-status and account-snapshot treatment for consistency.

## Preventing git conflicts between the two workflows

Both workflows write to `docs/recommendations.json`, and they used to have separate concurrency groups — meaning nothing stopped them from running at the exact same time and racing to commit. Usually the built-in retry logic (5 attempts with backoff) absorbed this fine, but a genuine content conflict (both processes editing the same lines in the same run window) could leave a retry stuck mid-rebase, causing all 5 attempts to fail and that run's update to be lost (not corrupted — just not persisted; the next scheduled run starts clean).

Both workflows now share a single concurrency group (`jarvis-trade-agent-git`), so GitHub Actions queues one behind the other instead of ever running them simultaneously — the race is prevented at the source rather than patched after the fact. The retry loop itself also now runs `git rebase --abort` before every attempt, so even in an edge case (e.g. two manual `workflow_dispatch` runs triggered back-to-back), a stuck rebase from one attempt can't block the next.

One tradeoff worth knowing: since the Telegram poller's runs are usually close to 4 minutes long (long-polling) out of its 5-minute cycle, sharing a queue with the scanner means a poll cycle can occasionally get delayed by however long the scanner's run takes (typically well under a minute, since it only calls Anthropic when a signal actually trips). This costs at most roughly a minute of responsiveness in the rare case they collide — a small price for not risking lost state.

## Workflow failure alerts

Both workflows now send you a Telegram message if the whole run fails — not just failures inside the script, but broken dependency installs, expired secrets, or all 5 git-push retries failing. If Telegram suddenly "stops responding," check for one of these alerts first; if you got one, the Actions tab has the actual logs. If you didn't get one, the workflow itself is running fine and the issue is more likely upstream (Telegram API, bot token, or your own connectivity).

## Dashboard UI additions

- **USDC balance** now shows prominently in the header, next to the connection badge — no need to open the Balances tab just to check your account value at a glance.
- **Activity log** can now go full-screen via the "⛶ Expand" button in its header bar (there's also a "Clear" button). Useful when debugging — the log is otherwise capped at a small scroll box.
- **Telegram order responses and the dashboard's own confirm flow** now both report your **investable balance** (uncommitted funds available for new trades — Hyperliquid calls this "withdrawable") alongside account value and margin used, so you always know how much headroom you have left after a trade executes or fails.

## Security summary

- `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` are used only by the scanner — they never touch trading.
- `HL_AGENT_PRIVATE_KEY` / `HL_ACCOUNT_ADDRESS` are used only by the poller, and only when a Confirm tap arrives from your specific `TELEGRAM_CHAT_ID` — taps from anyone else are logged and ignored.
- No key is ever committed to the repo or visible in workflow logs — everything sensitive lives in GitHub Secrets.
- Trade execution keys entered directly in the dashboard (for manual trading there) stay local to your browser's storage and are never sent to GitHub.
- Start on `HL_EXEC_NETWORK=testnet` and watch a few full end-to-end cycles — scan → Telegram alert → confirm → execution — before ever switching to mainnet.
