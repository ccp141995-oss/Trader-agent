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

## Scan/analysis/Telegram sequencing

`scan.js`'s pipeline was already fully sequential in code — signals, then multi-timeframe alignment, then AI/fallback analysis, then risk-bounding, and only after all of that does it ever send a Telegram message. Added explicit `PHASE 1/2/3` log markers so this is provable in the Actions logs, not just asserted. The more likely real cause of overlapping-feeling messages: the Telegram poller was long-polling for ~4 of its 5-minute cycle, and since it shares a concurrency lock with the scanner (to prevent the git-conflict bug from earlier), the scanner spent most of its time queued right behind it — so a scan result could land moments after a poller message, looking like simultaneous activity even though it wasn't. Shortened the poller's window to 2.5 minutes to give the scanner more breathing room in that shared queue.

## Trend strength (ADX)

Separate from the directional bias already in place, every timeframe now also gets an ADX(14) reading — a standard, independent measure of *how strongly* a market is trending, not just which way. ADX ≥25 reads as genuinely trending, below 20 as weak/ranging. This is computed in code (Wilder smoothing, the standard method) and feeds in two places: the prompt (so the model knows whether to trust the directional signal it's seeing), and `computeConviction()` as an objective bonus point — a strong trend on the 15m reference timeframe adds to the confluence score the same way a confirmed pattern does, but it's never self-reported by the model, so it can't be padded.

## Chart screenshots

Every recommendation now includes an actual candlestick chart image — the last 250 x 15m candles (~2.5 days) with entry/stop/target marked as horizontal lines — so you can visually sanity-check the pattern in context, not just against a handful of recent bars. The image is rendered wider (1000x450) to keep 250 candles legible rather than compressed into a narrow strip.

**How it's built**: rendered via QuickChart.io (a free, widely-used chart-rendering API) using a POST request — not a GET-encoded URL, which for ~20 candles of OHLC data runs past 4,000 characters and risks silent truncation or rejection by either QuickChart or Telegram. POST has no such limit and returns PNG bytes directly. On the backend, those bytes get uploaded to Telegram via `sendPhoto` as multipart form data (using Node's built-in `FormData`/`Blob`, no extra dependency). On the dashboard, the same POST call returns a blob that becomes a local object URL for inline `<img>` display.

**This is best-effort, not a hard gate**: if QuickChart is unreachable or the render fails, the recommendation still sends — you get the full text description either way, just without the image, and the failure is logged clearly. A recommendation's validity was never made to depend on a third-party image service staying up.

**Worth knowing**: I couldn't test the actual rendered output from this environment (no network access in my build sandbox) — the chart config follows QuickChart's documented `chartjs-chart-financial` + `chartjs-plugin-annotation` format, but if the first chart you receive looks wrong (candles missing, annotations misplaced), let me know and I'll adjust the config.

## Recommendation history log

A new **History** tab in the dashboard (separate from the live Agent tab) captures every recommendation the dashboard has ever seen — from manual scans and from the backend bot synced over Telegram — independent of whether it's still pending. Each entry can be expanded to show the full rationale, counterthesis, confluence factors, support/resistance, chart patterns, and the chart screenshot (re-rendered on demand from the saved candle data, not stored as a giant image blob). **Clear all history** wipes the whole log; each entry also has its own **Delete**. This is a local, browser-side log (localStorage, capped at 150 entries) — it doesn't modify the backend's `recommendations.json`, so clearing it here has no effect on the bot.

The same **Expand** control was added to the live Agent tab's recommendation cards too, so you can read the full analysis and see the chart without needing to open the trade-confirm modal.

## The AI research pipeline

This changed substantially from earlier versions — worth understanding as one piece:

- **No web search, no sentiment, no news.** The model's entire basis is technical and market-structure analysis: candlestick and chart patterns, indicators, support/resistance with touch counts, order-book imbalance, and open-interest momentum. It has no other input and is told so directly in the prompt.
- **Conviction is computed, not claimed.** The model reports which of 7 self-assessed confluence factors are genuinely present (candlestick pattern, chart pattern, MACD agreement, RSI agreement, Bollinger position, support/resistance confluence, OI momentum) — honestly, since padding the list doesn't change anything downstream. An 8th factor — genuine trend strength (ADX ≥25) — is added automatically in code, not self-reported, since it's objective data we already compute (see "Trend strength" above). Conviction (high/medium/low) is derived from the combined count. The model never gets to just assert "high conviction."
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

