// JARVIS Trade Agent — Telegram confirm/deny poller + executor
//
// Polls Telegram for button presses on recommendations scan.js sent, and — only on an
// explicit "Confirm" tap from the authorized chat — places the bracket order (entry +
// stop-loss + optional take-profit) via the Hyperliquid SDK.
//
// This is the ONE place in the whole system that holds a trading key and places orders.
// Every execution still requires a human tap; nothing here runs unattended without that.

const fs = require('fs');
const path = require('path');
const { Hyperliquid } = require('hyperliquid');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const HL_EXEC_NETWORK = (process.env.HL_EXEC_NETWORK || 'testnet').toLowerCase(); // testnet by default, on purpose
const HL_AGENT_PRIVATE_KEY = process.env.HL_AGENT_PRIVATE_KEY;
const HL_ACCOUNT_ADDRESS = process.env.HL_ACCOUNT_ADDRESS;
const MAX_POSITION_PCT_DEFAULT = parseFloat(process.env.MAX_POSITION_PCT || '5');
const MAX_LEVERAGE_DEFAULT = parseFloat(process.env.MAX_LEVERAGE || '3');
const DEFAULT_TAKE_PROFIT_PCT_DEFAULT = parseFloat(process.env.DEFAULT_TAKE_PROFIT_PCT || '3');
const MAX_STOP_LOSS_PCT_DEFAULT = parseFloat(process.env.MAX_STOP_LOSS_PCT || '5');
let MAX_POSITION_PCT = MAX_POSITION_PCT_DEFAULT;
let MAX_LEVERAGE = MAX_LEVERAGE_DEFAULT;
let DEFAULT_TAKE_PROFIT_PCT = DEFAULT_TAKE_PROFIT_PCT_DEFAULT;
let MAX_STOP_LOSS_PCT = MAX_STOP_LOSS_PCT_DEFAULT;
let MAX_TAKE_PROFIT_PCT = parseFloat(process.env.MAX_TAKE_PROFIT_PCT || '15');
const MIN_ORDER_NOTIONAL = 10; // Hyperliquid rejects any order below $10 notional, exchange-wide
let MAX_ENTRY_DEVIATION_PCT = parseFloat(process.env.MAX_ENTRY_DEVIATION_PCT || '2');
const EXECUTION_WINDOW_MIN = parseFloat(process.env.EXECUTION_WINDOW_MIN || '180');

const INFO_URL = HL_EXEC_NETWORK === 'mainnet' ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info';
const FEED_PATH = path.join(__dirname, '..', 'docs', 'recommendations.json');
const OFFSET_PATH = path.join(__dirname, 'telegram_offset.json');
const SHARED_CONFIG_PATH = path.join(__dirname, '..', 'docs', 'agent-config.json');
const CIRCUIT_BREAKER_PATH = path.join(__dirname, '..', 'docs', 'circuit_breaker.json');
let CIRCUIT_BREAKER_DRAWDOWN_PCT = parseFloat(process.env.CIRCUIT_BREAKER_DRAWDOWN_PCT || '25');
const POLL_BUDGET_MS = 2.5 * 60 * 1000; // leave real breathing room in the shared concurrency queue for the scanner

function readJson(p, fallback){ try{ return JSON.parse(fs.readFileSync(p, 'utf8')); }catch(e){ return fallback; } }
function writeJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function loadSharedConfig(){
  const shared = readJson(SHARED_CONFIG_PATH, null);
  if(!shared) return;
  if(shared.maxPositionPct) MAX_POSITION_PCT = parseFloat(shared.maxPositionPct);
  if(shared.maxLeverage) MAX_LEVERAGE = parseFloat(shared.maxLeverage);
  if(shared.defaultTakeProfitPct) DEFAULT_TAKE_PROFIT_PCT = parseFloat(shared.defaultTakeProfitPct);
  if(shared.maxStopLossPct) MAX_STOP_LOSS_PCT = parseFloat(shared.maxStopLossPct);
  if(shared.maxTakeProfitPct) MAX_TAKE_PROFIT_PCT = parseFloat(shared.maxTakeProfitPct);
  if(shared.maxEntryDeviationPct) MAX_ENTRY_DEVIATION_PCT = parseFloat(shared.maxEntryDeviationPct);
  if(shared.circuitBreakerDrawdownPct) CIRCUIT_BREAKER_DRAWDOWN_PCT = parseFloat(shared.circuitBreakerDrawdownPct);
  console.log(`Using dashboard-published risk config: max ${MAX_POSITION_PCT}% equity, ${MAX_LEVERAGE}x leverage, ${DEFAULT_TAKE_PROFIT_PCT}% default TP, ${MAX_STOP_LOSS_PCT}% max stop distance, ${MAX_TAKE_PROFIT_PCT}% max TP distance, ${MAX_ENTRY_DEVIATION_PCT}% max entry deviation (updated ${shared.updated_at || 'unknown'})`);
}

async function tg(method, body, attempt){
  attempt = attempt || 1;
  try{
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if(!data.ok) console.error(`Telegram ${method} returned not-ok:`, data.description);
    return data;
  }catch(e){
    console.error(`Telegram ${method} threw:`, e.message);
    if(attempt < 2){ await new Promise(r=>setTimeout(r,1000)); return tg(method, body, attempt+1); }
    return { ok: false, description: e.message };
  }
}

