// JARVIS Trade Agent — backend scanner
//
// Technical checks (order-book/volume signals, multi-timeframe alignment) run every scheduled
// run, unconditionally — they're free. Whether Anthropic gets called on top of that is controlled
// independently by AI_RESEARCH_ENABLED (a toggle) and, when enabled, a cooldown that throttles how
// often the paid call fires. Turn AI research off entirely to run on technicals-only ideas forever.
//
// This script NEVER touches a Hyperliquid private key and NEVER places trades.
// It only researches and alerts (Telegram + a JSON feed the dashboard reads).
// Trade execution stays manual, in the dashboard, exactly as before.

const fs = require('fs');
const path = require('path');

const HL_NETWORK = (process.env.HL_NETWORK || 'mainnet').toLowerCase();
// Separate from HL_NETWORK on purpose: HL_NETWORK is for market data (candles, signals) — you
// want real mainnet liquidity for that regardless of where your actual account lives. Account
// equity/positions must be queried against whichever network the funded account is actually
// on, same as poll_telegram.js's HL_EXEC_NETWORK. Mixing these up means checking equity on the
// wrong network entirely, silently, with no error — exactly what happened before this was split out.
const HL_EXEC_NETWORK = (process.env.HL_EXEC_NETWORK || 'testnet').toLowerCase();
const EXEC_INFO_URL = HL_EXEC_NETWORK === 'mainnet' ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info';