## Minimum equity to scan

If the account can't place even the smallest possible order, there's no point running any analysis on it. The backend now checks equity (using the same Unified-Account-aware resolution as everywhere else) right at the start of each cycle, before the free signal check even runs — if it's below Hyperliquid's $10 minimum, the whole scan is skipped, with a Telegram alert rate-limited to once per 6 hours (not every 15-minute cycle) so a small/unfunded account doesn't spam the chat while you're deciding whether to fund it. The dashboard's manual and auto-scan got the same gate. This is a pure cost/waste optimization — no analysis, no Anthropic call, nothing — for a trade that could never actually be placed.

**A correctness fix alongside this**: the $10-minimum bump (added previously) wasn't checked against your configured max position size, and worse, the *reported* percentage/margin figures in the execution message didn't reflect the bump at all — they'd silently show the original, smaller percentage even though a larger one was actually used. Both are fixed: bumping now explicitly flags when it exceeds your max position % ("this account may be too small for your risk settings"), and all reported figures are recomputed to match what was actually executed. Verified with a battery of test cases: a bump that stays within cap, one that exceeds it, equity too low for any order at all, and an exact-boundary case — all resolve correctly.

## Price precision ("Invalid TP/SL price" / "invalid size" errors)

Hyperliquid requires every price to fit 5 significant figures, and no more than (6 − that asset's `szDecimals`) decimal places — a per-coin value, not the same for every asset. The code previously formatted every price with a flat `.toFixed(2)`, which happens to work for BTC/ETH-range prices but can badly mangle prices for other coins — e.g. a coin at $0.0234567 would get rounded to $0.02, destroying almost all precision, and get rejected outright.

Fixed everywhere an order gets placed (backend execution, dashboard confirm, manual order ticket, closing positions): asset metadata (`szDecimals` per coin) is fetched once and cached, and every price — entry, stop-loss, take-profit — is rounded through a proper `formatHlPrice()` that respects both the 5-sig-fig and per-asset decimal rules, not a blanket 2 decimals.

## Direct chart link

Every recommendation — Telegram, dashboard rec cards, the expanded detail view, History, and the confirm modal — now includes a direct link to that coin's live chart on Hyperliquid (`app.hyperliquid.xyz/trade/{COIN}`). Always mainnet, regardless of which network you're actually scanning or executing on — the real, liquid chart is what's useful to look at.

## Auto-trade eligibility is stricter than the general top-2 cap

Both top-2 recommendations still get sent to Telegram/dashboard every scan for your review either way — this only controls which one, if any, is allowed to execute *without* a tap when auto-trade is on. Only the single **highest-ranked** idea per scan can ever qualify (never the second-place one, even if it's also strong), and only if its confluence score is **7 or 8 out of 8** — anything at 6 or below still requires your manual confirm regardless of rank. Tested against five cases including the exact boundary (a score of exactly 6 correctly does not qualify, since the bar is "greater than 6").

Worth knowing as a side effect: the technicals-only fallback engine can only ever reach a maximum score of 6 (it doesn't have access to the AI-reported factors), so a fallback-sourced recommendation can never qualify for auto-trade under this rule — only AI-researched, self-consistency-verified ideas can. This seemed like the right outcome rather than something to work around: unattended execution should have the highest bar in the system, not the same bar as everything else.

## Top recommendations per scan

Even when more coins clear the multi-timeframe gate and produce a valid idea, only the **top 2 by confidence** get sent — everything else is dropped before any per-idea work (chart image generation, Telegram sends) happens on it, so nothing is wasted on ideas that won't make the cut. "Confidence" here means the same code-computed confluence score used for conviction (candlestick pattern, chart pattern, indicator agreement, support/resistance, OI momentum, trend strength) — not the model's own self-assessment, and not just whichever ideas happened to come first. This applies identically to AI-researched and technicals-only-fallback cycles, and to both the backend and the dashboard's manual/auto scan.

## Hyperliquid's $10 minimum order value

Hyperliquid rejects any order below $10 notional, exchange-wide, no exceptions — this is what "order has invalid size" usually means in practice, not a precision/decimal issue. It's easy to hit on smaller accounts: a modest suggested size percentage on a small equity base can compute well under $10. This is now handled at three points rather than left to fail at the exchange:

1. **At recommendation time** (`scan.js`) — if the estimated equity and suggested % would produce under $10 notional, the suggested percentage itself gets bumped up before the idea ever reaches Telegram, with a risk flag noting it happened.
2. **At execution time** (`poll_telegram.js`) — re-checked and bumped again defensively (covers cases where equity changed, or the scan-time estimate wasn't available). If even the account's *entire* equity can't reach $10, it fails clearly with that exact reason instead of a cryptic exchange rejection.
3. **On the dashboard** — the confirm modal pre-fills a size that already respects the $10 floor, the risk check blocks confirming below it if you edit it down manually, and the manual order ticket validates it too (skipped for reduce-only orders, which close exposure rather than open it).

## Message formatting

Telegram and dashboard recommendation messages were one long flat list of 15+ bullets by this point — reorganized into three clear sections instead: **Setup** (pattern, confluence, trend, chart patterns, support/resistance), **Analysis** (rationale, counterthesis, horizon), and **Trade** (entry/stop/target, sizing, funds required, risk flags). Same information, meaningfully faster to scan.



The manual order ticket now shows the same estimate live as you type — size × price, plus % of equity when connected, updating on price/size changes, order-type toggling (market vs limit), coin switching, and live mid-price ticks for market orders. Deliberately labeled "notional value" rather than showing a margin figure there: the manual ticket has no leverage input, so unlike AI recommendations (where leverage is always known), there's no reliable way to compute actual margin for a manual order — Hyperliquid's per-asset leverage setting isn't something this dashboard tracks. It also turns red and calls out when the entered size falls under Hyperliquid's $10 minimum, before you even hit submit.

## Circuit breaker (drawdown protection)

Suspends all trading — manual and automatic, dashboard and Telegram — and closes everything if account equity drops too far, too fast.

**Why total equity, not idle cash:** a circuit breaker's job is to catch a real deterioration in your capital *before* it gets worse, including damage that's still unrealized in an open position. Watching only idle/withdrawable cash would be blind to exactly the scenario that matters most — a position actively losing money right now. If equity is down 25%, that's genuinely true whether or not anything has been closed yet. This is the standard approach in professional risk systems, and it's deliberate here, not an oversight.

**Why a rolling 24h window, not "since the bot started":** comparing against a fixed starting point would either never reset (making the check meaningless after any single volatile day) or require arbitrary daily resets. Instead, every run records a timestamped equity sample, and the check compares *current* equity against the sample closest to exactly 24 hours ago. Normal intraday position volatility — a position that dipped hard and recovered within a few hours — won't trip it. A sustained decline across a full day will. Tested against five scenarios including that exact "dipped then recovered" case, which correctly does not trip.

**What happens when it trips:**
1. Every open position gets closed with an aggressive IOC order (wider slippage tolerance than normal — urgency matters more than price here).
2. Every resting order gets cancelled (including any leftover TP/SL from the fix above).
3. An unmissable Telegram alert goes out with the exact numbers and what was closed/cancelled.
4. All trading is blocked at every entry point — confirmed Telegram trades, auto-trade, the dashboard's manual order ticket, its own scan/confirm flow — until manually reset.
5. The dashboard shows a persistent red banner with a **Reset Circuit Breaker** button. Resetting restarts the 24-hour window from that moment (seeded with current equity), so a legitimate decision to resume doesn't risk an immediate re-trip against a stale baseline.

**Where it lives:** the actual detection and execution happens in `poll_telegram.js`, since that's the only process with both signing capability and a frequent (5-minute) schedule. `scan.js` and the dashboard just read the shared `docs/circuit_breaker.json` file and respect it. The threshold (`CIRCUIT_BREAKER_DRAWDOWN_PCT`, default 25) is configurable as a GitHub Variable or from Settings.

## Leftover TP/SL orders after closing a position

`grouping: 'normalTpsl'` (already in place) makes Hyperliquid auto-cancel the sibling TP or SL order the instant the *other* one triggers — confirmed via Hyperliquid's own docs, which list "canceled due to sibling ordering being filled" as an explicit order status. But that only covers the case where the position closes *because* one of those two orders filled. A manual close (the dashboard's "Close position" button, or Emergency Exit All) is a separate, independent reduce-only order — neither TP nor SL actually triggered, so the exchange has no reason to cancel them, and they're left resting with nothing left to reduce.

Fixed: after any manual close succeeds, the dashboard now checks for and cancels any remaining open orders on that coin. Emergency Exit All already calls the same close function per position, so it's covered automatically too.

## Excluding coins with an open position from new recommendations

Both the backend and the dashboard's manual/auto scan now check current open positions before running any analysis, and skip generating a new recommendation for a coin you're already positioned in. The backend reuses the same account fetch it already makes for the equity pre-check (no extra API call), and the dashboard reuses the positions data it already tracks for the Positions tab. This prevents stacking multiple simultaneous ideas on the same coin, which could otherwise compound risk in ways the per-trade risk settings don't account for.

## "Connected" header but empty Positions/Orders

Found the actual bug: the header badge was set to "Connected" the moment the SDK *object* was constructed — a purely local, synchronous operation with no network call involved, so it basically can never fail. Whether the account's actual data (positions, orders, balances) was successfully fetched was a completely separate step, and a failure there was only ever logged quietly to the activity log — the header had no way of reflecting it, and the Positions/Orders panels have static "No account connected." placeholder text that only gets replaced once the data genuinely loads, so a persistently failing fetch left them stuck on that misleading message indefinitely.

Fixed properly: the badge now only shows "Connected" once the account data has actually been verified as loaded — showing "Connected (no data yet)" if the credentials are valid but the fetch itself failed, and "Connected (data stale)" if it was working and then started failing on a later poll. The Positions/Orders placeholders also now say something accurate and actionable ("Could not load account data — retrying automatically") instead of the misleading "No account connected" when the real issue is a failed fetch, not a configuration problem.

## "Failed to fetch" errors

The confirmed, actual source: `loadCandles()` (the interactive market chart on the main dashboard page) fetches through `infoPost()`, which — like every other Hyperliquid API call in the dashboard — now retries automatically (up to 2 retries with backoff) before surfacing an error. "Failed to fetch" is the generic browser message for any network-level failure, and on a mobile connection that's very often a transient blip, not a real outage; the dashboard was treating every one as final before this fix.

Separately, while investigating, a theoretical CORS risk was identified in the recommendation-chart preview (a `POST` request with a JSON body, which triggers a CORS preflight that QuickChart doesn't uniformly support across all their endpoints) — but this turned out not to be the actual problem in practice; the recommendation and Telegram chart screenshots at 250 candles were working fine as they were. That code path has been reverted to its original form. The one genuine improvement kept from that investigation: the backend now also writes each chart image as a static PNG file (`docs/charts/{id}.png`) alongside `recommendations.json`, and the dashboard prefers loading that same-origin file via a plain `<img>` tag when available — strictly more reliable than a live cross-origin fetch, with no downside, and it doesn't change the 250-candle rendering at all. The original live-render path (POST-based, 250 candles) remains as the fallback for recommendations generated directly in the dashboard, which never go through the backend's file-writing step.

## Mobile: scroll fix wasn't viewport-width-independent

The earlier CSS fix for the clipped ticket only applied inside a `max-width: 860px` media query. If the phone is in landscape orientation, is a larger phone/phablet, or has "Desktop site" mode enabled (common on some Android browsers), the reported viewport width can easily exceed 860px — meaning the fix silently wouldn't apply at all, and the original clipping bug would still be fully in effect. Fixed by making `overflow-y: auto` the **unconditional default** for the relevant containers, not something scoped to a guessed breakpoint — it now can't be skipped by viewport width, orientation, or browser display mode.

## Timestamps on recommendations

Every recommendation now carries a `generated_at` timestamp — this already existed on the backend but was never actually displayed anywhere except the History tab; dashboard-generated recommendations (manual/auto scan) never got one set at all. Both fixed. Shown as relative time ("12m ago") on compact rec cards and the confirm modal for a quick glance, and as an exact timestamp plus relative time in the expanded detail view and History. Telegram messages show an explicit UTC timestamp ("Recommended: 2026-08-24 14:32 UTC") rather than assuming any particular timezone, since that message is generated server-side with no way to know which timezone you're actually in — the dashboard, running in your own browser, shows local time instead.

## Mobile: dashboard struggling to load

Found two real bugs while investigating this:

1. **`boot()` had zero error handling.** It ran `loadMeta()`, `loadMids()`, and `loadCandles()` as sequential, unguarded `await` calls — if any single one failed (far more likely on a flaky mobile connection than on wifi), everything after it silently never ran, including `startPolling()`. No error message, no retry, page just permanently stuck in its initial placeholder state until a manual reload. Fixed: each step is now independently wrapped, a failure in one no longer blocks the others, and `startPolling()` always runs regardless — so a failed first attempt self-heals on the next automatic interval instead of requiring a reload.
2. **The `hyperliquid` SDK script had no version pin** (`unpkg.com/hyperliquid/dist/browser.global.js` — no `@version`), meaning it silently loaded whatever the *latest* published version happened to be on every page load. If that package ever ships a breaking change, this dashboard would break with zero changes on our end, at an unpredictable time. Pinned to `1.7.3`.

Also made a performance fix while in there: all three CDN scripts (`lightweight-charts`, `hyperliquid`, `xlsx`) were loaded as render-blocking `<script>` tags in `<head>` — the browser had to fully download and execute all three before it could continue parsing the rest of the page, a much bigger tax on a slower mobile connection than on wifi. Now loaded with `defer`, and `boot()` waits for `DOMContentLoaded` (which fires after deferred scripts finish) to guarantee correct ordering.

## Mobile: manual order ticket getting cut off

Found the actual cause: `.main-col` (which holds the chart and the order ticket) had `overflow:hidden` set unconditionally, and the mobile layout override never gave it back a way to scroll — so if the ticket's content ever ran taller than the space available, it was genuinely clipped with no scrollbar, not just visually cramped. Fixed by giving `.main-col` (and `.side-col`) `overflow-y:auto` specifically within the mobile breakpoint, with `-webkit-overflow-scrolling:touch` for smoother scrolling on iOS. If this still doesn't fully resolve it on your specific device/browser, the next thing worth knowing is which one (iOS Safari vs. Chrome, etc.) since mobile viewport-height quirks vary by browser.

## Funds required (notional vs. margin)

"X% of equity" was always the *notional* position size, not the cash actually locked up — with leverage, the real margin required is notional ÷ leverage, which can be meaningfully smaller. Every recommendation (Telegram, dashboard rec cards, the expanded detail view, and the confirm modal) now shows both explicitly: e.g. "$50.00 notional — cash required up front: ~$16.67 margin at 3x." The backend estimate reads equity once per scan (using the same Unified-Account-aware resolution as everywhere else) via an optional `HL_ACCOUNT_ADDRESS` — just the public address, no key — added to `scan.yml`; if that's not set, the line is simply omitted rather than shown wrong. This is always an estimate: actual execution re-checks live equity and price at confirm time regardless of what this preview showed.

## Configurable risk variables (GitHub Variables)

| Variable | Default | What it bounds |
|---|---|---|
| `MAX_STOP_LOSS_PCT` | 5 | Max stop-loss distance from entry |
| `MAX_TAKE_PROFIT_PCT` | 15 | Max take-profit distance from entry |
| `MAX_ENTRY_DEVIATION_PCT` | 2 | Max deviation between AI-suggested entry and live price, checked both at proposal and execution time |
| `CIRCUIT_BREAKER_DRAWDOWN_PCT` | 25 | 24h equity drawdown that triggers an emergency close-all and suspends trading |
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