async function infoPost(body){
  const res = await fetch(INFO_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if(!res.ok) throw new Error('info ' + body.type + ' HTTP ' + res.status);
  return res.json();
}

// ---------------- Hyperliquid price formatting ----------------
// Hyperliquid requires every price to fit 5 significant figures AND no more than
// (6 - szDecimals) decimal places for perps — szDecimals varies per asset, so a flat
// .toFixed(2) that happens to work for BTC/ETH can violate this for other coins and get
// rejected with "Invalid TP/SL price" or similar. szDecimals is cached once per run.
let szDecimalsCache = null;
async function getSzDecimals(coin){
  if(!szDecimalsCache){
    // A failed fetch must NOT cache an empty-but-truthy {} — that permanently poisons every
    // future lookup for the rest of this process's life (since `if(!szDecimalsCache)` is false
    // for an empty object), silently making every coin look "unrecognized" after one transient
    // network hiccup.
    for(let attempt = 1; attempt <= 3; attempt++){
      try{
        const meta = await infoPost({ type: 'meta' });
        const map = {};
        (meta.universe || []).forEach(u => { map[u.name] = u.szDecimals; });
        szDecimalsCache = map;
        break;
      }catch(e){
        if(attempt < 3){ await new Promise(r => setTimeout(r, attempt * 800)); }
        else{ console.error('Could not fetch szDecimals metadata after retries:', e.message); return undefined; }
      }
    }
  }
  return szDecimalsCache[coin];
}

function roundToSigFigs(num, sigFigs){
  if(!num || num === 0) return 0;
  const d = Math.ceil(Math.log10(Math.abs(num)));
  const power = sigFigs - d;
  const magnitude = Math.pow(10, power);
  return Math.round(num * magnitude) / magnitude;
}

function formatHlPrice(price, szDecimals){
  if(szDecimals == null) return parseFloat(price.toFixed(2)); // fallback if metadata unavailable
  const maxDecimals = 6; // perps; spot would be 8, not used here
  const allowedDecimals = Math.max(0, maxDecimals - szDecimals);
  let rounded = roundToSigFigs(price, 5);
  const factor = Math.pow(10, allowedDecimals);
  rounded = Math.round(rounded * factor) / factor;
  return rounded;
}

// Hyperliquid enforces a maximum number of decimal places for SIZE too, per asset — simply
// szDecimals itself, unlike price which has the extra 5-significant-figure rule. A raw
// notional/price division can easily exceed that, causing "Order has invalid size" — the exact
// same class of bug formatHlPrice already fixed for prices, just never applied to size.
function formatHlSize(size, szDecimals){
  if(szDecimals == null) return parseFloat(size.toFixed(4)); // conservative fallback
  const factor = Math.pow(10, szDecimals);
  return Math.round(size * factor) / factor;
}

function findRec(feed, id){ return (feed.recommendations || []).find(r => r.id === id); }

async function editStatusMessage(rec, text){
  const chatId = rec.telegram_chat_id || TELEGRAM_CHAT_ID;
  if(rec.telegram_message_id){
    const result = await tg('editMessageText', {
      chat_id: chatId,
      message_id: rec.telegram_message_id,
      text
    });
    if(result.ok) return;
    console.error('Edit failed, sending a fresh message instead:', result.description);
  }
  // No message id, or the edit itself failed (message too old, deleted, etc.) — never let the
  // update go silently missing. Send it as a brand new message instead.
  await tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
}

async function getCurrentMid(coin){
  const mids = await infoPost({ type: 'allMids' });
  return mids[coin] ? parseFloat(mids[coin]) : null;
}

// Every place that constructs the SDK for execution must go through this — the SDK's own
// internal name-to-asset-index resolution (used by placeOrder/cancelOrder) needs its metadata
// populated via sdk.info.perpetuals.getMeta() first. Our code has always used its own separate
// fetch()-based infoPost() for every read (balances, candles, etc.), entirely bypassing the
// SDK's own info methods — meaning that internal map was never being populated at all, and
// every single order was failing with "Unknown asset: undefined" as a result, regardless of
// which coin. Confirmed directly from a stack trace showing the failure inside the SDK's own
// getAssetIndex() method, for BTC — about as unambiguously real an asset as exists on this
// exchange, ruling out every previous theory about the coin itself being invalid.
async function buildExecutionSdk(){
  const sdk = new Hyperliquid({
    enableWs: false,
    privateKey: HL_AGENT_PRIVATE_KEY,
    testnet: HL_EXEC_NETWORK !== 'mainnet',
    walletAddress: HL_ACCOUNT_ADDRESS,
    // Explicitly null: the SDK otherwise falls back to using the wallet address derived from
    // the private key as a vault address, which Hyperliquid rejects with "Vault not registered"
    // since an agent wallet is not a vault.
    vaultAddress: null
  });
  // The SDK requires explicit initialization before its internal asset-index resolution works —
  // confirmed from its own docs: "In most cases the SDK will automatically initialize itself
  // when required. However, in some cases you may need to explicitly initialize the SDK:
  // await sdk.connect()". Works with enableWs:false too — it initializes the SDK, not just
  // websockets. Only after that does refreshing the symbol-conversion cache make sense.
  let warmupOk = false, lastWarmupError = null;
  for(let attempt = 1; attempt <= 3 && !warmupOk; attempt++){
    try{
      if(typeof sdk.connect === 'function') await sdk.connect();
      if(typeof sdk.refreshAssetMapsNow === 'function') await sdk.refreshAssetMapsNow();
      else if(sdk.info && sdk.info.perpetuals && typeof sdk.info.perpetuals.getMeta === 'function') await sdk.info.perpetuals.getMeta();
      warmupOk = true;
    }catch(e){
      lastWarmupError = e;
      if(attempt < 3) await new Promise(r => setTimeout(r, attempt * 800));
    }
  }
  if(!warmupOk) throw (lastWarmupError || new Error('SDK initialization failed'));
  // "Vault not registered" persisted after clearing sdk.vaultAddress and sdk.exchange.vaultAddress
  // directly — the actual state may live somewhere else, or be computed fresh at signing time.
  // Search every own property, two levels deep, for anything named like "vault" and clear it.
  try{
    const hits = [];
    function scan(obj, path, depth){
      if(!obj || typeof obj !== 'object' || depth > 2) return;
      Object.keys(obj).forEach(key => {
        if(/vault/i.test(key)){
          hits.push(path + '.' + key + ' = ' + JSON.stringify(obj[key]));
          try{ obj[key] = null; }catch(e){}
        }
      });
      if(depth < 2){
        ['exchange','info','custom','symbolConversion'].forEach(sub => {
          if(obj[sub] && typeof obj[sub] === 'object') scan(obj[sub], path + '.' + sub, depth + 1);
        });
      }
    }
    scan(sdk, 'sdk', 0);
    console.log(hits.length ? ('Found and cleared vault-related properties: ' + hits.join(' | ')) : 'No vault-related properties found on the SDK (2 levels deep) — value may be computed fresh at signing time.');
  }catch(e){ console.error('Vault property scan failed:', e.message); }
  return sdk;
}

async function getSpotUsdcBalance(){
  if(!HL_ACCOUNT_ADDRESS) return null;
  try{
    const state = await infoPost({ type: 'spotClearinghouseState', user: HL_ACCOUNT_ADDRESS });
    const usdc = (state.balances || []).find(b => b.coin === 'USDC');
    return usdc ? parseFloat(usdc.total) : 0;
  }catch(e){ console.error('spotClearinghouseState fetch failed:', e.message); return null; }
}

// Hyperliquid's Unified Account / Portfolio Margin modes (the default for most users as of
// mid-2026) merge spot and perps USDC into one pool — for those accounts, the perps-specific
// clearinghouseState can legitimately report ~$0 even with real tradeable balance sitting there,
// because the true balance lives in the spot clearinghouse state instead (Hyperliquid's own docs:
// "unified account and portfolio margin show all balances... in the spot clearinghouse state").
// Standard/Manual-mode accounts still have genuinely separate balances. Rather than assume either,
// resolve whichever endpoint actually reflects real balance.
async function getEffectiveEquity(){
  if(!HL_ACCOUNT_ADDRESS) return { effectiveEquity: null, perpEquity: null, spotUsdc: null, perpState: null, perpFetchFailed: false, spotFetchFailed: false };
  let perpFetchFailed = false;
  const [perpState, spotUsdc] = await Promise.all([
    infoPost({ type: 'clearinghouseState', user: HL_ACCOUNT_ADDRESS }).catch((e) => { console.error('clearinghouseState fetch failed:', e.message); perpFetchFailed = true; return null; }),
    getSpotUsdcBalance()
  ]);
  const spotFetchFailed = spotUsdc === null;
  const perpEquity = perpState ? (parseFloat((perpState.marginSummary || {}).accountValue) || 0) : 0;
  const effectiveEquity = Math.max(perpEquity, spotUsdc || 0);
  console.log(`Account snapshot: perpEquity=$${perpEquity.toFixed(2)}${perpFetchFailed ? ' (FETCH FAILED, defaulted to 0)' : ''}, spotUsdc=$${(spotUsdc||0).toFixed(2)}${spotFetchFailed ? ' (FETCH FAILED, defaulted to 0)' : ''}, effectiveEquity=$${effectiveEquity.toFixed(2)}`);
  return { effectiveEquity, perpEquity, spotUsdc, perpState, perpFetchFailed, spotFetchFailed };
}

async function getAccountEquity(){
  const { effectiveEquity } = await getEffectiveEquity();
  return effectiveEquity || null;
}

// ---------------- Circuit breaker: suspend trading + close everything on a severe drawdown ----------------
function loadCircuitBreakerState(){
  return readJson(CIRCUIT_BREAKER_PATH, { tripped: false, trippedAt: null, reason: null, equityHistory: [] });
}
function saveCircuitBreakerState(cb){ writeJson(CIRCUIT_BREAKER_PATH, cb); }

// Records the current equity as a timestamped sample (used to build the rolling 24h baseline)
// and checks for a sustained drawdown — comparing against the equity from ~24h ago specifically,
// not "since the bot started" or "since midnight", so normal position volatility over minutes or
// hours doesn't false-trigger; only a genuine decline sustained across a full day does.
async function recordEquityAndCheckDrawdown(){
  const { effectiveEquity } = await getEffectiveEquity();
  const cb = loadCircuitBreakerState();
  if(effectiveEquity == null) return cb; // couldn't read equity this run — don't record a bad sample

  const now = Date.now();
  cb.equityHistory = (cb.equityHistory || []).concat([{ t: now, equity: effectiveEquity }]);
  // Prune anything older than 48h — we only ever need up to a 24h-old baseline, a second day of
  // slack covers any gap in scheduled runs without the file growing indefinitely.
  const cutoff = now - 48 * 60 * 60 * 1000;
  cb.equityHistory = cb.equityHistory.filter(s => s.t >= cutoff);

  if(cb.tripped){ saveCircuitBreakerState(cb); return cb; } // already tripped, no need to re-check

  const dayAgo = now - 24 * 60 * 60 * 1000;
  const baselineCandidates = cb.equityHistory.filter(s => s.t <= dayAgo);
  if(!baselineCandidates.length){ saveCircuitBreakerState(cb); return cb; } // not enough history yet
  const baseline = baselineCandidates[baselineCandidates.length - 1]; // closest sample to exactly 24h old

  if(baseline.equity > 0){
    const drawdownPct = (baseline.equity - effectiveEquity) / baseline.equity * 100;
    if(drawdownPct >= CIRCUIT_BREAKER_DRAWDOWN_PCT){
      cb.tripped = true;
      cb.trippedAt = new Date(now).toISOString();
      cb.reason = `Equity dropped ${drawdownPct.toFixed(1)}% in 24h ($${baseline.equity.toFixed(2)} → $${effectiveEquity.toFixed(2)}), at or beyond the ${CIRCUIT_BREAKER_DRAWDOWN_PCT}% threshold.`;
    }
  }
  saveCircuitBreakerState(cb);
  return cb;
}

// Cancels every resting order and closes every open position with an aggressive IOC order —
// used only when the circuit breaker actually trips. Best-effort: keeps going even if an
// individual order fails, and reports exactly what succeeded/failed rather than assuming.
async function closeEverythingAndCancelAll(){
  const results = { closedPositions: [], failedPositions: [], cancelledOrders: 0, failedCancels: 0 };
  let sdk;
  try{
    sdk = await buildExecutionSdk();
  }catch(e){
    results.failedPositions.push('Could not initialize execution SDK: ' + e.message);
    return results;
  }
  try{
    const state = await infoPost({ type: 'clearinghouseState', user: HL_ACCOUNT_ADDRESS });
    const openPositions = (state.assetPositions || []).filter(p => parseFloat(p.position.szi) !== 0);
    for(const p of openPositions){
      const coin = p.position.coin;
      const szi = parseFloat(p.position.szi);
      const isBuy = szi < 0; // close a short by buying, a long by selling
      try{
        const mid = await getCurrentMid(coin);
        const slippage = 0.05; // wider band than normal — urgency matters more than price here
        const limitPx = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
        const szDecimals = await getSzDecimals(coin);
        await sdk.exchange.placeOrder({
          coin: coin + '-PERP', is_buy: isBuy, sz: Math.abs(szi),
          limit_px: formatHlPrice(limitPx, szDecimals),
          order_type: { limit: { tif: 'Ioc' } }, reduce_only: true
        });
        results.closedPositions.push(coin);
      }catch(e){ results.failedPositions.push(coin + ': ' + e.message); }
    }
  }catch(e){ results.failedPositions.push('Could not read positions: ' + e.message); }

  try{
    const openOrders = await infoPost({ type: 'openOrders', user: HL_ACCOUNT_ADDRESS });
    for(const o of (openOrders || [])){
      try{ await sdk.exchange.cancelOrder({ coin: o.coin, o: o.oid }); results.cancelledOrders++; }
      catch(e){ results.failedCancels++; }
    }
  }catch(e){ /* covered by failedCancels being 0 with no orders found — non-fatal */ }

  return results;
}

async function tripCircuitBreaker(cb, drawdownReason){
  console.error('CIRCUIT BREAKER TRIPPED: ' + drawdownReason);
  const closeResults = await closeEverythingAndCancelAll();
  const lines = [
    `🚨🚨 CIRCUIT BREAKER TRIPPED 🚨🚨`,
    ``,
    drawdownReason,
    ``,
    `• Positions closed: ${closeResults.closedPositions.length ? closeResults.closedPositions.join(', ') : 'none open'}`,
  ];
  if(closeResults.failedPositions.length) lines.push(`• Failed to close: ${closeResults.failedPositions.join('; ')}`);
  lines.push(`• Orders cancelled: ${closeResults.cancelledOrders}${closeResults.failedCancels ? ' (' + closeResults.failedCancels + ' failed to cancel)' : ''}`);
  lines.push(``);
  lines.push(`⚠ All automatic and manual trading is suspended — no new positions will open, confirmed or automatic, until this is manually reset from the dashboard. Review what happened before resuming.`);
  await tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: lines.join('\n') });
}