function hyperliquidChartUrl(coin){
  // Always mainnet — the real, liquid chart is what's actually useful to look at, regardless
  // of which network the scan or execution is running on.
  return `https://app.hyperliquid.xyz/trade/${coin}`;
}
const INFO_URL = HL_NETWORK === 'testnet' ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info';
const WATCHLIST_DEFAULT = (process.env.WATCHLIST || 'BTC,ETH,SOL,HYPE').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
let WATCHLIST = WATCHLIST_DEFAULT;
let SCAN_MODE = (process.env.SCAN_MODE || 'watchlist').toLowerCase();
let FILTERED_TOP_N = parseInt(process.env.FILTERED_TOP_N || '20', 10);
let FILTERED_MIN_OI = parseFloat(process.env.FILTERED_MIN_OI || '1000000');
let FILTERED_MIN_VOLUME_24H = parseFloat(process.env.FILTERED_MIN_VOLUME_24H || '2000000');
const SENSITIVITY = (process.env.SIGNAL_SENSITIVITY || 'medium').toLowerCase();
const INTERVAL_MIN = parseFloat(process.env.AUTO_SCAN_INTERVAL_MIN || '30');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Optional — just the public wallet address (same one used for HL_ACCOUNT_ADDRESS in the poller),
// used only to read equity for a funds-required estimate in the message. Never a private key.
const HL_ACCOUNT_ADDRESS = process.env.HL_ACCOUNT_ADDRESS || '';
const EXECUTION_WINDOW_MIN = parseFloat(process.env.EXECUTION_WINDOW_MIN || '180');
let MAX_STOP_LOSS_PCT = parseFloat(process.env.MAX_STOP_LOSS_PCT || '5');
let MAX_TAKE_PROFIT_PCT = parseFloat(process.env.MAX_TAKE_PROFIT_PCT || '15');
let MAX_ENTRY_DEVIATION_PCT = parseFloat(process.env.MAX_ENTRY_DEVIATION_PCT || '2');
const MIN_ORDER_NOTIONAL = 10; // Hyperliquid rejects any order below $10 notional, exchange-wide
let MAX_RECS_PER_SCAN = parseFloat(process.env.MAX_RECS_PER_SCAN || '1'); // keep only the top-N by confidence, even if more candidates qualify
const AUTO_TRADE_MIN_SCORE = 6; // out of 8 — only the #1-ranked rec, and only at/above this score, auto-executes
// Lower-confidence auto-trades risk less capital, scaled by score. This scales position SIZE
// specifically, not leverage — the dollar amount actually at risk if a stop is hit is driven by
// notional size, not leverage (leverage only changes how much margin is tied up for the same
// notional, not the loss at the stop price), so size is the correct thing to scale down for a
// less-confident idea.
const AUTO_TRADE_SIZE_SCALE_BY_SCORE = { 6: 0.5, 7: 0.75, 8: 1.0 };
let MAX_POSITION_PCT = parseFloat(process.env.MAX_POSITION_PCT || '5');
let MAX_LEVERAGE = parseFloat(process.env.MAX_LEVERAGE || '3');
let DEFAULT_TAKE_PROFIT_PCT = parseFloat(process.env.DEFAULT_TAKE_PROFIT_PCT || '3');
let AI_RESEARCH_ENABLED = (process.env.AI_RESEARCH_ENABLED || 'true').toLowerCase() !== 'false';
let AUTO_TRADE_ENABLED = (process.env.AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';

function shortId(){
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

const STATE_PATH = path.join(__dirname, 'state.json');
const FEED_PATH = path.join(__dirname, '..', 'docs', 'recommendations.json');
const CIRCUIT_BREAKER_PATH = path.join(__dirname, '..', 'docs', 'circuit_breaker.json');
const CHARTS_DIR = path.join(__dirname, '..', 'docs', 'charts');
const SHARED_CONFIG_PATH = path.join(__dirname, '..', 'docs', 'agent-config.json');

function loadSharedConfig(){
  const shared = readJson(SHARED_CONFIG_PATH, null);
  if(!shared){ console.log('No agent-config.json from the dashboard yet — using repo Variable defaults.'); return null; }
  console.log('Using dashboard-published config (last updated ' + (shared.updated_at || 'unknown') + ')');
  return shared;
}

const SIGNAL_THRESHOLDS = {
  low:    { volRatio: 4.0, imbalance: 0.50 },
  medium: { volRatio: 2.5, imbalance: 0.30 },
  high:   { volRatio: 1.5, imbalance: 0.15 }
};
const INTERVAL_MS_5M = 5 * 60 * 1000;

function readJson(p, fallback){
  try{ return JSON.parse(fs.readFileSync(p, 'utf8')); }catch(e){ return fallback; }
}
function writeJson(p, obj){
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function infoPost(body){
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error('info ' + body.type + ' HTTP ' + res.status);
  return res.json();
}

// Always hits HL_EXEC_NETWORK, never HL_NETWORK — for account/equity/position queries only.
async function execInfoPost(body){
  const res = await fetch(EXEC_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error('exec info ' + body.type + ' HTTP ' + res.status);
  return res.json();
}

// Same unified-account-aware resolution as the poller: on Hyperliquid's Unified Account mode
// (default for most users), the perps-specific endpoint can read $0 even with real balance —
// the real number lives in the spot/unified endpoint instead. This is only used for the
// funds-required estimate shown in the message; execution always re-checks live equity itself.
async function loadAccountSnapshot(){
  if(!HL_ACCOUNT_ADDRESS) return { effectiveEquity: null, openPositionCoins: new Set(), perpFetchFailed: false, spotFetchFailed: false };
  try{
    let perpFetchFailed = false, spotFetchFailed = false;
    const [perpState, spotState] = await Promise.all([
      execInfoPost({ type: 'clearinghouseState', user: HL_ACCOUNT_ADDRESS }).catch((e) => { console.error('clearinghouseState fetch failed:', e.message); perpFetchFailed = true; return null; }),
      execInfoPost({ type: 'spotClearinghouseState', user: HL_ACCOUNT_ADDRESS }).catch((e) => { console.error('spotClearinghouseState fetch failed:', e.message); spotFetchFailed = true; return null; })
    ]);
    const perpEquity = perpState ? (parseFloat((perpState.marginSummary || {}).accountValue) || 0) : 0;
    const spotUsdc = spotState ? (parseFloat(((spotState.balances || []).find(b => b.coin === 'USDC') || {}).total) || 0) : 0;
    const effectiveEquity = Math.max(perpEquity, spotUsdc);
    console.log(`Account snapshot (queried on ${HL_EXEC_NETWORK}): perpEquity=$${perpEquity.toFixed(2)}${perpFetchFailed ? ' (FETCH FAILED, defaulted to 0)' : ''}, spotUsdc=$${spotUsdc.toFixed(2)}${spotFetchFailed ? ' (FETCH FAILED, defaulted to 0)' : ''}, effectiveEquity=$${effectiveEquity.toFixed(2)}`);
    const openPositionCoins = new Set(
      perpState ? (perpState.assetPositions || [])
        .filter(p => parseFloat(p.position.szi) !== 0)
        .map(p => p.position.coin)
        : []
    );
    return { effectiveEquity, openPositionCoins, perpEquity, spotUsdc, perpFetchFailed, spotFetchFailed };
  }catch(e){
    console.error('loadAccountSnapshot failed entirely:', e.message);
    return { effectiveEquity: null, openPositionCoins: new Set(), perpFetchFailed: true, spotFetchFailed: true };
  }
}

async function loadMarketContext(coins){
  const data = await infoPost({ type: 'metaAndAssetCtxs' });
  const meta = data[0], ctxs = data[1];
  const rows = [];
  meta.universe.forEach((u, idx) => {
    if(!coins.includes(u.name)) return;
    const ctx = ctxs[idx];
    if(!ctx) return;
    const mark = parseFloat(ctx.markPx);
    const prevDay = parseFloat(ctx.prevDayPx);
    const chg24h = prevDay ? ((mark - prevDay) / prevDay * 100) : 0;
    rows.push({
      coin: u.name, markPx: mark, chg24hPct: chg24h,
      funding: parseFloat(ctx.funding), openInterest: parseFloat(ctx.openInterest)
    });
  });
  return rows;
}

async function loadFilteredUniverse(){
  const data = await infoPost({ type: 'metaAndAssetCtxs' });
  const meta = data[0], ctxs = data[1];
  const rows = [];
  meta.universe.forEach((u, idx) => {
    if(u.isDelisted) return;
    const ctx = ctxs[idx];
    if(!ctx) return;
    const mark = parseFloat(ctx.markPx);
    const oiNotional = parseFloat(ctx.openInterest) * mark;
    const vol24h = parseFloat(ctx.dayNtlVlm);
    if(oiNotional >= FILTERED_MIN_OI && vol24h >= FILTERED_MIN_VOLUME_24H){
      rows.push({ coin: u.name, oiNotional, vol24h });
    }
  });
  rows.sort((a,b) => b.vol24h - a.vol24h);
  return rows.slice(0, FILTERED_TOP_N).map(r => r.coin);
}

async function resolveCoins(){
  if(SCAN_MODE === 'filtered') return loadFilteredUniverse();

  // Unlike filtered mode (which only ever sees genuinely perp-listed coins, since
  // metaAndAssetCtxs is documented as perps-only), the watchlist is just a comma-separated
  // string typed by hand — nothing stops it from containing a typo, a delisted symbol, or a
  // spot-only token (Hyperliquid's own PURR, for instance, has no perpetual market at all).
  // Catching that here, before it burns a full scan cycle, is better than only catching it at
  // execution time.
  try{
    const meta = await infoPost({ type: 'meta' });
    const validPerps = new Set((meta.universe || []).filter(u => !u.isDelisted).map(u => u.name));
    const valid = WATCHLIST.filter(c => validPerps.has(c));
    const invalid = WATCHLIST.filter(c => !validPerps.has(c));
    if(invalid.length){
      console.error(`Watchlist contains symbol(s) with no live Hyperliquid perpetual market — skipping: ${invalid.join(', ')}. Check for typos, delistings, or spot-only tokens (e.g. PURR has no perp market at all).`);
    }
    return valid;
  }catch(e){
    console.error('Could not validate watchlist against live perps universe (' + e.message + ') — proceeding unvalidated; a bad symbol would still be caught at execution time.');
    return WATCHLIST;
  }
}

function sma(arr, period){
  if(arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a,b)=>a+b, 0) / period;
}

function stddev(arr, period){
  const slice = arr.slice(-period);
  if(slice.length < period) return null;
  const mean = slice.reduce((a,b)=>a+b, 0) / period;
  const variance = slice.reduce((a,b)=>a + (b-mean)*(b-mean), 0) / period;
  return Math.sqrt(variance);
}

function emaSeries(arr, period){
  const out = new Array(arr.length).fill(null);
  if(arr.length < period) return out;
  let prev = arr.slice(0, period).reduce((a,b)=>a+b, 0) / period;
  out[period-1] = prev;
  const k = 2 / (period + 1);
  for(let i = period; i < arr.length; i++){
    prev = arr[i]*k + prev*(1-k);
    out[i] = prev;
  }
  return out;
}

function computeRSI(closes, period){
  if(closes.length < period+1) return null;
  let gains = 0, losses = 0;
  for(let i = closes.length - period; i < closes.length; i++){
    const diff = closes[i] - closes[i-1];
    if(diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains/period, avgLoss = losses/period;
  if(avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100/(1+rs));
}

function macdCalc(closes){
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine = closes.map((_,i) => (ema12[i]!=null && ema26[i]!=null) ? ema12[i]-ema26[i] : null);
  const macdValues = macdLine.filter(v => v != null);
  const signalSeries = emaSeries(macdValues, 9);
  const macd = macdValues.length ? macdValues[macdValues.length-1] : null;
  const signal = signalSeries.length ? signalSeries[signalSeries.length-1] : null;
  return { macd, signal, hist: (macd!=null && signal!=null) ? macd-signal : null };
}

function body(o,c){ return Math.abs(c-o); }
function rng(h,l){ return (h-l) || 1e-9; }
function bull(o,c){ return c>o; }
function bear(o,c){ return c<o; }
function upW(o,h,c){ return h - Math.max(o,c); }
function loW(o,l,c){ return Math.min(o,c) - l; }
function trendBefore(closes, endIdxExclusive, lookback){
  const start = Math.max(0, endIdxExclusive - lookback);
  if(endIdxExclusive - start < 2) return 'flat';
  const first = closes[start], last = closes[endIdxExclusive-1];
  const chg = (last-first)/ (Math.abs(first)||1e-9);
  if(chg <= -0.003) return 'down';
  if(chg >= 0.003) return 'up';
  return 'flat';
}

function detectPatterns(opens, highs, lows, closes){
  const n = closes.length;
  if(n < 2) return [];
  const P = [];
  const idx = (k) => n-1-k;
  const O=i=>opens[i], C=i=>closes[i], H=i=>highs[i], L=i=>lows[i];

  const i1=idx(0);
  const o1=O(i1),c1=C(i1),h1=H(i1),l1=L(i1);
  const body1=body(o1,c1), range1=rng(h1,l1);
  const uw1=upW(o1,h1,c1), lw1=loW(o1,l1,c1);
  const trendPre1 = trendBefore(closes, i1, 5);

  // ---- Single candle ----
  if(body1/range1 < 0.1) P.push('doji');
  if(body1/range1 < 0.1 && lw1/range1 > 0.6 && uw1/range1 < 0.15) P.push('dragonfly_doji');
  if(body1/range1 < 0.1 && uw1/range1 > 0.6 && lw1/range1 < 0.15) P.push('gravestone_doji');
  if(lw1 >= 2*body1 && uw1 <= body1*0.5 && body1/range1 < 0.4 && trendPre1==='down') P.push('hammer');
  if(lw1 >= 2*body1 && uw1 <= body1*0.5 && body1/range1 < 0.4 && trendPre1==='up') P.push('hanging_man');
  if(uw1 >= 2*body1 && lw1 <= body1*0.5 && body1/range1 < 0.4 && trendPre1==='down') P.push('inverted_hammer');
  if(uw1 >= 2*body1 && lw1 <= body1*0.5 && body1/range1 < 0.4 && trendPre1==='up') P.push('shooting_star');
  if(bull(o1,c1) && body1/range1 > 0.7 && lw1/range1 < 0.05) P.push('bullish_belt_hold');
  if(bear(o1,c1) && body1/range1 > 0.7 && uw1/range1 < 0.05) P.push('bearish_belt_hold');

  // ---- Two candle ----
  if(n>=2){
    const i2=idx(1);
    const o2=O(i2),c2=C(i2),h2=H(i2),l2=L(i2);
    const body2=body(o2,c2), range2=rng(h2,l2);

    if(bear(o2,c2) && bull(o1,c1) && o1<=c2 && c1>=o2) P.push('bullish_engulfing');
    if(bull(o2,c2) && bear(o1,c1) && o1>=c2 && c1<=o2) P.push('bearish_engulfing');

    if(bear(o2,c2) && bull(o1,c1) && o1>c2 && c1<o2 && body1<body2){
      P.push(body1/range1 < 0.15 ? 'bullish_harami_cross' : 'bullish_harami');
    }
    if(bull(o2,c2) && bear(o1,c1) && o1<c2 && c1>o2 && body1<body2){
      P.push(body1/range1 < 0.15 ? 'bearish_harami_cross' : 'bearish_harami');
    }

    const mid2 = (o2+c2)/2;
    if(bear(o2,c2) && bull(o1,c1) && o1<l2 && c1>mid2 && c1<o2) P.push('piercing_line');
    if(bull(o2,c2) && bear(o1,c1) && o1>h2 && c1<mid2 && c1>o2) P.push('dark_cloud_cover');

    // Thrusting / on-neck / in-neck: bearish continuation, small bullish penetration into a
    // prior bearish candle that falls short of piercing_line's midpoint requirement.
    if(bear(o2,c2) && bull(o1,c1) && o1<c2 && c1<=mid2){
      const closeTol = range2*0.05;
      if(Math.abs(c1-l2) <= closeTol) P.push('on_neck');
      else if(Math.abs(c1-c2) <= closeTol) P.push('in_neck');
      else if(c1>c2) P.push('thrusting');
    }

    const marubozu2 = body2/range2 > 0.85;
    const marubozu1 = body1/range1 > 0.85;
    if(marubozu1 && marubozu2){
      if(bear(o2,c2) && bull(o1,c1) && o1>c2) P.push('bullish_kicking');
      if(bull(o2,c2) && bear(o1,c1) && o1<c2) P.push('bearish_kicking');
    }

    const closeTol1 = range1*0.05;
    if(bear(o2,c2) && bull(o1,c1) && Math.abs(c1-c2)<=closeTol1) P.push('bullish_meeting_lines');
    if(bull(o2,c2) && bear(o1,c1) && Math.abs(c1-c2)<=closeTol1) P.push('bearish_meeting_lines');
    if(bear(o2,c2) && bear(o1,c1) && Math.abs(c1-c2)<=closeTol1) P.push('matching_low');

    const openTol1 = range1*0.05;
    if(bear(o2,c2) && bull(o1,c1) && Math.abs(o1-o2)<=openTol1) P.push('bullish_separating_lines');
    if(bull(o2,c2) && bear(o1,c1) && Math.abs(o1-o2)<=openTol1) P.push('bearish_separating_lines');

    // Side-by-side lines: two same-colored candles after a gap in trend direction (approximate
    // "gap" as candle1 opening beyond candle2's body — true gaps are rare in continuous markets).
    if(bull(o2,c2) && bull(o1,c1) && o1>=c2 && Math.abs(o1-o2)<=openTol1) P.push('bullish_side_by_side_white_lines');
    if(bear(o2,c2) && bear(o1,c1) && o1<=c2 && Math.abs(o1-o2)<=openTol1) P.push('bearish_side_by_side_black_lines');
  }

  // ---- Three candle ----
  if(n >= 3){
    const iA=idx(2), iB=idx(1), iC=idx(0);
    const oA=O(iA),cA=C(iA),hA=H(iA),lA=L(iA);
    const oB=O(iB),cB=C(iB),hB=H(iB),lB=L(iB);
    const oC=O(iC),cC=C(iC),hC=H(iC),lC=L(iC);
    const bodyA=body(oA,cA), bodyB=body(oB,cB), bodyC=body(oC,cC);
    const rangeA=rng(hA,lA), rangeB=rng(hB,lB), rangeC=rng(hC,lC);
    const midA = (oA+cA)/2;

    if(cA>oA && cB>oB && cC>oC && cB>cA && cC>cB && oB>oA && oB<cA && oC>oB && oC<cB){
      P.push('three_white_soldiers');
      // Advance Block: three soldiers pattern but weakening — shrinking bodies / growing upper wicks.
      const uwB=upW(oB,hB,cB), uwC=upW(oC,hC,cC);
      if(bodyC<bodyB && bodyB<=bodyA*1.05 && uwC>uwB) P.push('advance_block');
      if(bodyC < bodyA*0.3 && bodyC/rangeC < 0.35) P.push('deliberation');
    }
    if(cA<oA && cB<oB && cC<oC && cB<cA && cC<cB && oB<oA && oB>cA && oC<oB && oC>cB){
      P.push('three_black_crows');
    }

    if(cA<oA && bodyA/rangeA>0.5 && bodyB/rangeB<0.3 && cC>oC && cC>midA && bodyC/rangeC>0.5){
      P.push('morning_star');
      if(bodyB/rangeB < 0.1) P.push('morning_doji_star');
      // Abandoned baby: like morning star, but the middle candle's whole range gaps clear of
      // both neighbors (approximated — real gaps are rare on a continuously-traded market).
      if(Math.max(hB,oB,cB) < lA && lC > Math.max(hB,oB,cB)){
        P.push('bullish_abandoned_baby');
      }
    }
    if(cA>oA && bodyA/rangeA>0.5 && bodyB/rangeB<0.3 && cC<oC && cC<midA && bodyC/rangeC>0.5){
      P.push('evening_star');
      if(bodyB/rangeB < 0.1) P.push('evening_doji_star');
      if(Math.min(lB,oB,cB) > hA && Math.min(lB,oB,cB) > hC){
        P.push('bearish_abandoned_baby');
      }
    }

    // Tri-star: three consecutive doji, middle one offset from the other two
    if(bodyA/rangeA<0.1 && bodyB/rangeB<0.1 && bodyC/rangeC<0.1){
      if((cB>Math.max(cA,oA) && cB>Math.max(cC,oC)) || (cB<Math.min(cA,oA) && cB<Math.min(cC,oC))){
        P.push('tri_star');
      }
    }

    // Three Inside Up/Down: harami (A,B) confirmed by C closing beyond A's open/close range
    if(bear(oA,cA) && bull(oB,cB) && oB>cA && cB<oA && bodyB<bodyA && cC>oA) P.push('three_inside_up');
    if(bull(oA,cA) && bear(oB,cB) && oB<cA && cB>oA && bodyB<bodyA && cC<oA) P.push('three_inside_down');

    // Three Outside Up/Down: engulfing (A,B) confirmed by C continuing further
    if(bear(oA,cA) && bull(oB,cB) && oB<=cA && cB>=oA && cC>cB) P.push('three_outside_up');
    if(bull(oA,cA) && bear(oB,cB) && oB>=cA && cB<=oA && cC<cB) P.push('three_outside_down');

    // Stick sandwich: A bearish, B bullish, C bearish, with A and C closing at ~the same level
    if(bear(oA,cA) && bull(oB,cB) && bear(oC,cC) && Math.abs(cA-cC) <= rangeA*0.05) P.push('stick_sandwich');

    // Unique Three River Bottom: long bearish, then a smaller bearish candle making a lower low
    // with a small body near its high (hammer-like), then a small bullish candle staying below B's close.
    if(bear(oA,cA) && bodyA/rangeA>0.5 && bear(oB,cB) && lB<lA && bodyB<bodyA && (cB-lB)>2*bodyB
       && bull(oC,cC) && cC<oB && bodyC<bodyB){
      P.push('unique_three_river_bottom');
    }

    // Three Stars in the South: three bearish candles with shrinking range/lower shadows, each
    // staying within the prior candle's range — a slow loss of downside momentum.
    if(bear(oA,cA) && bear(oB,cB) && bear(oC,cC) && rangeB<rangeA && rangeC<rangeB
       && lB>=lA && lC>=lB && bodyC<bodyB){
      P.push('three_stars_in_the_south');
    }

    // Three-Line Strike: three same-direction candles then this candle engulfing all three
    if(n>=4){
      const iD=idx(3); const oD=O(iD),cD=C(iD);
      if(bull(oD,cD)&&bull(oA,cA)&&bull(oB,cB)&&cA>cD&&cB>cA&&cC>cB && bear(oC,cC)===false && oC>cB && cC<oD){
        // placeholder guard kept minimal; primary check below covers the real definition
      }
    }
  }

  // ---- 3-line strike (four candles: three in one direction, then a full engulf of all three) ----
  if(n>=4){
    const iA=idx(3), iB=idx(2), iC=idx(1), iD=idx(0);
    const oA=O(iA),cA=C(iA), oB=O(iB),cB=C(iB), oC=O(iC),cC=C(iC), oD=O(iD),cD=C(iD);
    if(bull(oA,cA)&&bull(oB,cB)&&bull(oC,cC)&&cB>cA&&cC>cB&&bear(oD,cD)&&oD>cC&&cD<oA) P.push('bullish_three_line_strike');
    if(bear(oA,cA)&&bear(oB,cB)&&bear(oC,cC)&&cB<cA&&cC<cB&&bull(oD,cD)&&oD<cC&&cD>oA) P.push('bearish_three_line_strike');
  }

  // ---- Rising/Falling Three Methods (5 candles: long candle, 3 small opposite candles
  // contained within its range, then a continuation candle) ----
  if(n>=5){
    const i0=idx(4), i1b=idx(3), i2b=idx(2), i3b=idx(1), i4=idx(0);
    const o0=O(i0),c0=C(i0),h0=H(i0),l0=L(i0);
    const body0 = body(o0,c0), range0 = rng(h0,l0);
    const mids = [i1b,i2b,i3b].map(i => ({o:O(i),c:C(i),h:H(i),l:L(i)}));
    const midsInsideRange = mids.every(m => m.h<=h0+range0*0.02 && m.l>=l0-range0*0.02);
    const o4=O(i4), c4=C(i4);
    if(bull(o0,c0) && body0/range0>0.5 && mids.every(m=>bear(m.o,m.c)) && midsInsideRange && bull(o4,c4) && c4>c0){
      P.push('rising_three_methods');
    }
    if(bear(o0,c0) && body0/range0>0.5 && mids.every(m=>bull(m.o,m.c)) && midsInsideRange && bear(o4,c4) && c4<c0){
      P.push('falling_three_methods');
    }
  }

  return P;
}

const MTF_INTERVALS = ['15m', '1h', '4h'];
const MTF_MS = { '15m': 15*60000, '1h': 60*60000, '4h': 4*60*60000 };
const MTF_LOOKBACK_BARS = 300;

// ---------------- Support / resistance: pivot detection + level clustering with test counts ----------------
function findPivots(highs, lows, lookback){
  const pivotHighs = [], pivotLows = [];
  for(let i = lookback; i < highs.length - lookback; i++){
    const windowH = highs.slice(i-lookback, i+lookback+1);
    if(highs[i] === Math.max(...windowH)) pivotHighs.push({ idx: i, price: highs[i] });
    const windowL = lows.slice(i-lookback, i+lookback+1);
    if(lows[i] === Math.min(...windowL)) pivotLows.push({ idx: i, price: lows[i] });
  }
  return { pivotHighs, pivotLows };
}

function clusterLevels(pivots, tolerancePct){
  const clusters = [];
  [...pivots].sort((a,b) => a.price - b.price).forEach(p => {
    const found = clusters.find(c => Math.abs(c.price - p.price) / p.price * 100 <= tolerancePct);
    if(found){
      found.price = (found.price * found.tests + p.price) / (found.tests + 1);
      found.tests += 1;
      found.lastIdx = Math.max(found.lastIdx, p.idx);
    } else {
      clusters.push({ price: p.price, tests: 1, lastIdx: p.idx });
    }
  });
  return clusters.sort((a,b) => b.tests - a.tests);
}

function findSupportResistance(highs, lows){
  const { pivotHighs, pivotLows } = findPivots(highs, lows, 3);
  return {
    resistanceLevels: clusterLevels(pivotHighs, 0.5).slice(0, 3),
    supportLevels: clusterLevels(pivotLows, 0.5).slice(0, 3)
  };
}

// ---------------- Chart patterns: double top/bottom, head & shoulders, triangles/wedges ----------------
function chartSlope(points){
  if(points.length < 2) return 0;
  const a = points[0], b = points[points.length-1];
  const bars = b.idx - a.idx || 1;
  return ((b.price - a.price) / a.price) / bars;
}

function detectChartPatterns(highs, lows, closes){
  const patterns = [];
  const { pivotHighs, pivotLows } = findPivots(highs, lows, 3);
  const lastClose = closes[closes.length-1];

  if(pivotHighs.length >= 2){
    const [pA, pB] = pivotHighs.slice(-2);
    if(Math.abs(pA.price - pB.price) / pA.price * 100 < 1.0){
      const troughBetween = pivotLows.filter(p => p.idx > pA.idx && p.idx < pB.idx);
      if(troughBetween.length){
        const neckline = Math.min(...troughBetween.map(p=>p.price));
        if((pA.price - neckline)/pA.price > 0.015){
          patterns.push({ name: 'double_top', neckline: parseFloat(neckline.toFixed(2)), confirmed: lastClose < neckline });
        }
      }
    }
  }
  if(pivotLows.length >= 2){
    const [pA, pB] = pivotLows.slice(-2);
    if(Math.abs(pA.price - pB.price) / pA.price * 100 < 1.0){
      const peakBetween = pivotHighs.filter(p => p.idx > pA.idx && p.idx < pB.idx);
      if(peakBetween.length){
        const neckline = Math.max(...peakBetween.map(p=>p.price));
        if((neckline - pA.price)/pA.price > 0.015){
          patterns.push({ name: 'double_bottom', neckline: parseFloat(neckline.toFixed(2)), confirmed: lastClose > neckline });
        }
      }
    }
  }

  if(pivotHighs.length >= 3){
    const [L, H, R] = pivotHighs.slice(-3);
    if(H.price > L.price && H.price > R.price && Math.abs(L.price - R.price) / L.price * 100 < 3){
      const necklineLows = pivotLows.filter(p => p.idx > L.idx && p.idx < R.idx);
      if(necklineLows.length >= 1){
        const neckline = necklineLows.reduce((a,b)=>a+b.price,0)/necklineLows.length;
        patterns.push({ name: 'head_and_shoulders', neckline: parseFloat(neckline.toFixed(2)), confirmed: lastClose < neckline });
      }
    }
  }
  if(pivotLows.length >= 3){
    const [L, H, R] = pivotLows.slice(-3);
    if(H.price < L.price && H.price < R.price && Math.abs(L.price - R.price) / L.price * 100 < 3){
      const necklineHighs = pivotHighs.filter(p => p.idx > L.idx && p.idx < R.idx);
      if(necklineHighs.length >= 1){
        const neckline = necklineHighs.reduce((a,b)=>a+b.price,0)/necklineHighs.length;
        patterns.push({ name: 'inverse_head_and_shoulders', neckline: parseFloat(neckline.toFixed(2)), confirmed: lastClose > neckline });
      }
    }
  }

  if(pivotHighs.length >= 2 && pivotLows.length >= 2){
    const highSlope = chartSlope(pivotHighs.slice(-4));
    const lowSlope = chartSlope(pivotLows.slice(-4));
    const flat = 0.0005;
    if(Math.abs(highSlope) < flat && lowSlope > flat) patterns.push({ name: 'ascending_triangle' });
    else if(Math.abs(lowSlope) < flat && highSlope < -flat) patterns.push({ name: 'descending_triangle' });
    else if(highSlope > flat && lowSlope > flat && highSlope < lowSlope) patterns.push({ name: 'rising_wedge' });
    else if(highSlope < -flat && lowSlope < -flat && highSlope < lowSlope) patterns.push({ name: 'falling_wedge' });
    else if(highSlope < -flat && lowSlope > flat) patterns.push({ name: 'symmetrical_triangle' });
  }

  return patterns;
}

// ---------------- Per-timeframe technicals ----------------
// ---------------- ADX: trend strength, independent from directional bias ----------------
function computeADX(highs, lows, closes, period){
  const n = closes.length;
  if(n < period*2) return null;
  const trs=[], plusDMs=[], minusDMs=[];
  for(let i=1;i<n;i++){
    const upMove = highs[i]-highs[i-1];
    const downMove = lows[i-1]-lows[i];
    plusDMs.push((upMove>downMove && upMove>0) ? upMove : 0);
    minusDMs.push((downMove>upMove && downMove>0) ? downMove : 0);
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  function wilderSmooth(arr, period){
    const out=[]; let sum=arr.slice(0,period).reduce((a,b)=>a+b,0);
    out[period-1]=sum;
    for(let i=period;i<arr.length;i++){ sum = sum - (sum/period) + arr[i]; out[i]=sum; }
    return out;
  }
  const smoothedTR = wilderSmooth(trs, period);
  const smoothedPlusDM = wilderSmooth(plusDMs, period);
  const smoothedMinusDM = wilderSmooth(minusDMs, period);
  const dxs=[];
  for(let i=period-1;i<trs.length;i++){
    if(smoothedTR[i]==null || smoothedTR[i]===0) continue;
    const plusDI = 100*smoothedPlusDM[i]/smoothedTR[i];
    const minusDI = 100*smoothedMinusDM[i]/smoothedTR[i];
    const dx = (plusDI+minusDI)===0 ? 0 : 100*Math.abs(plusDI-minusDI)/(plusDI+minusDI);
    dxs.push(dx);
  }
  if(dxs.length < period) return null;
  const adxSeries = wilderSmooth(dxs, period).map(v=>v/period);
  return adxSeries[adxSeries.length-1];
}

async function loadTimeframeTechnicals(coin, interval){
  try{
    const endTime = Date.now();
    const startTime = endTime - MTF_MS[interval] * MTF_LOOKBACK_BARS;
    const candles = await infoPost({ type:'candleSnapshot', req:{ coin, interval, startTime, endTime } });
    if(!candles || candles.length < 30) return null;
    const opens = candles.map(c=>parseFloat(c.o));
    const highs = candles.map(c=>parseFloat(c.h));
    const lows = candles.map(c=>parseFloat(c.l));
    const closes = candles.map(c=>parseFloat(c.c));
    const vols = candles.map(c=>parseFloat(c.v));

    const rsi14 = computeRSI(closes, 14);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const { macd, signal, hist } = macdCalc(closes);
    const bbSd = stddev(closes, 20);
    const bbUpper = (sma20!=null && bbSd!=null) ? sma20 + 2*bbSd : null;
    const bbLower = (sma20!=null && bbSd!=null) ? sma20 - 2*bbSd : null;
    const patterns = detectPatterns(opens, highs, lows, closes);
    const chartPatterns = detectChartPatterns(highs, lows, closes);
    const { resistanceLevels, supportLevels } = findSupportResistance(highs, lows);
    const adx14 = computeADX(highs, lows, closes, 14);
    const CHART_CANDLE_COUNT = 250;
    const chartCandles = { opens: opens.slice(-CHART_CANDLE_COUNT), highs: highs.slice(-CHART_CANDLE_COUNT), lows: lows.slice(-CHART_CANDLE_COUNT), closes: closes.slice(-CHART_CANDLE_COUNT) };

    return {
      interval, lastClose: closes[closes.length-1], rsi14, sma20, sma50,
      macd, macdSignal: signal, macdHist: hist, adx14,
      bbUpper, bbMid: sma20, bbLower, volSma20: sma(vols,20), lastVol: vols[vols.length-1],
      patterns, chartPatterns, swingHigh: Math.max(...highs.slice(-50)), swingLow: Math.min(...lows.slice(-50)),
      resistanceLevels, supportLevels, recentCandles: chartCandles
    };
  }catch(e){ console.error('Technicals failed for ' + coin + ' (' + interval + '):', e.message); return null; }
}

async function loadMultiTimeframeTechnicals(coin){
  const out = {};
  for(const iv of MTF_INTERVALS){ out[iv] = await loadTimeframeTechnicals(coin, iv); }
  return out;
}

function timeframeBias(t){
  if(!t) return 'neutral';
  let bull = 0, bear = 0;
  if(t.sma20 != null){ if(t.lastClose > t.sma20) bull++; else bear++; }
  if(t.macdHist != null){ if(t.macdHist > 0) bull++; else bear++; }
  if(t.rsi14 != null){ if(t.rsi14 > 50) bull++; else bear++; }
  if(bull > bear) return 'long';
  if(bear > bull) return 'short';
  return 'neutral';
}

function computeAlignment(mtf){
  const biases = MTF_INTERVALS.map(iv => timeframeBias(mtf[iv]));
  const longCount = biases.filter(b => b === 'long').length;
  const shortCount = biases.filter(b => b === 'short').length;
  const total = MTF_INTERVALS.length;
  const needed = Math.ceil(total * 2 / 3);
  if(longCount >= needed) return { direction: 'long', agree: longCount, total };
  if(shortCount >= needed) return { direction: 'short', agree: shortCount, total };
  return { direction: null, agree: Math.max(longCount, shortCount), total };
}

function formatMultiTimeframeBlock(coin, mtf, alignment){
  const fmt = (v,d) => v==null ? 'n/a' : v.toFixed(d);
  const lines = MTF_INTERVALS.map(iv => {
    const t = mtf[iv];
    if(!t) return '  ' + iv + ': data unavailable';
    const res = t.resistanceLevels.length ? t.resistanceLevels.map(l => '$'+l.price.toFixed(2)+' ('+l.tests+'x tested)').join(', ') : 'none found';
    const sup = t.supportLevels.length ? t.supportLevels.map(l => '$'+l.price.toFixed(2)+' ('+l.tests+'x tested)').join(', ') : 'none found';
    const chartPatternStr = (t.chartPatterns && t.chartPatterns.length)
      ? t.chartPatterns.map(cp => cp.name + (cp.neckline ? ` (neckline $${cp.neckline}${cp.confirmed ? ', confirmed' : ', not yet confirmed'})` : '')).join(', ')
      : 'none';
    return '  ' + iv + ': price $'+fmt(t.lastClose,2)+', RSI14 '+fmt(t.rsi14,1)
      + ', SMA20 $'+fmt(t.sma20,2)+'/SMA50 $'+fmt(t.sma50,2)
      + ', MACD hist '+fmt(t.macdHist,4)
      + ', ADX14 '+fmt(t.adx14,1)+' ('+(t.adx14==null?'n/a':t.adx14>=25?'trending':t.adx14>=20?'developing':'weak/ranging')+')'
      + ', Bollinger $'+fmt(t.bbLower,2)+'-$'+fmt(t.bbUpper,2)
      + ', candlestick patterns: '+(t.patterns.length ? t.patterns.join(', ') : 'none')
      + ', chart patterns: '+chartPatternStr
      + ', resistance: '+res+', support: '+sup;
  }).join('\n');
  const alignLine = alignment.direction
    ? '  Multi-timeframe bias: ' + alignment.direction.toUpperCase() + ' (' + alignment.agree + '/' + alignment.total + ' timeframes agree)'
    : '  Multi-timeframe bias: NO CLEAR ALIGNMENT (' + alignment.agree + '/' + alignment.total + ' agree at most)';
  return coin + ':\n' + lines + '\n' + alignLine;
}

async function loadOrderBookSignal(coin){
  try{
    const book = await infoPost({ type: 'l2Book', coin });
    const bids = (book.levels && book.levels[0]) || [];
    const asks = (book.levels && book.levels[1]) || [];
    const topN = 10;
    const bidSz = bids.slice(0, topN).reduce((s,l)=>s+parseFloat(l.sz), 0);
    const askSz = asks.slice(0, topN).reduce((s,l)=>s+parseFloat(l.sz), 0);
    const imbalance = (bidSz + askSz) ? (bidSz - askSz) / (bidSz + askSz) : 0;
    const bestBid = bids[0] ? parseFloat(bids[0].px) : null;
    const bestAsk = asks[0] ? parseFloat(asks[0].px) : null;
    const spreadPct = (bestBid && bestAsk) ? ((bestAsk - bestBid) / bestAsk * 100) : null;
    return { imbalance, spreadPct };
  }catch(e){ return { imbalance: 0, spreadPct: null }; }
}

async function loadVolumeSignal(coin){
  try{
    const endTime = Date.now();
    const startTime = endTime - INTERVAL_MS_5M * 30;
    const candles = await infoPost({ type: 'candleSnapshot', req: { coin, interval: '5m', startTime, endTime } });
    if(!candles || candles.length < 6) return { volRatio: 1 };
    const vols = candles.map(c => parseFloat(c.v));
    const latest = vols[vols.length - 1];
    const priorAvg = vols.slice(0, -1).reduce((a,b)=>a+b, 0) / (vols.length - 1);
    return { volRatio: priorAvg ? (latest / priorAvg) : 1 };
  }catch(e){ return { volRatio: 1 }; }
}

async function loadSignals(coins){
  const marketRows = await loadMarketContext(coins);
  const signals = {};
  for(const row of marketRows){
    const [book, vol] = await Promise.all([ loadOrderBookSignal(row.coin), loadVolumeSignal(row.coin) ]);
    signals[row.coin] = Object.assign({}, row, book, vol);
  }
  return signals;
}

function findTrippedCoins(signals){
  const t = SIGNAL_THRESHOLDS[SENSITIVITY] || SIGNAL_THRESHOLDS.medium;
  return Object.values(signals).filter(s => s.volRatio >= t.volRatio || Math.abs(s.imbalance) >= t.imbalance).map(s => s.coin);
}

function buildAgentPrompt(signals, mtfData, alignments){
  const techTable = Object.keys(mtfData).map(coin => formatMultiTimeframeBlock(coin, mtfData[coin], alignments[coin])).join('\n\n');
  const rows = Object.values(signals);
  const supportTable = rows.map(r =>
    r.coin+': funding '+(r.funding*100).toFixed(4)+'%/8h, OI '+Math.round(r.openInterest)+', '
    + 'OI momentum: '+(r.oiMomentum || 'insufficient history')+', '
    + 'order-book imbalance '+(r.imbalance*100).toFixed(1)+'% ('+(r.imbalance>0?'bid-heavy':'ask-heavy')+'), '
    + 'spread '+(r.spreadPct!=null? r.spreadPct.toFixed(3)+'%':'n/a')+', '
    + '5m volume vs trailing avg '+r.volRatio.toFixed(2)+'x'
  ).join('\n');

  const system = "You are JARVIS's trading research sub-agent for a Hyperliquid perpetuals account, acting as a master chart technician. "
    + "Every coin below has ALREADY been confirmed to have multi-timeframe alignment (agreement across 15m/1h/4h) before reaching you — respect that "
    + "established direction; don't recommend the opposite direction from what's aligned unless the evidence is overwhelming and you say so explicitly. "
    + "Your ENTIRE basis for every recommendation is technical and market-structure analysis: candlestick patterns (both single-candle and multi-candle "
    + "structures like three soldiers/crows, morning/evening stars, three-line strikes), classic chart patterns (double tops/bottoms, head and shoulders, "
    + "triangles, wedges — noting whether a pattern's neckline has actually been confirmed or is still forming), agreement from popular indicators (RSI, MACD, "
    + "Bollinger Bands, moving averages, and ADX (trend strength — above 25 means genuinely trending, below 20 means weak/ranging and any directional signal there "
    + "deserves less weight) across timeframes, support/resistance levels with their test counts, order-book imbalance, and open-interest momentum "
    + "(rising OI + rising price is a fresh long buildup and a stronger signal than the same price move on falling OI, which is likely just short-covering — "
    + "weight OI momentum accordingly). You have no access to news or social sentiment and should not reference or assume any. "
    + "Your job: find VERY SHORT-TERM, QUICK-TURNAROUND trade opportunities only — think minutes to roughly 24 hours, not multi-day swing theses. "
    + "You NEVER place trades yourself; you only propose them for human (or pre-authorized automatic) review. "
    + "Return at most 3 ideas — only ones with genuine technical conviction; return fewer or none if nothing qualifies. "
    + "Every idea MUST include a concrete stop_loss_price, placed at a technically sensible level (e.g. beyond a tested support/resistance level or recent swing), "
    + "and ideally within about " + MAX_STOP_LOSS_PCT + "% of entry — trades needing a wider stop than that to make sense are usually not a fit here. "
    + "For each idea, list which of these confluence factors are genuinely present (be honest — don't pad the list): candlestick_pattern, chart_pattern, "
    + "macd_agreement, rsi_agreement, bollinger_band_position, support_resistance_confluence, oi_momentum. Do not set your own conviction label — it will be "
    + "computed from the number of factors you honestly report. Also — before finalizing each idea — argue against it: state the single strongest reason this "
    + "trade could fail (counterthesis), and briefly say why you're proposing it anyway despite that risk (counterthesis_response). If you can't come up with "
    + "a credible reason it could fail, or can't credibly answer your own counterthesis, drop the idea rather than force it. "
    + "Be concise: rationale <= 35 words, counterthesis <= 25 words, counterthesis_response <= 25 words. "
    + "CRITICAL: Respond with ONLY raw JSON — no markdown fences, no prose before or after, no explanation of your approach. Your entire response must be "
    + "parseable as JSON starting from the very first character. Match exactly: "
    + '{"recommendations":[{"coin":string,"direction":"long"|"short",'
    + '"pattern":string,"indicators_confirming":[string],"confluence_factors":[string],'
    + '"rationale":string,"counterthesis":string,"counterthesis_response":string,"time_horizon":string,'
    + '"entry_price":number,"stop_loss_price":number,"take_profit_price":number|null,'
    + '"suggested_size_pct_equity":number,"suggested_leverage":number,"risk_flags":[string]}]}';

  const user = "Multi-timeframe technical readout, including support/resistance levels and how many times each has been tested (primary evidence):\n\n" + techTable
    + "\n\nSupporting market data (funding/OI momentum/book/volume):\n" + supportTable
    + "\n\nFind the best technically-confirmed, quick-turnaround opportunities right now among these coins (or state none if the technical picture isn't compelling for any of them).";
  return { system, user };
}

// ---------------- Confluence-based conviction (computed in code, not left to the model's own label) ----------------
const ALL_CONFLUENCE_FACTORS = ['candlestick_pattern','chart_pattern','macd_agreement','rsi_agreement','bollinger_band_position','support_resistance_confluence','oi_momentum'];

function computeConviction(rec, technicals){
  const factors = (rec.confluence_factors || []).filter(f => ALL_CONFLUENCE_FACTORS.includes(f));
  rec.confluence_factors = factors; // drop anything the model invented outside the known list
  // ADX is an objective, code-computed bonus — not self-reported by the model — so it can't be
  // padded. A genuinely strong trend (ADX >= 25) on the 15m reference timeframe adds one point.
  const adx = technicals && technicals.adx14;
  rec.trend_strength = adx == null ? null : (adx >= 25 ? 'trending' : adx >= 20 ? 'developing' : 'weak/ranging');
  const adxBonus = (adx != null && adx >= 25) ? 1 : 0;
  rec.confluence_score = factors.length + adxBonus;
  if(rec.confluence_score >= 6) return 'high';
  if(rec.confluence_score >= 3) return 'medium';
  return 'low';
}

// ---------------- Open interest momentum (tracked across runs via state.json) ----------------
function classifyOiMomentum(oiChangePct, priceChangePct){
  if(oiChangePct == null || priceChangePct == null) return null;
  if(oiChangePct > 1 && priceChangePct > 0) return `OI +${oiChangePct.toFixed(1)}% & price up (fresh long buildup)`;
  if(oiChangePct > 1 && priceChangePct < 0) return `OI +${oiChangePct.toFixed(1)}% & price down (fresh short buildup)`;
  if(oiChangePct < -1 && priceChangePct > 0) return `OI ${oiChangePct.toFixed(1)}% & price up (short covering, weaker signal)`;
  if(oiChangePct < -1 && priceChangePct < 0) return `OI ${oiChangePct.toFixed(1)}% & price down (long unwind, weaker signal)`;
  return `OI roughly flat (${oiChangePct.toFixed(1)}%)`;
}

function applyOiMomentum(signals, state){
  state.lastOiByCoin = state.lastOiByCoin || {};
  state.lastPriceByCoin = state.lastPriceByCoin || {};
  Object.values(signals).forEach(s => {
    const prevOi = state.lastOiByCoin[s.coin];
    const prevPrice = state.lastPriceByCoin[s.coin];
    const oiChangePct = (prevOi != null && prevOi > 0) ? ((s.openInterest - prevOi) / prevOi * 100) : null;
    const priceChangePct = (prevPrice != null && prevPrice > 0) ? ((s.markPx - prevPrice) / prevPrice * 100) : null;
    s.oiMomentum = classifyOiMomentum(oiChangePct, priceChangePct);
    state.lastOiByCoin[s.coin] = s.openInterest;
    state.lastPriceByCoin[s.coin] = s.markPx;
  });
}

// ---------------- Risk-level resolution (AI value -> technical calc -> settings fallback) ----------------
function resolveRiskLevels(rec, technicals, maxStopLossPct, defaultTakeProfitPct, maxTakeProfitPct, maxEntryDeviationPct){
  const isLong = rec.direction !== 'short';
  const t = technicals;
  const notes = [];

  // --- Entry price: the AI sets this from its own analysis, but it must not stray far from the
  // live market price — a stale or unrealistic entry undermines everything computed from it below.
  let entry = rec.entry_price;
  if(t && t.lastClose != null && entry && isFinite(entry) && entry > 0){
    const entryDevPct = Math.abs(entry - t.lastClose) / t.lastClose * 100;
    if(entryDevPct > maxEntryDeviationPct){
      notes.push(`entry: AI-suggested $${entry.toFixed(2)} was ${entryDevPct.toFixed(1)}% from live price, replaced with live price`);
      entry = t.lastClose;
    }
  } else if(t && t.lastClose != null && (!entry || !isFinite(entry) || entry <= 0)){
    entry = t.lastClose;
    notes.push('entry: no valid AI value, used live price');
  }
  rec.entry_price = entry;

  // --- Stop-loss ---
  let stop = rec.stop_loss_price;
  let stopValid = stop && isFinite(stop) && stop > 0 && (isLong ? stop < entry : stop > entry);
  let stopDistPct = stopValid ? Math.abs(entry - stop) / entry * 100 : null;

  if(stopValid && stopDistPct <= maxStopLossPct){
    notes.push('stop: AI-suggested');
  } else if(t && t.swingLow != null && t.swingHigh != null){
    const bandWidth = (t.bbUpper != null && t.bbLower != null) ? (t.bbUpper - t.bbLower) : (entry * 0.01);
    const buffer = bandWidth * 0.1;
    const swingStop = isLong ? (t.swingLow - buffer) : (t.swingHigh + buffer);
    const swingDistPct = Math.abs(entry - swingStop) / entry * 100;
    if(swingStop > 0 && swingDistPct > 0 && swingDistPct <= maxStopLossPct){
      stop = swingStop; stopDistPct = swingDistPct;
      notes.push(stopValid ? 'stop: AI value exceeded max distance, replaced with swing-based technical stop' : 'stop: technical swing-based (no valid AI value)');
    } else {
      stop = isLong ? entry * (1 - maxStopLossPct/100) : entry * (1 + maxStopLossPct/100);
      stopDistPct = maxStopLossPct;
      notes.push('stop: capped at max stop-loss distance setting (technical/AI stop was out of range)');
    }
  } else {
    stop = isLong ? entry * (1 - maxStopLossPct/100) : entry * (1 + maxStopLossPct/100);
    stopDistPct = maxStopLossPct;
    notes.push('stop: capped at max stop-loss distance setting (no technicals or AI value available)');
  }

  // --- Take-profit ---
  let tp = rec.take_profit_price;
  const tpValid = tp && isFinite(tp) && tp > 0 && (isLong ? tp > entry : tp < entry);

  if(tpValid){
    notes.push('target: AI-suggested');
  } else {
    // technically-driven: reward:risk of 1.5x the resolved stop distance
    const rrTarget = isLong ? entry * (1 + (stopDistPct*1.5)/100) : entry * (1 - (stopDistPct*1.5)/100);
    if(rrTarget > 0){
      tp = rrTarget;
      notes.push('target: 1.5x risk:reward from resolved stop (no valid AI target)');
    } else {
      tp = isLong ? entry * (1 + defaultTakeProfitPct/100) : entry * (1 - defaultTakeProfitPct/100);
      notes.push('target: default take-profit % setting (fallback)');
    }
  }

  // Cap the final take-profit distance regardless of where it came from — an AI target (or a
  // technically-derived one) can still be unrealistically far away.
  const tpDistPct = Math.abs(tp - entry) / entry * 100;
  if(tpDistPct > maxTakeProfitPct){
    tp = isLong ? entry * (1 + maxTakeProfitPct/100) : entry * (1 - maxTakeProfitPct/100);
    notes.push(`target: capped at max take-profit distance setting (was ${tpDistPct.toFixed(1)}% away)`);
  }

  rec.stop_loss_price = parseFloat(stop.toFixed(2));
  rec.take_profit_price = parseFloat(tp.toFixed(2));
  rec.risk_flags = (rec.risk_flags || []).concat(notes.filter(n => !n.includes('AI-suggested')));
  return rec;
}

// ---------------- Technicals-only fallback (used when Anthropic is unavailable, e.g. low credits) ----------------
function technicalOnlySignal(t){
  if(!t) return null;
  const bullPatterns = [
    'bullish_engulfing','hammer','inverted_hammer','bullish_belt_hold','dragonfly_doji',
    'piercing_line','bullish_kicking','three_white_soldiers','morning_star','morning_doji_star',
    'bullish_abandoned_baby','three_inside_up','three_outside_up','bullish_harami','bullish_harami_cross',
    'bullish_meeting_lines','bullish_separating_lines','bullish_side_by_side_white_lines',
    'stick_sandwich','unique_three_river_bottom','three_stars_in_the_south',
    'bullish_three_line_strike','rising_three_methods'
  ];
  const bearPatterns = [
    'bearish_engulfing','hanging_man','shooting_star','bearish_belt_hold','gravestone_doji',
    'dark_cloud_cover','bearish_kicking','three_black_crows','evening_star','evening_doji_star',
    'bearish_abandoned_baby','three_inside_down','three_outside_down','bearish_harami','bearish_harami_cross',
    'bearish_meeting_lines','bearish_separating_lines','bearish_side_by_side_black_lines',
    'on_neck','in_neck','thrusting','advance_block','deliberation',
    'bearish_three_line_strike','falling_three_methods'
  ];
  const hasBull = t.patterns.some(p => bullPatterns.includes(p));
  const hasBear = t.patterns.some(p => bearPatterns.includes(p));
  const macdBull = t.macdHist != null && t.macdHist > 0;
  const macdBear = t.macdHist != null && t.macdHist < 0;
  const nearLowerBand = t.bbLower != null && t.lastClose <= t.bbLower * 1.01;
  const nearUpperBand = t.bbUpper != null && t.lastClose >= t.bbUpper * 0.99;
  const rsiOversold = t.rsi14 != null && t.rsi14 < 35;
  const rsiOverbought = t.rsi14 != null && t.rsi14 > 65;
  const chartBull = (t.chartPatterns||[]).some(cp => ['double_bottom','inverse_head_and_shoulders','ascending_triangle','falling_wedge'].includes(cp.name));
  const chartBear = (t.chartPatterns||[]).some(cp => ['double_top','head_and_shoulders','descending_triangle','rising_wedge'].includes(cp.name));
  const strongTrend = t.adx14 != null && t.adx14 >= 25;
  const trendUp = t.sma20 != null && t.lastClose > t.sma20;
  const trendDown = t.sma20 != null && t.lastClose < t.sma20;

  const bullFactors = [hasBull && 'candlestick pattern', macdBull && 'MACD histogram positive', nearLowerBand && 'price at lower Bollinger Band', rsiOversold && 'RSI oversold', chartBull && 'bullish chart pattern', (strongTrend && trendUp) && 'strong trend (ADX)'].filter(Boolean);
  const bearFactors = [hasBear && 'candlestick pattern', macdBear && 'MACD histogram negative', nearUpperBand && 'price at upper Bollinger Band', rsiOverbought && 'RSI overbought', chartBear && 'bearish chart pattern', (strongTrend && trendDown) && 'strong trend (ADX)'].filter(Boolean);

  if(bullFactors.length >= 2 && bullFactors.length > bearFactors.length){
    return { direction: 'long', confirming: bullFactors, pattern: t.patterns.filter(p=>bullPatterns.includes(p)).join(', ') || 'momentum confluence (no single candle pattern)' };
  }
  if(bearFactors.length >= 2 && bearFactors.length > bullFactors.length){
    return { direction: 'short', confirming: bearFactors, pattern: t.patterns.filter(p=>bearPatterns.includes(p)).join(', ') || 'momentum confluence (no single candle pattern)' };
  }
  return null;
}

function buildFallbackRecommendations(scanCoins, technicals, maxPositionPct, maxLeverage, maxStopLossPct, defaultTakeProfitPct){
  const recs = [];
  for(const coin of scanCoins){
    const t = technicals[coin];
    const signal = technicalOnlySignal(t);
    if(!signal) continue;
    let rec = {
      coin, direction: signal.direction, conviction: 'low',
      pattern: signal.pattern, indicators_confirming: signal.confirming,
      confluence_factors: [], confluence_score: signal.confirming.length,
      rationale: 'Technical confluence only: ' + signal.confirming.join(', ') + '. No AI research performed this cycle.',
      time_horizon: 'Short-term (technical fallback)',
      entry_price: t.lastClose,
      stop_loss_price: null, take_profit_price: null,
      suggested_size_pct_equity: Math.max(1, Math.round((maxPositionPct/2) * 10) / 10),
      suggested_leverage: Math.max(1, Math.round(maxLeverage/2)),
      risk_flags: ['technicals-only fallback — no AI research this cycle']
    };
    rec = resolveRiskLevels(rec, t, maxStopLossPct, defaultTakeProfitPct, MAX_TAKE_PROFIT_PCT, MAX_ENTRY_DEVIATION_PCT);
    recs.push(rec);
  }
  return recs.slice(0, 3);
}

async function callAnthropic(system, user){
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: user }]
      // No tools: no web search, no sentiment/news — technicals and market structure only.
    })
  });
  const data = await res.json();
  if(data.error) throw new Error(data.error.message || 'Anthropic API error');
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  let raw = textBlocks.join('\n').trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();

  // Stripping code fences handles the model wrapping its whole answer in ```json — it doesn't
  // handle the model adding a plain-text preamble before the JSON at all (e.g. "I'll work
  // through this..."), which is a different failure mode. Extracting from the first { to the
  // last } handles both cases uniformly, regardless of what surrounds the actual JSON.
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if(firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace){
    throw new Error('No JSON object found in Anthropic response. Raw text started with: ' + raw.slice(0, 150));
  }
  const jsonSlice = raw.slice(firstBrace, lastBrace + 1);
  try{
    return JSON.parse(jsonSlice);
  }catch(e){
    throw new Error('Could not parse JSON from Anthropic response (' + e.message + '). Extracted slice started with: ' + jsonSlice.slice(0, 150));
  }
}