async function getAccountSnapshot(){
  if(!HL_ACCOUNT_ADDRESS) return '• Account address not configured.';
  const addrShort = HL_ACCOUNT_ADDRESS.length > 12
    ? HL_ACCOUNT_ADDRESS.slice(0,6) + '…' + HL_ACCOUNT_ADDRESS.slice(-4)
    : HL_ACCOUNT_ADDRESS;
  const queried = `${HL_EXEC_NETWORK}: ${addrShort}`;
  try{
    const { effectiveEquity, perpEquity, spotUsdc, perpState, perpFetchFailed, spotFetchFailed } = await getEffectiveEquity();
    const ms = (perpState && perpState.marginSummary) || {};
    const openPositions = perpState ? (perpState.assetPositions || []).filter(p => parseFloat(p.position.szi) !== 0).length : 0;
    const marginUsed = parseFloat(ms.totalMarginUsed);
    const withdrawable = perpState ? parseFloat(perpState.withdrawable) : null;
    const usingUnified = (spotUsdc || 0) > (perpEquity || 0);

    let lines = [
      `• Account value: $${effectiveEquity != null ? effectiveEquity.toFixed(2) : 'n/a'}${usingUnified ? ' (from Spot/unified balance)' : ''}`,
      `• Margin used: $${isFinite(marginUsed) ? marginUsed.toFixed(2) : '0.00'}`,
      `• Investable balance: $${(isFinite(withdrawable) && withdrawable > 0) ? withdrawable.toFixed(2) : (effectiveEquity != null ? effectiveEquity.toFixed(2) : 'n/a')}`,
      `• Open positions: ${openPositions}`,
      `• Queried: ${queried}`
    ];
    if(perpFetchFailed || spotFetchFailed){
      lines.push(`• ⚠ ${perpFetchFailed ? 'Perps' : 'Spot'} balance check failed to fetch this time — if the value above looks too low, this is likely why. Should self-correct next time it's checked.`);
    }
    if(usingUnified){
      lines.push(`• Perps-specific state showed $0, but Spot/unified USDC balance is $${spotUsdc.toFixed(2)} — using that as your account value. This is expected on Hyperliquid's Unified Account mode, not an error.`);
    } else if(!effectiveEquity){
      lines.push('• No funds found for this address. Double-check HL_ACCOUNT_ADDRESS is where you actually deposited/faucet\'d, and that HL_EXEC_NETWORK matches that network.');
    }
    return lines.join('\n');
  }catch(e){
    return `• Could not fetch account stats: ${e.message}\n• Queried: ${queried}`;
  }
}

function describeOrderResult(result, labels){
  try{
    // Top-level rejection shape: {status:'err', response:'<message>'} — must be reported as a
    // failure rather than falling through to "format not recognized".
    if(result && result.status === 'err'){
      const msg = typeof result.response === 'string' ? result.response : JSON.stringify(result.response);
      return ['• ORDER REJECTED — ' + msg];
    }
    const statuses = result && result.response && result.response.data && result.response.data.statuses;
    if(!Array.isArray(statuses)){
      return ['• Order response format not recognized — raw: ' + JSON.stringify(result).slice(0,200)];
    }
    return statuses.map((s, i) => {
      const label = labels[i] || ('Order ' + (i+1));
      if(s.error) return `• ${label}: ERROR — ${s.error}`;
      if(s.filled) return `• ${label}: FILLED ${s.filled.totalSz} @ $${s.filled.avgPx}`;
      if(s.resting) return `• ${label}: resting (order id ${s.resting.oid})`;
      return `• ${label}: ${JSON.stringify(s)}`;
    });
  }catch(e){
    return ['• Could not parse order result: ' + e.message];
  }
}

async function executeTrade(rec){
  if(!HL_AGENT_PRIVATE_KEY || !HL_ACCOUNT_ADDRESS){
    throw new Error('Execution key not configured (HL_AGENT_PRIVATE_KEY / HL_ACCOUNT_ADDRESS missing)');
  }

  // Defense in depth: generation-time validation stops new malformed recs, but an old one
  // created before that fix (or corrupted in storage) could still be sitting in the feed with
  // active Confirm/Deny buttons. Catch it here, clearly, before it ever reaches Hyperliquid as
  // "Unknown asset: undefined" — which is what a missing/undefined coin actually looks like once
  // it's been concatenated into an asset name and sent to the exchange.
  if(!rec || typeof rec.coin !== 'string' || !rec.coin.trim()){
    throw new Error('This recommendation is missing a valid coin — likely a stale/corrupted entry from before a recent fix. Deny it and dismiss it; it cannot be executed.');
  }
  if(rec.direction !== 'long' && rec.direction !== 'short'){
    throw new Error('This recommendation has an invalid direction ("' + rec.direction + '") — likely a stale/corrupted entry. Deny it and dismiss it.');
  }
  if(!isFinite(rec.entry_price) || rec.entry_price <= 0 || !isFinite(rec.stop_loss_price) || rec.stop_loss_price <= 0){
    throw new Error('This recommendation has invalid entry/stop prices — likely a stale/corrupted entry. Deny it and dismiss it.');
  }

  const currentMid = await getCurrentMid(rec.coin);
  if(!currentMid) throw new Error('No live price available for ' + rec.coin);

  const driftPct = Math.abs(currentMid - rec.entry_price) / rec.entry_price * 100;
  if(driftPct > MAX_ENTRY_DEVIATION_PCT){
    throw new Error(`Price moved ${driftPct.toFixed(2)}% since the recommendation (>${MAX_ENTRY_DEVIATION_PCT}% max entry deviation) — skipped for safety`);
  }

  const isBuy = rec.direction !== 'short';
  if(isBuy && !(rec.stop_loss_price < currentMid)) throw new Error('Stop-loss is no longer below current price — thesis looks invalidated');
  if(!isBuy && !(rec.stop_loss_price > currentMid)) throw new Error('Stop-loss is no longer above current price — thesis looks invalidated');

  const stopDistPct = Math.abs(currentMid - rec.stop_loss_price) / currentMid * 100;
  if(stopDistPct > MAX_STOP_LOSS_PCT){
    throw new Error(`Stop-loss is ${stopDistPct.toFixed(1)}% from price, exceeds your max stop-loss distance (${MAX_STOP_LOSS_PCT}%) — skipped for safety`);
  }

  if(rec.take_profit_price){
    const tpDistPct = Math.abs(currentMid - rec.take_profit_price) / currentMid * 100;
    if(tpDistPct > MAX_TAKE_PROFIT_PCT){
      throw new Error(`Take-profit is ${tpDistPct.toFixed(1)}% from price, exceeds your max take-profit distance (${MAX_TAKE_PROFIT_PCT}%) — skipped for safety`);
    }
  }

  const equity = await getAccountEquity();
  if(!equity){
    const addrShort = HL_ACCOUNT_ADDRESS ? HL_ACCOUNT_ADDRESS.slice(0,6) + '…' + HL_ACCOUNT_ADDRESS.slice(-4) : '(not set)';
    throw new Error(`No usable balance found (checked both Perps and Spot/unified) on ${HL_EXEC_NETWORK} for ${addrShort} — check HL_EXEC_NETWORK matches the network your funds are on, and that HL_ACCOUNT_ADDRESS is your main wallet, not the agent wallet.`);
  }

  let pctEquity = Math.min(rec.suggested_size_pct_equity || MAX_POSITION_PCT, MAX_POSITION_PCT);
  const leverage = Math.min(rec.suggested_leverage || 1, MAX_LEVERAGE);
  let notional = equity * (pctEquity / 100);
  let sizeBumped = false;
  let exceedsPositionCap = false;
  if(notional < MIN_ORDER_NOTIONAL){
    if(equity < MIN_ORDER_NOTIONAL){
      throw new Error(`Account equity ($${equity.toFixed(2)}) is below Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum order value — no position size is possible on this account right now.`);
    }
    notional = MIN_ORDER_NOTIONAL;
    const bumpedPct = (MIN_ORDER_NOTIONAL / equity) * 100;
    exceedsPositionCap = bumpedPct > MAX_POSITION_PCT + 0.01;
    pctEquity = bumpedPct; // keep reported %/margin figures consistent with the actual notional used
    sizeBumped = true;
  }
  const size = notional / currentMid;
  if(!size || size <= 0) throw new Error('Computed size was zero — check account equity and risk settings');

  const szDecimals = await getSzDecimals(rec.coin);
  if(szDecimals === undefined){
    // getSzDecimals returns undefined specifically when the coin isn't found in Hyperliquid's
    // current asset universe — meaning the AI (or a stale rec) used a name Hyperliquid doesn't
    // actually recognize. Sending this through anyway is exactly what produces "Unknown asset:
    // undefined" from the exchange: the SDK's internal name-to-index lookup fails, and the
    // resulting undefined index is what that error message is actually reporting — not a
    // problem with rec.coin being missing, which the earlier checks already ruled out.
    throw new Error(`"${rec.coin}" is not a recognized Hyperliquid asset (checked against the live asset list) — the AI may have used an incorrect, outdated, or delisted symbol. This trade cannot be executed.`);
  }
  const slippage = 0.03;
  const entryPx = formatHlPrice(isBuy ? currentMid * (1 + slippage) : currentMid * (1 - slippage), szDecimals);
  const stopPx = formatHlPrice(rec.stop_loss_price, szDecimals);
  const roundedSize = formatHlSize(size, szDecimals);

  const orders = [{
    coin: rec.coin + '-PERP', is_buy: isBuy, sz: roundedSize,
    limit_px: entryPx, order_type: { limit: { tif: 'Ioc' } }, reduce_only: false
  }, {
    coin: rec.coin + '-PERP', is_buy: !isBuy, sz: roundedSize,
    limit_px: stopPx,
    order_type: { trigger: { isMarket: true, triggerPx: String(stopPx), tpsl: 'sl' } }, reduce_only: true
  }];
  if(rec.take_profit_price){
    const tpPx = formatHlPrice(rec.take_profit_price, szDecimals);
    orders.push({
      coin: rec.coin + '-PERP', is_buy: !isBuy, sz: roundedSize,
      limit_px: tpPx,
      order_type: { trigger: { isMarket: true, triggerPx: String(tpPx), tpsl: 'tp' } }, reduce_only: true
    });
  } else if(DEFAULT_TAKE_PROFIT_PCT){
    const mult = 1 + (DEFAULT_TAKE_PROFIT_PCT/100) * (isBuy ? 1 : -1);
    const tpPx = formatHlPrice(currentMid * mult, szDecimals);
    orders.push({
      coin: rec.coin + '-PERP', is_buy: !isBuy, sz: roundedSize,
      limit_px: tpPx,
      order_type: { trigger: { isMarket: true, triggerPx: String(tpPx), tpsl: 'tp' } }, reduce_only: true
    });
    rec.take_profit_price = tpPx;
  }

  const sdk = await buildExecutionSdk();

  let result;
  try{
    result = await sdk.exchange.placeOrder({ orders, grouping: 'normalTpsl', vaultAddress: null });
  }catch(sdkError){
    // Self-healing: if this is specifically the asset-index resolution failure, force a fresh
    // refresh of the SDK's internal symbol-conversion cache and retry once, right at the point
    // of failure — regardless of whether the exact refresh method needed matches what
    // buildExecutionSdk() already tried, this retries in the most direct context possible.
    if(String(sdkError.message || '').includes('Unknown asset')){
      if(typeof sdk.connect === 'function') await sdk.connect();
      if(typeof sdk.refreshAssetMapsNow === 'function') await sdk.refreshAssetMapsNow();
      else if(sdk.info && sdk.info.perpetuals) await sdk.info.perpetuals.getMeta();
      result = await sdk.exchange.placeOrder({ orders, grouping: 'normalTpsl', vaultAddress: null });
    } else {
      throw sdkError;
    }
  }
  // A top-level {status:'err'} means the whole request was rejected (e.g. "Vault not
  // registered") — throw so it's reported as a failure rather than a successful execution.
  if(result && result.status === 'err'){
    throw new Error(typeof result.response === 'string' ? result.response : JSON.stringify(result.response));
  }
  return { result, size, entryPx, leverage, pctEquity, sizeBumped, exceedsPositionCap };
}