// ---------------- Self-consistency: two independent passes, only keep what both agree on ----------------
function tighterStop(direction, stopA, stopB){
  if(stopA == null) return stopB;
  if(stopB == null) return stopA;
  // "Tighter" = closer to entry = more conservative (smaller potential loss).
  return direction === 'short' ? Math.min(stopA, stopB) : Math.max(stopA, stopB);
}

// A malformed recommendation (missing coin, bad direction, non-numeric prices) must never reach
// Telegram or the dashboard — if it did, it would only fail cryptically much later, e.g. as
// "Unknown asset: undefined" from Hyperliquid at the moment someone tries to confirm it, instead
// of being caught here where the actual cause is obvious.
function isValidRec(rec){
  if(!rec || typeof rec.coin !== 'string' || !rec.coin.trim()) return false;
  if(rec.direction !== 'long' && rec.direction !== 'short') return false;
  if(!isFinite(rec.entry_price) || rec.entry_price <= 0) return false;
  if(rec.stop_loss_price != null && (!isFinite(rec.stop_loss_price) || rec.stop_loss_price <= 0)) return false;
  return true;
}

function mergeConsistentRecs(recsA, recsB){
  recsA = recsA.filter(isValidRec);
  recsB = recsB.filter(isValidRec);
  const merged = [];
  for(const a of recsA){
    const b = recsB.find(x => x.coin === a.coin && x.direction === a.direction);
    if(!b) continue; // didn't reproduce on the independent pass — drop it
    merged.push({
      coin: a.coin,
      direction: a.direction,
      pattern: a.pattern,
      indicators_confirming: Array.from(new Set([...(a.indicators_confirming||[]), ...(b.indicators_confirming||[])])),
      confluence_factors: Array.from(new Set([...(a.confluence_factors||[]), ...(b.confluence_factors||[])])),
      rationale: a.rationale,
      counterthesis: a.counterthesis,
      counterthesis_response: a.counterthesis_response,
      time_horizon: a.time_horizon,
      entry_price: (a.entry_price + b.entry_price) / 2,
      stop_loss_price: tighterStop(a.direction, a.stop_loss_price, b.stop_loss_price),
      take_profit_price: (a.take_profit_price && b.take_profit_price) ? (a.take_profit_price + b.take_profit_price) / 2 : (a.take_profit_price || b.take_profit_price || null),
      suggested_size_pct_equity: Math.min(a.suggested_size_pct_equity || 5, b.suggested_size_pct_equity || 5),
      suggested_leverage: Math.min(a.suggested_leverage || 1, b.suggested_leverage || 1),
      risk_flags: Array.from(new Set([...(a.risk_flags||[]), ...(b.risk_flags||[])])),
      self_consistent: true
    });
  }
  return merged;
}