async function executeAndReport(rec, labelPrefix){
  const cb = loadCircuitBreakerState();
  if(cb.tripped){
    rec.status = 'denied';
    rec.error = 'Blocked by circuit breaker';
    await editStatusMessage(rec, `🚨 ${rec.coin} ${rec.direction} — blocked. The circuit breaker is tripped (${cb.reason || 'severe drawdown detected'}) and all trading is suspended until manually reset from the dashboard.`);
    return;
  }
  rec.status = 'processing';
  await editStatusMessage(rec, `⏳ ${rec.coin} ${rec.direction} — ${labelPrefix}, checking current price and risk limits before placing…`);
  try{
    const { size, entryPx, leverage, pctEquity, sizeBumped, exceedsPositionCap, result } = await executeTrade(rec);
    rec.status = 'executed';
    rec.executed_at = new Date().toISOString();

    const labels = ['Entry', 'Stop-loss'].concat(rec.take_profit_price ? ['Take-profit'] : []);
    const fillLines = describeOrderResult(result, labels).join('\n');
    const snapshot = await getAccountSnapshot();
    const bumpNote = sizeBumped
      ? (exceedsPositionCap
          ? `\n• Note: size increased to meet Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum — this exceeds your configured max position size (${MAX_POSITION_PCT}%); this account may be too small for your risk settings`
          : `\n• Note: size increased to meet Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum order value`)
      : '';

    await editStatusMessage(rec,
      `✅ ${rec.coin} ${rec.direction} — executed on ${HL_EXEC_NETWORK}\n\n`
      + `• Target size: ${size.toFixed(5)} @ ~$${entryPx.toFixed(2)}\n`
      + `• Leverage: ${leverage}x (${pctEquity.toFixed(1)}% of equity)${bumpNote}\n`
      + `${fillLines}\n\n`
      + `${snapshot}`
    );
  }catch(e){
    rec.status = 'failed';
    rec.error = e.message;
    const snapshot = await getAccountSnapshot();
    await editStatusMessage(rec,
      `⚠ ${rec.coin} ${rec.direction} — execution failed\n\n`
      + `• Reason: ${e.message}\n\n`
      + `${snapshot}`
    );
  }
}

async function handleCallback(cb, feed){
  const fromId = String(cb.from && cb.from.id);
  const [action, id] = String(cb.data || '').split(':');
  let rec = null;

  try{
    if(fromId !== TELEGRAM_CHAT_ID){
      console.warn('Ignoring callback from unauthorized chat id:', fromId);
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not authorized.', show_alert: true });
      return;
    }

    rec = findRec(feed, id);
    if(!rec || rec.status !== 'pending'){
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already handled or expired.' });
      return;
    }

    if(Date.now() > new Date(rec.expires_at).getTime()){
      rec.status = 'expired';
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'This recommendation has expired.' });
      await editStatusMessage(rec, `⏰ ${rec.coin} ${rec.direction} — expired before you responded.`);
      return;
    }

    if(action === 'deny'){
      rec.status = 'denied';
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: rec.auto_trade ? 'Cancelled.' : 'Denied.' });
      await editStatusMessage(rec, rec.auto_trade
        ? `❌ ${rec.coin} ${rec.direction} — auto-trade cancelled by you before it executed.`
        : `❌ ${rec.coin} ${rec.direction} — denied.`);
      return;
    }

    if(action === 'confirm'){
      // Acknowledge immediately so a tap is never left wondering whether it registered —
      // execution (price re-check, sizing, the actual order) happens after this.
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Got it — checking price and risk limits…' });
      await executeAndReport(rec, 'confirmed');
    }
  }catch(outerErr){
    // Last-resort safety net: whatever went wrong, however unexpected, the person should never
    // see silence. Report it as a brand-new message rather than risk another failed edit.
    console.error('Unhandled error in handleCallback:', outerErr.message);
    try{
      await tg('sendMessage', {
        chat_id: TELEGRAM_CHAT_ID,
        text: `⚠ Something went wrong processing your ${action || 'response'} for recommendation ${id || '(unknown)'}: ${outerErr.message}\n\nCheck the "Trade Agent Telegram Poller" workflow logs on GitHub for details. No trade was placed if this happened before order submission.`
      });
    }catch(e2){ console.error('Even the fallback error message failed to send:', e2.message); }
  }
}