async function callAnthropicWithSelfConsistency(system, user){
  const [resA, resB] = await Promise.all([ callAnthropic(system, user), callAnthropic(system, user) ]);
  const recsA = resA.recommendations || [];
  const recsB = resB.recommendations || [];
  const merged = mergeConsistentRecs(recsA, recsB);
  console.log(`Self-consistency: pass A found ${recsA.length}, pass B found ${recsB.length}, ${merged.length} agreed on both coin+direction.`);
  return { recommendations: merged };
}

// ---------------- Chart screenshot (QuickChart.io — no native canvas/Cairo dependency needed in CI) ----------------
// POST, not GET: a GET-encoded chart config for ~20 candles runs 4,000+ characters, which risks
// silent truncation/rejection by QuickChart or Telegram. POST has no such limit, and returns the
// rendered PNG bytes directly, which we then upload to Telegram via multipart form data.
function buildChartConfig(coin, candles, entry, stop, target){
  if(!candles || !candles.closes || candles.closes.length < 5) return null;
  const data = candles.closes.map((c,i) => ({ x: i, o: candles.opens[i], h: candles.highs[i], l: candles.lows[i], c: candles.closes[i] }));
  const annotations = {};
  if(entry) annotations.entry = { type:'line', yMin:entry, yMax:entry, borderColor:'#4a90d9', borderWidth:1.5, label:{ content:'Entry', enabled:true, position:'start', backgroundColor:'#4a90d9' } };
  if(stop) annotations.stop = { type:'line', yMin:stop, yMax:stop, borderColor:'#ff5c5c', borderWidth:1.5, label:{ content:'Stop', enabled:true, position:'end', backgroundColor:'#ff5c5c' } };
  if(target) annotations.target = { type:'line', yMin:target, yMax:target, borderColor:'#29f19c', borderWidth:1.5, label:{ content:'Target', enabled:true, position:'end', backgroundColor:'#29f19c' } };

  return {
    type: 'candlestick',
    data: { datasets: [{ label: coin, data }] },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: coin + ' — last ' + candles.closes.length + ' x 15m candles', color: '#e8ecef' },
        annotation: { annotations }
      },
      scales: {
        x: { display: false },
        y: { ticks: { color: '#aab' } }
      }
    }
  };
}

async function fetchChartImageBuffer(config){
  if(!config) return null;
  try{
    const res = await fetch('https://quickchart.io/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Wider canvas so ~250 candles stay legible instead of compressing into a narrow strip.
      body: JSON.stringify({ chart: config, width: 1000, height: 450, backgroundColor: '#0d1117', version: '3' })
    });
    if(!res.ok){ console.error('QuickChart render failed: HTTP ' + res.status); return null; }
    const arrBuf = await res.arrayBuffer();
    return Buffer.from(arrBuf);
  }catch(e){ console.error('QuickChart render threw:', e.message); return null; }
}

async function sendTelegramPhotoBuffer(buffer, caption, attempt){
  attempt = attempt || 1;
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !buffer) return false;
  try{
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', (caption || '').slice(0, 1000));
    form.append('photo', new Blob([buffer], { type: 'image/png' }), 'chart.png');
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form
    });
    const data = await res.json();
    if(!res.ok || !data.ok){
      console.error('Telegram sendPhoto failed:', data.description || res.status);
      if(attempt < 2){ await new Promise(r=>setTimeout(r,1000)); return sendTelegramPhotoBuffer(buffer, caption, attempt+1); }
      return false;
    }
    return true;
  }catch(e){
    console.error('Telegram sendPhoto threw:', e.message);
    if(attempt < 2){ await new Promise(r=>setTimeout(r,1000)); return sendTelegramPhotoBuffer(buffer, caption, attempt+1); }
    return false;
  }
}