async function autoTradeSweep(feed){
  const now = Date.now();
  for(const rec of (feed.recommendations || [])){
    if(rec.status !== 'pending' || !rec.auto_trade) continue;
    if(now > new Date(rec.expires_at).getTime()){
      rec.status = 'expired';
      await editStatusMessage(rec, `⏰ ${rec.coin} ${rec.direction} — expired before auto-trade executed.`);
      continue;
    }
    console.log(`Auto-trade sweep: executing ${rec.coin} ${rec.direction} (id ${rec.id})`);
    await executeAndReport(rec, 'auto-trade');
  }
}

async function sweepExpired(feed){
  const now = Date.now();
  for(const rec of (feed.recommendations || [])){
    if(rec.status === 'pending' && rec.expires_at && now > new Date(rec.expires_at).getTime()){
      rec.status = 'expired';
      await editStatusMessage(rec, `⏰ ${rec.coin} ${rec.direction} — expired, no response in time.`);
    }
  }
}

async function main(){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){ console.log('Telegram not configured, exiting.'); return; }
  loadSharedConfig();

  // Circuit breaker check runs first, every cycle, regardless of anything else — if a genuine
  // 24h drawdown is detected right now, everything gets closed and cancelled immediately rather
  // than waiting for the rest of this run's normal flow.
  if(HL_ACCOUNT_ADDRESS){
    const cbBefore = loadCircuitBreakerState();
    const wasTripped = cbBefore.tripped;
    const cbAfter = await recordEquityAndCheckDrawdown();
    if(cbAfter.tripped && !wasTripped){
      await tripCircuitBreaker(cbAfter, cbAfter.reason);
    }
  }

  let offsetState = readJson(OFFSET_PATH, { offset: 0 });
  const feed = readJson(FEED_PATH, { recommendations: [] });

  await sweepExpired(feed);

  // Auto-trade sweep now runs immediately, before the confirm/deny polling loop below --
  // deliberately removing what used to be a ~2.5-minute Cancel window, per explicit
  // confirmation that speed matters more here than a chance to stop it. The polling loop
  // afterward still exists and is still needed: it's how a *manually*-confirmable
  // recommendation (anything that didn't qualify for auto-trade) gets its Confirm/Deny tap
  // processed -- this reordering only removes the wait specifically for auto-trade.
  await autoTradeSweep(feed);
  writeJson(FEED_PATH, feed);

  const start = Date.now();
  while(Date.now() - start < POLL_BUDGET_MS){
    const remaining = POLL_BUDGET_MS - (Date.now() - start);
    const timeout = Math.max(1, Math.min(25, Math.floor(remaining / 1000) - 1));
    if(timeout <= 1) break;

    let updates;
    try{
      updates = await tg('getUpdates', { offset: offsetState.offset, timeout, allowed_updates: ['callback_query'] });
    }catch(e){ console.error('getUpdates failed:', e.message); break; }

    if(updates.ok && updates.result && updates.result.length){
      for(const upd of updates.result){
        offsetState.offset = upd.update_id + 1;
        if(upd.callback_query){
          try{ await handleCallback(upd.callback_query, feed); }
          catch(e){ console.error('Error handling callback:', e.message); }
        }
      }
      writeJson(OFFSET_PATH, offsetState);
      writeJson(FEED_PATH, feed);
    }
  }

  writeJson(OFFSET_PATH, offsetState);
  writeJson(FEED_PATH, feed);

  console.log('Poll cycle complete.');
}

main().then(() => {
  // Explicit exit, matching the failure path below — without this, a lingering timer left
  // running internally by the SDK (its own docs mention an automatic 60-second background
  // refresh of its symbol-conversion cache) can keep Node's event loop alive indefinitely even
  // after all of our own work is genuinely done, leaving the job running until GitHub's job
  // timeout eventually kills it.
  process.exit(0);
}).catch(async e => {
  console.error('Poller failed:', e);
  if(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID){
    try{
      await tg('sendMessage', {
        chat_id: TELEGRAM_CHAT_ID,
        text: `⚠ The Telegram poller crashed this run: ${e.message}\n\nAny pending confirm/deny taps from this cycle were not processed — they'll be picked up on the next run if still within their expiry window. Check the "Trade Agent Telegram Poller" workflow logs on GitHub.`
      });
    }catch(e2){ console.error('Could not send crash notification:', e2.message); }
  }
  process.exit(1);
});