async function sendTelegram(text, replyMarkup, attempt){
  attempt = attempt || 1;
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.log('Telegram not configured, skipping send. Message would have been:\n' + text);
    return null;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  // No parse_mode: AI-generated or error text can contain *, _, ` characters that break Telegram's
  // Markdown parser and silently fail the whole send. Plain text is slightly less pretty but never
  // fails to deliver because of formatting.
  const body = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true };
  if(replyMarkup) body.reply_markup = replyMarkup;
  try{
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if(!res.ok || !data.ok){
      console.error('Telegram send failed:', data.description || res.status);
      if(attempt < 2){ await new Promise(r=>setTimeout(r,1000)); return sendTelegram(text, replyMarkup, attempt+1); }
      return null;
    }
    return data.result.message_id;
  }catch(e){
    console.error('Telegram send threw:', e.message);
    if(attempt < 2){ await new Promise(r=>setTimeout(r,1000)); return sendTelegram(text, replyMarkup, attempt+1); }
    return null;
  }
}

function formatTelegramMessage(rec){
  const dir = rec.direction === 'short' ? 'SHORT' : 'LONG';
  const confirming = (rec.indicators_confirming || []).length ? rec.indicators_confirming.join(', ') : '—';
  const fallbackNote = rec.source === 'backend-fallback' ? '\n🔧 Technicals-only this cycle (AI unavailable or off).' : '';
  const consistencyNote = rec.self_consistent ? ' · verified 2x' : '';
  // Formatted explicitly as UTC (not the local time of whoever reads it) since this runs
  // server-side with no way to know the reader's timezone.
  const timestamp = rec.generated_at
    ? new Date(rec.generated_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : null;

  const lines = [];
  lines.push(`🤖 JARVIS — ${rec.coin} ${dir}`);
  lines.push(`${rec.conviction || 'low'} conviction · ${rec.confluence_score != null ? rec.confluence_score + '/8 factors' : 'n/a'}${consistencyNote}${rec.trend_strength ? ' · ' + rec.trend_strength + ' trend' : ''}${fallbackNote}`);
  if(timestamp) lines.push(`Recommended: ${timestamp}`);

  lines.push('');
  lines.push('SETUP');
  lines.push(`• Pattern: ${rec.pattern || '—'}`);
  lines.push(`• Confirming: ${confirming}`);
  if((rec.confluence_factors || []).length) lines.push(`• Confluence: ${rec.confluence_factors.join(', ')}`);
  if((rec.chart_patterns || []).length){
    lines.push('• Chart pattern: ' + rec.chart_patterns.map(cp => cp.name + (cp.neckline ? ` (neckline $${cp.neckline}${cp.confirmed ? ', confirmed' : ''})` : '')).join(', '));
  }
  if((rec.resistance_levels || []).length){
    lines.push('• Resistance: ' + rec.resistance_levels.map(l => `$${l.price} (${l.tests}x touched)`).join(', '));
  }
  if((rec.support_levels || []).length){
    lines.push('• Support: ' + rec.support_levels.map(l => `$${l.price} (${l.tests}x touched)`).join(', '));
  }

  lines.push('');
  lines.push('ANALYSIS');
  lines.push(`• Why: ${rec.rationale || '—'}`);
  if(rec.counterthesis) lines.push(`• Risk: ${rec.counterthesis}`);
  if(rec.counterthesis_response) lines.push(`• Still valid because: ${rec.counterthesis_response}`);
  lines.push(`• Horizon: ${rec.time_horizon || '—'}`);

  lines.push('');
  lines.push('TRADE');
  lines.push(`• Entry ~$${rec.entry_price} · Stop $${rec.stop_loss_price}` + (rec.take_profit_price ? ` · Target $${rec.take_profit_price}` : ''));
  lines.push(`• Size: ${rec.suggested_size_pct_equity}% of equity, ${rec.suggested_leverage}x leverage (re-verified against your limits at execution)`);
  if(rec.estimated_notional != null && rec.estimated_margin != null){
    lines.push(`• Est. value: $${rec.estimated_notional.toFixed(2)} notional — cash required: ~$${rec.estimated_margin.toFixed(2)} margin`);
  }
  if((rec.risk_flags || []).length) lines.push(`• Flags: ${rec.risk_flags.join(', ')}`);
  if(rec.hyperliquid_url) lines.push(`• Chart: ${rec.hyperliquid_url}`);

  lines.push('');
  if(rec.auto_trade){
    lines.push(`⚡ Auto-trade is ON — this executes immediately, right now. There is no cancel window.`);
  } else {
    lines.push(`Expires in ${EXECUTION_WINDOW_MIN} min — tap below to confirm or deny.`);
  }

  return lines.join('\n');
}

async function main(){
  const shared = loadSharedConfig();
  if(shared){
    if(shared.watchlist) WATCHLIST = shared.watchlist.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    if(shared.scanMode) SCAN_MODE = shared.scanMode;
    if(shared.filteredTopN) FILTERED_TOP_N = parseInt(shared.filteredTopN, 10);
    // `if(shared.x)` treats a published 0 as "not set" and silently keeps the old value — wrong
    // for these two specifically, since 0 is a meaningful choice (disable that filter dimension).
    if(shared.filteredMinOI !== undefined && shared.filteredMinOI !== null) FILTERED_MIN_OI = parseFloat(shared.filteredMinOI);
    if(shared.filteredMinVolume24h !== undefined && shared.filteredMinVolume24h !== null) FILTERED_MIN_VOLUME_24H = parseFloat(shared.filteredMinVolume24h);
    if(shared.maxStopLossPct) MAX_STOP_LOSS_PCT = parseFloat(shared.maxStopLossPct);
    if(shared.maxTakeProfitPct) MAX_TAKE_PROFIT_PCT = parseFloat(shared.maxTakeProfitPct);
    if(shared.maxEntryDeviationPct) MAX_ENTRY_DEVIATION_PCT = parseFloat(shared.maxEntryDeviationPct);
    if(shared.maxPositionPct) MAX_POSITION_PCT = parseFloat(shared.maxPositionPct);
    if(shared.maxLeverage) MAX_LEVERAGE = parseFloat(shared.maxLeverage);
    if(shared.defaultTakeProfitPct) DEFAULT_TAKE_PROFIT_PCT = parseFloat(shared.defaultTakeProfitPct);
    if(shared.aiResearchEnabled !== undefined) AI_RESEARCH_ENABLED = !!shared.aiResearchEnabled;
    if(shared.autoTradeEnabled !== undefined) AUTO_TRADE_ENABLED = !!shared.autoTradeEnabled;
    if(shared.maxRecsPerScan) MAX_RECS_PER_SCAN = parseInt(shared.maxRecsPerScan, 10);
  }
  console.log('AI research is ' + (AI_RESEARCH_ENABLED ? 'ENABLED' : 'DISABLED') + ' this run.');
  console.log('Auto-trade is ' + (AUTO_TRADE_ENABLED ? 'ENABLED — confirmed ideas will execute without a tap' : 'disabled — every idea needs your confirm/deny') + '.');
  console.log(`Scan mode: ${SCAN_MODE} (source: ${shared && shared.scanMode ? 'dashboard-published config' : 'GitHub Variable / default'})` + (SCAN_MODE === 'filtered' ? ` — min OI $${FILTERED_MIN_OI}, min vol $${FILTERED_MIN_VOLUME_24H}, top ${FILTERED_TOP_N}` : ` — watchlist: ${WATCHLIST.join(', ')}`));

  // The circuit breaker (equity drawdown detection + emergency close-all) is checked and acted
  // on by poll_telegram.js, which has execution capability. This scanner only needs to respect
  // the flag once tripped — no point generating new ideas that could never execute anyway.
  const circuitBreaker = readJson(CIRCUIT_BREAKER_PATH, { tripped: false });
  if(circuitBreaker.tripped){
    console.log('Circuit breaker is tripped (' + (circuitBreaker.reason || 'severe drawdown') + ') — skipping this scan entirely until manually reset from the dashboard.');
    return;
  }

  const allCoins = await resolveCoins();
  if(!allCoins.length){ console.log('No coins resolved (empty watchlist, or filtered-universe thresholds too strict), exiting.'); return; }

  const state = readJson(STATE_PATH, { lastAiCallTime: 0, recentIds: [] });
  const feed = readJson(FEED_PATH, { recommendations: [] });

  // No point running any analysis — free or paid — if the account can't place even the smallest
  // possible order. Checked before anything else so a wallet with insufficient funds doesn't
  // burn API calls or Anthropic cost every single cycle. Also grabs open positions here so we
  // only need the one account fetch for both purposes.
  const accountSnapshot = await loadAccountSnapshot();
  const equityCheck = accountSnapshot.effectiveEquity;
  const openPositionCoins = accountSnapshot.openPositionCoins;
  if(equityCheck != null && equityCheck < MIN_ORDER_NOTIONAL){
    console.log(`Account equity ($${equityCheck.toFixed(2)}) is below Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum order value — skipping this scan entirely, no trade could be placed.`);
    const sinceLastAlert = Date.now() - (state.lastInsufficientEquityAlertTime || 0);
    if(sinceLastAlert > 6 * 60 * 60 * 1000){ // rate-limited to once per 6 hours, not every 15-min cycle
      const breakdown = `(queried on ${HL_EXEC_NETWORK} — Perps: $${(accountSnapshot.perpEquity||0).toFixed(2)}${accountSnapshot.perpFetchFailed?' — fetch FAILED':''}, Spot: $${(accountSnapshot.spotUsdc||0).toFixed(2)}${accountSnapshot.spotFetchFailed?' — fetch FAILED':''})`;
      await sendTelegram(
        `⚠ Scanning is paused — account equity is $${equityCheck.toFixed(2)} ${breakdown}, below Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum order value. `
        + `No trade could be placed regardless of what the scan finds, so it's skipped entirely (no API cost either) until funded. `
        + (accountSnapshot.perpFetchFailed || accountSnapshot.spotFetchFailed ? `⚠ One of the balance checks above failed to fetch — if your real balance is higher than shown, this is likely why; it should self-correct once that fetch succeeds again. ` : '')
        + `This will keep checking silently and resume automatically once equity is at least $${MIN_ORDER_NOTIONAL} — you won't get another alert like this for 6 hours.`
      );
      state.lastInsufficientEquityAlertTime = Date.now();
      writeJson(STATE_PATH, state);
    }
    return;
  } else if(equityCheck == null){
    console.log('HL_ACCOUNT_ADDRESS not configured for scan.js (optional) — skipping the equity pre-check and open-position exclusion. The scan will still run; execution-time checks in the poller remain the real safety net.');
  }

  // Technical checks run every time, unconditionally — they're free. Nothing below this line
  // is gated by any cooldown until the point where Anthropic itself might get called.
  console.log(`Checking signals (${SCAN_MODE} mode) for: ` + allCoins.join(', '));
  const signals = await loadSignals(allCoins);
  applyOiMomentum(signals, state);
  let tripped = findTrippedCoins(signals);

  if(openPositionCoins.size){
    const skippedForOpenPosition = tripped.filter(c => openPositionCoins.has(c));
    if(skippedForOpenPosition.length){
      console.log('Skipping (already have an open position): ' + skippedForOpenPosition.join(', '));
      tripped = tripped.filter(c => !openPositionCoins.has(c));
    }
  }

  if(!tripped.length){
    console.log('No signal tripped this run.');
    return;
  }
  console.log('=== PHASE 1 COMPLETE: scan/signal-check ===  Signal tripped on: ' + tripped.join(', '));

  console.log('=== PHASE 2 START: multi-timeframe + technical analysis ===');
  const mtfData = {};
  const alignments = {};
  for(const c of tripped){
    mtfData[c] = await loadMultiTimeframeTechnicals(c);
    alignments[c] = computeAlignment(mtfData[c]);
    console.log(`  ${c}: ${alignments[c].direction ? alignments[c].direction.toUpperCase() : 'no alignment'} (${alignments[c].agree}/${alignments[c].total} timeframes agree)`);
  }
  let scanCoins = tripped.filter(c => alignments[c].direction !== null);

  if(!scanCoins.length){
    console.log('No coin reached multi-timeframe alignment (need at least 2/3 of 15m/1h/4h agreeing). Nothing to do this run.');
    return;
  }

  // Don't pile up duplicate outstanding recommendations for a coin that's already pending review.
  const alreadyPending = new Set((feed.recommendations || []).filter(r => r.status === 'pending').map(r => r.coin));
  const skippedAsPending = scanCoins.filter(c => alreadyPending.has(c));
  scanCoins = scanCoins.filter(c => !alreadyPending.has(c));
  if(skippedAsPending.length) console.log('Skipping (already has a pending recommendation): ' + skippedAsPending.join(', '));
  if(!scanCoins.length){ console.log('Nothing new to propose this run.'); return; }

  const subsetSignals = {};
  scanCoins.forEach(c => { if(signals[c]) subsetSignals[c] = signals[c]; });
  const subsetMtf = {};
  const subsetAlignments = {};
  scanCoins.forEach(c => { subsetMtf[c] = mtfData[c]; subsetAlignments[c] = alignments[c]; });

  // The 15m timeframe stays the reference for stop/target math — appropriate near-term structure
  // for the quick-turnaround horizon this agent operates on.
  const technicals = {};
  scanCoins.forEach(c => { technicals[c] = mtfData[c]['15m']; });

  // Only the AI call itself is gated: by the toggle, and — when enabled — by a cooldown so it
  // doesn't fire on every single run. Technicals-only ideas are always free to generate.
  let newRecs;
  let usedFallback = false;
  const minGapMs = INTERVAL_MIN * 60000;
  const sinceLastAiCall = Date.now() - (state.lastAiCallTime || 0);

  if(!AI_RESEARCH_ENABLED){
    console.log('AI research is disabled via the toggle — generating technicals-only ideas.');
    newRecs = buildFallbackRecommendations(scanCoins, technicals, MAX_POSITION_PCT, MAX_LEVERAGE, MAX_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT);
    usedFallback = true;
  } else if(!ANTHROPIC_API_KEY){
    console.log('AI research is enabled but no ANTHROPIC_API_KEY is set — generating technicals-only ideas instead.');
    newRecs = buildFallbackRecommendations(scanCoins, technicals, MAX_POSITION_PCT, MAX_LEVERAGE, MAX_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT);
    usedFallback = true;
  } else if(sinceLastAiCall < minGapMs){
    console.log(`AI cooldown active (${Math.round(sinceLastAiCall/60000)}m of ${INTERVAL_MIN}m min gap) — using technicals-only this run instead of calling Anthropic.`);
    newRecs = buildFallbackRecommendations(scanCoins, technicals, MAX_POSITION_PCT, MAX_LEVERAGE, MAX_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT);
    usedFallback = true;
  } else {
    const { system, user } = buildAgentPrompt(subsetSignals, subsetMtf, subsetAlignments);
    console.log('Calling Anthropic (2x, self-consistency check) for research on: ' + scanCoins.join(', '));
    try{
      const parsed = await callAnthropicWithSelfConsistency(system, user);
      newRecs = parsed.recommendations || [];
    }catch(e){
      console.error('Anthropic call failed: ' + e.message);
      console.log('Continuing with technicals-only fallback.');
      newRecs = buildFallbackRecommendations(scanCoins, technicals, MAX_POSITION_PCT, MAX_LEVERAGE, MAX_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT);
      usedFallback = true;
    }
    state.lastAiCallTime = Date.now(); // resets the cooldown whether the call succeeded or failed
  }
  console.log('=== PHASE 2 COMPLETE: got ' + newRecs.length + ' recommendation(s)' + (usedFallback ? ' (technicals-only)' : ' (AI-researched, self-consistent)') + ' ===');

  // Final safety net regardless of source: a malformed rec must never reach Telegram or the
  // dashboard, where it would only fail cryptically later (e.g. "Unknown asset: undefined" from
  // Hyperliquid at confirm time) instead of being caught here with the actual cause visible.
  const beforeValidation = newRecs.length;
  newRecs = newRecs.filter(isValidRec);
  if(newRecs.length < beforeValidation){
    console.error(`Dropped ${beforeValidation - newRecs.length} malformed recommendation(s) missing a valid coin/direction/price — this points at an AI response schema issue.`);
  }

  // The AI should only ever recommend a coin we actually asked it about in this scan's prompt.
  // If it names something else — a colloquial name, an outdated symbol, a coin from a different
  // exchange — that's the exact scenario that produces "Unknown asset: undefined" from Hyperliquid
  // at execution time, since the exchange's own asset-name lookup would fail on that string. Catch
  // it here, at the source, rather than downstream.
  const beforeCoinCheck = newRecs.length;
  newRecs = newRecs.filter(rec => scanCoins.includes(rec.coin));
  if(newRecs.length < beforeCoinCheck){
    console.error(`Dropped ${beforeCoinCheck - newRecs.length} recommendation(s) naming a coin outside this scan's actual coin list (${scanCoins.join(', ')}) — likely the AI using an incorrect or unrecognized symbol.`);
  }

  if(!usedFallback){
    newRecs.forEach(rec => resolveRiskLevels(rec, technicals[rec.coin], MAX_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT, MAX_TAKE_PROFIT_PCT, MAX_ENTRY_DEVIATION_PCT));
    newRecs.forEach(rec => { rec.conviction = computeConviction(rec, technicals[rec.coin]); });
  } else {
    newRecs.forEach(rec => { rec.conviction = rec.conviction || 'low'; });
  }

  // Rank by our own computed confluence score (not the model's self-assessed conviction label).
  // Always sorted — not just when capping is needed — since the auto-trade eligibility check
  // below relies on index 0 genuinely being the top-ranked idea, even when there are only 1-2
  // candidates and no capping actually occurs.
  newRecs.sort((a,b) => (b.confluence_score || 0) - (a.confluence_score || 0));
  if(newRecs.length > MAX_RECS_PER_SCAN){
    const dropped = newRecs.slice(MAX_RECS_PER_SCAN).map(r => r.coin + ' (' + (r.confluence_score||0) + '/8)');
    newRecs = newRecs.slice(0, MAX_RECS_PER_SCAN);
    console.log(`Capped to top ${MAX_RECS_PER_SCAN} by confidence — dropped: ${dropped.join(', ')}`);
  }

  // Attach the 15m support/resistance and chart-pattern readout to each rec so it can be
  // relayed downstream (Telegram, dashboard) without needing to recompute it.
  newRecs.forEach(rec => {
    const t = technicals[rec.coin];
    if(t){
      rec.resistance_levels = (t.resistanceLevels || []).map(l => ({ price: parseFloat(l.price.toFixed(2)), tests: l.tests }));
      rec.support_levels = (t.supportLevels || []).map(l => ({ price: parseFloat(l.price.toFixed(2)), tests: l.tests }));
      rec.chart_patterns = t.chartPatterns || [];
    }
    rec.hyperliquid_url = hyperliquidChartUrl(rec.coin);
  });

  // Funds-required estimate: "X% of equity" is the notional position size, not the cash locked —
  // actual margin required is notional / leverage, which can be a meaningfully smaller number.
  // Reuses the equity value already fetched by the pre-scan check above — no extra API call.
  //
  // Hyperliquid rejects any order below $10 notional outright ("invalid size"). A small account
  // combined with a conservative suggested % can easily compute below that floor, so the
  // suggested % itself gets bumped up here — before it ever reaches Telegram — rather than
  // silently failing at execution or (worse) confusingly rejecting with no explanation. If
  // reaching $10 requires exceeding the configured max position %, that's flagged explicitly
  // rather than silently overridden — Hyperliquid's exchange floor wins over the setting since
  // there's no way to place a smaller order, but the person should always know when that happens.
  const estimatedEquity = equityCheck;
  newRecs.forEach(rec => {
    if(estimatedEquity && rec.suggested_size_pct_equity && rec.suggested_leverage){
      let notional = estimatedEquity * (rec.suggested_size_pct_equity / 100);
      if(notional < MIN_ORDER_NOTIONAL && estimatedEquity > 0){
        const originalPct = rec.suggested_size_pct_equity;
        const bumpedPct = (MIN_ORDER_NOTIONAL / estimatedEquity) * 100;
        rec.suggested_size_pct_equity = parseFloat(bumpedPct.toFixed(2));
        notional = MIN_ORDER_NOTIONAL;
        const exceedsCap = bumpedPct > MAX_POSITION_PCT + 0.01;
        rec.risk_flags = (rec.risk_flags || []).concat([
          exceedsCap
            ? `size increased from ${originalPct}% to ${bumpedPct.toFixed(1)}% of equity to meet Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum — exceeds your configured max position size (${MAX_POSITION_PCT}%); this account may be too small for your risk settings`
            : `size increased to ${bumpedPct.toFixed(1)}% of equity to meet Hyperliquid's $${MIN_ORDER_NOTIONAL} minimum order value`
        ]);
      }
      rec.estimated_notional = notional;
      rec.estimated_margin = notional / rec.suggested_leverage;
    }
  });

  console.log('=== PHASE 3 START: all analysis finalized, sending Telegram now for ' + newRecs.length + ' rec(s) ===');
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + EXECUTION_WINDOW_MIN * 60000).toISOString();
  newRecs.forEach((rec, idx) => {
    rec.id = shortId();
    rec.generated_at = now;
    rec.expires_at = expiresAt;
    rec.source = usedFallback ? 'backend-fallback' : 'backend';
    rec.status = 'pending';

    // Both top-2 recs still get sent for your review either way — this only controls which one
    // (if any) is eligible to execute *without* a tap. Only the single highest-ranked rec per
    // scan (idx === 0, since newRecs is already sorted by confluence_score at this point) can
    // ever qualify, and only if its score genuinely clears the bar — a second-place idea, even a
    // strong one, still requires your explicit confirm.
    const isTopPick = idx === 0;
    const score = rec.confluence_score || 0;
    rec.auto_trade = AUTO_TRADE_ENABLED && isTopPick && score >= AUTO_TRADE_MIN_SCORE;
    if(AUTO_TRADE_ENABLED && isTopPick && !rec.auto_trade){
      rec.risk_flags = (rec.risk_flags || []).concat([`auto-trade skipped — score ${score}/8 doesn't clear the ${AUTO_TRADE_MIN_SCORE}/8 bar, needs your manual confirm`]);
    }
    if(rec.auto_trade){
      const scale = AUTO_TRADE_SIZE_SCALE_BY_SCORE[score] != null ? AUTO_TRADE_SIZE_SCALE_BY_SCORE[score] : 1.0;
      if(scale < 1.0 && rec.suggested_size_pct_equity){
        const originalPct = rec.suggested_size_pct_equity;
        rec.suggested_size_pct_equity = parseFloat((originalPct * scale).toFixed(2));
        rec.risk_flags = (rec.risk_flags || []).concat([`auto-trade size reduced to ${(scale*100).toFixed(0)}% (${score}/8 score, below max confidence) — ${originalPct}% → ${rec.suggested_size_pct_equity}% of equity`]);
      }
    }
  });
  for(const rec of newRecs){

    const t15 = technicals[rec.coin];
    if(t15 && t15.recentCandles){
      // Persist the compact candle data too (not just the rendered image) so a dashboard-side
      // fallback render is still possible for recs that predate this, or if the file write fails.
      rec.chart_candles = t15.recentCandles;
      const chartConfig = buildChartConfig(rec.coin, t15.recentCandles, rec.entry_price, rec.stop_loss_price, rec.take_profit_price);
      const chartBuffer = await fetchChartImageBuffer(chartConfig);
      if(chartBuffer){
        const sent = await sendTelegramPhotoBuffer(chartBuffer, `${rec.coin} ${rec.direction === 'short' ? 'SHORT' : 'LONG'} — ${rec.pattern || ''}`.slice(0,200));
        rec.chart_image_sent = sent;
        if(!sent) console.error(`Chart image failed to send for ${rec.coin} — continuing with the text message anyway.`);

        // Also write the PNG as a static file the dashboard can load same-origin — no CORS,
        // no giant data-URL, no runtime dependency on QuickChart being reachable from the
        // person's browser at all. This is the version the dashboard should always prefer.
        try{
          if(!fs.existsSync(CHARTS_DIR)) fs.mkdirSync(CHARTS_DIR, { recursive: true });
          fs.writeFileSync(path.join(CHARTS_DIR, rec.id + '.png'), chartBuffer);
          rec.chart_image_path = 'charts/' + rec.id + '.png';
        }catch(e){
          console.error('Could not write chart image file (dashboard will fall back to live rendering):', e.message);
        }
      } else {
        console.error(`Chart image render failed for ${rec.coin} (QuickChart unreachable or errored) — continuing with the text message anyway.`);
        rec.chart_image_sent = false;
      }
    }

    // Uses rec.auto_trade specifically, not the global AUTO_TRADE_ENABLED toggle — a rec can
    // exist even when auto-trade is globally on but this particular one didn't qualify (not the
    // top pick, or below the score floor), and it must still show Confirm/Deny in that case.
    // Auto-trade recs get no buttons at all: execution is now reordered to happen before the
    // confirm/deny polling loop even starts, so a Cancel button here could never meaningfully
    // work regardless of how fast someone taps it — showing one anyway would be a false
    // affordance, not a real option.
    const replyMarkup = rec.auto_trade
      ? undefined
      : { inline_keyboard: [[
          { text: '✅ Confirm', callback_data: 'confirm:' + rec.id },
          { text: '❌ Deny', callback_data: 'deny:' + rec.id }
        ]] };
    const messageId = await sendTelegram(formatTelegramMessage(rec), replyMarkup);
    if(messageId){
      rec.telegram_message_id = messageId;
      rec.telegram_chat_id = TELEGRAM_CHAT_ID;
    } else {
      console.error(`Failed to send Telegram message for ${rec.coin} after retry — this recommendation will still appear in the dashboard, but no confirm/deny buttons went out.`);
    }
  }

  const trimmedOut = (feed.recommendations || []).slice(30);
  feed.recommendations = newRecs.concat(feed.recommendations || []).slice(0, 30);
  writeJson(FEED_PATH, feed);
  writeJson(STATE_PATH, state);

  // Delete chart image files for recs that just aged out of the feed, so docs/charts/ doesn't
  // grow unbounded in the git repo over time.
  trimmedOut.forEach(rec => {
    if(rec.chart_image_path){
      try{ fs.unlinkSync(path.join(__dirname, '..', 'docs', rec.chart_image_path)); }catch(e){ /* already gone or never wrote */ }
    }
  });

  // Signal to the workflow whether an auto-trade-eligible rec was generated this run. Without
  // this, the earliest an auto-trade could execute is whenever the poller's own next scheduled
  // run happens (up to 5 minutes) plus however far into its confirm/deny polling window that run
  // already is (up to ~2.5 more minutes) -- several minutes of pure waiting for something that's
  // supposed to be as fast as possible. This file (not committed to git -- deliberately outside
  // the git add list below) lets the workflow immediately dispatch the poller instead.
  if(newRecs.some(rec => rec.auto_trade)){
    try{
      fs.writeFileSync(path.join(__dirname, '..', 'auto_trade_pending.flag'), 'true');
      console.log('Auto-trade-eligible recommendation generated -- signaling the workflow to immediately trigger the poller.');
    }catch(e){ console.error('Could not write auto-trade flag file:', e.message); }
  }

  console.log('Done.');
}

main().then(() => process.exit(0)).catch(e => { console.error('Scan failed:', e); process.exit(1); });
