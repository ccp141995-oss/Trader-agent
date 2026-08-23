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
const EXECUTION_WINDOW_MIN = parseFloat(process.env.EXECUTION_WINDOW_MIN || '180');
let MAX_STOP_LOSS_PCT = parseFloat(process.env.MAX_STOP_LOSS_PCT || '5');
let MAX_POSITION_PCT = parseFloat(process.env.MAX_POSITION_PCT || '5');
let MAX_LEVERAGE = parseFloat(process.env.MAX_LEVERAGE || '3');
let DEFAULT_TAKE_PROFIT_PCT = parseFloat(process.env.DEFAULT_TAKE_PROFIT_PCT || '3');
let AI_RESEARCH_ENABLED = (process.env.AI_RESEARCH_ENABLED || 'true').toLowerCase() !== 'false';

function shortId(){
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

const STATE_PATH = path.join(__dirname, 'state.json');
const FEED_PATH = path.join(__dirname, '..', 'docs', 'recommendations.json');
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
  return WATCHLIST;
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

function detectPatterns(opens, highs, lows, closes){
  const n = closes.length;
  if(n < 3) return [];
  const patterns = [];
  const o1=opens[n-1], c1=closes[n-1], h1=highs[n-1], l1=lows[n-1];
  const o2=opens[n-2], c2=closes[n-2];
  const body1 = Math.abs(c1-o1);
  const range1 = (h1-l1) || 1e-9;
  if(c2<o2 && c1>o1 && o1<=c2 && c1>=o2) patterns.push('bullish_engulfing');
  if(c2>o2 && c1<o1 && o1>=c2 && c1<=o2) patterns.push('bearish_engulfing');
  if(body1/range1 < 0.1) patterns.push('doji');
  const upperWick1 = h1 - Math.max(o1,c1);
  const lowerWick1 = Math.min(o1,c1) - l1;
  if(lowerWick1 >= 2*body1 && upperWick1 <= body1*0.5 && body1/range1 < 0.4) patterns.push('hammer');
  if(upperWick1 >= 2*body1 && lowerWick1 <= body1*0.5 && body1/range1 < 0.4) patterns.push('shooting_star');
  return patterns;
}

const MTF_INTERVALS = ['15m', '1h', '4h'];
const MTF_MS = { '15m': 15*60000, '1h': 60*60000, '4h': 4*60*60000 };
const MTF_LOOKBACK_BARS = 120;

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

// ---------------- Per-timeframe technicals ----------------
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
    const { resistanceLevels, supportLevels } = findSupportResistance(highs, lows);

    return {
      interval, lastClose: closes[closes.length-1], rsi14, sma20, sma50,
      macd, macdSignal: signal, macdHist: hist,
      bbUpper, bbMid: sma20, bbLower, volSma20: sma(vols,20), lastVol: vols[vols.length-1],
      patterns, swingHigh: Math.max(...highs.slice(-50)), swingLow: Math.min(...lows.slice(-50)),
      resistanceLevels, supportLevels
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
    return '  ' + iv + ': price $'+fmt(t.lastClose,2)+', RSI14 '+fmt(t.rsi14,1)
      + ', SMA20 $'+fmt(t.sma20,2)+'/SMA50 $'+fmt(t.sma50,2)
      + ', MACD hist '+fmt(t.macdHist,4)
      + ', Bollinger $'+fmt(t.bbLower,2)+'-$'+fmt(t.bbUpper,2)
      + ', patterns: '+(t.patterns.length ? t.patterns.join(', ') : 'none')
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
    + 'order-book imbalance '+(r.imbalance*100).toFixed(1)+'% ('+(r.imbalance>0?'bid-heavy':'ask-heavy')+'), '
    + 'spread '+(r.spreadPct!=null? r.spreadPct.toFixed(3)+'%':'n/a')+', '
    + '5m volume vs trailing avg '+r.volRatio.toFixed(2)+'x'
  ).join('\n');

  const system = "You are JARVIS's trading research sub-agent for a Hyperliquid perpetuals account, acting as a master chart technician. "
    + "Every coin below has ALREADY been confirmed to have multi-timeframe alignment (agreement across 15m/1h/4h) before reaching you — respect that "
    + "established direction; don't recommend the opposite direction from what's aligned unless the evidence is overwhelming and you say so explicitly. "
    + "Your PRIMARY basis for every recommendation must be technical analysis: candlestick chart patterns, confirmed by volume, agreement from popular "
    + "indicators (RSI, MACD, Bollinger Bands, moving averages) across timeframes, and support/resistance levels — including how many times each level "
    + "has been tested (more tests generally means a more significant level). Only recommend a trade when the technical picture is genuinely compelling. "
    + "After forming your technical view, do ONE quick supplementary web search per candidate for sentiment and social buzz (X/Twitter, Reddit, "
    + "crypto forums) and recent news — use this only to confirm or flag a conflict with the technical picture, never as the primary reason for a trade. "
    + "Your job: find VERY SHORT-TERM, QUICK-TURNAROUND trade opportunities only — think minutes to roughly 24 hours, not multi-day swing theses. "
    + "You NEVER place trades yourself; you only propose them for human review. "
    + "Return at most 3 ideas — only ones with genuine technical conviction; return fewer or none if nothing qualifies. "
    + "Every idea MUST include a concrete stop_loss_price, placed at a technically sensible level (e.g. beyond a tested support/resistance level or recent swing), "
    + "and ideally within about " + MAX_STOP_LOSS_PCT + "% of entry — trades needing a wider stop than that to make sense are usually not a fit here. "
    + "Be concise: rationale <= 35 words, sentiment_note <= 20 words. "
    + "Respond with ONLY raw JSON (no markdown fences, no prose) matching exactly: "
    + '{"recommendations":[{"coin":string,"direction":"long"|"short","conviction":"low"|"medium"|"high",'
    + '"pattern":string,"indicators_confirming":[string],"sentiment_note":string,"rationale":string,"time_horizon":string,'
    + '"entry_price":number,"stop_loss_price":number,"take_profit_price":number|null,'
    + '"suggested_size_pct_equity":number,"suggested_leverage":number,"risk_flags":[string]}]}';

  const user = "Multi-timeframe technical readout, including support/resistance levels and how many times each has been tested (primary evidence):\n\n" + techTable
    + "\n\nSupporting market data (funding/OI/book/volume):\n" + supportTable
    + "\n\nFind the best technically-confirmed, quick-turnaround opportunities right now among these coins (or state none if the technical picture isn't compelling for any of them).";
  return { system, user };
}

// ---------------- Risk-level resolution (AI value -> technical calc -> settings fallback) ----------------
function resolveRiskLevels(rec, technicals, maxStopLossPct, defaultTakeProfitPct){
  const isLong = rec.direction !== 'short';
  const entry = rec.entry_price;
  const t = technicals;
  const notes = [];

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

  rec.stop_loss_price = parseFloat(stop.toFixed(2));
  rec.take_profit_price = parseFloat(tp.toFixed(2));
  rec.risk_flags = (rec.risk_flags || []).concat(notes.filter(n => !n.includes('AI-suggested')));
  return rec;
}

// ---------------- Technicals-only fallback (used when Anthropic is unavailable, e.g. low credits) ----------------
function technicalOnlySignal(t){
  if(!t) return null;
  const bullPatterns = ['bullish_engulfing','hammer'];
  const bearPatterns = ['bearish_engulfing','shooting_star'];
  const hasBull = t.patterns.some(p => bullPatterns.includes(p));
  const hasBear = t.patterns.some(p => bearPatterns.includes(p));
  const macdBull = t.macdHist != null && t.macdHist > 0;
  const macdBear = t.macdHist != null && t.macdHist < 0;
  const nearLowerBand = t.bbLower != null && t.lastClose <= t.bbLower * 1.01;
  const nearUpperBand = t.bbUpper != null && t.lastClose >= t.bbUpper * 0.99;
  const rsiOversold = t.rsi14 != null && t.rsi14 < 35;
  const rsiOverbought = t.rsi14 != null && t.rsi14 > 65;

  const bullFactors = [hasBull && 'candlestick pattern', macdBull && 'MACD histogram positive', nearLowerBand && 'price at lower Bollinger Band', rsiOversold && 'RSI oversold'].filter(Boolean);
  const bearFactors = [hasBear && 'candlestick pattern', macdBear && 'MACD histogram negative', nearUpperBand && 'price at upper Bollinger Band', rsiOverbought && 'RSI overbought'].filter(Boolean);

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
      sentiment_note: 'Not available — Anthropic was unreachable (likely low credits), so this idea is technicals-only with no sentiment/news check.',
      rationale: 'Technical confluence only: ' + signal.confirming.join(', ') + '. No AI research performed.',
      time_horizon: 'Short-term (technical fallback)',
      entry_price: t.lastClose,
      stop_loss_price: null, take_profit_price: null,
      suggested_size_pct_equity: Math.max(1, Math.round((maxPositionPct/2) * 10) / 10),
      suggested_leverage: 1,
      risk_flags: ['technicals-only fallback — no sentiment/news confirmation']
    };
    rec = resolveRiskLevels(rec, t, maxStopLossPct, defaultTakeProfitPct);
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
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }]
    })
  });
  const data = await res.json();
  if(data.error) throw new Error(data.error.message || 'Anthropic API error');
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  let raw = textBlocks.join('\n').trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
  return JSON.parse(raw);
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
  const flags = (rec.risk_flags || []).length ? '\n⚠ ' + rec.risk_flags.join(', ') : '';
  const confirming = (rec.indicators_confirming || []).length ? rec.indicators_confirming.join(', ') : '—';
  const fallbackNote = rec.source === 'backend-fallback' ? '\n🔧 Technicals-only mode — Anthropic was unavailable, no sentiment/news check was done.' : '';
  return `🤖 JARVIS Trade Agent — ${rec.coin} ${dir} (${rec.conviction || 'low'} conviction)${fallbackNote}\n`
    + `Pattern: ${rec.pattern || '—'}\n`
    + `Confirming: ${confirming}\n`
    + `Why: ${rec.rationale || '—'}\n`
    + (rec.sentiment_note ? `Sentiment check: ${rec.sentiment_note}\n` : '')
    + `Horizon: ${rec.time_horizon || '—'}\n`
    + `Entry ~$${rec.entry_price} · Stop $${rec.stop_loss_price}` + (rec.take_profit_price ? ` · Target $${rec.take_profit_price}` : '') + `\n`
    + `Sized at ${rec.suggested_size_pct_equity}% of equity, ${rec.suggested_leverage}x leverage (capped by your configured limits at execution)${flags}\n`
    + `Expires in ${EXECUTION_WINDOW_MIN} min. Not financial advice — tap below to confirm or deny.`;
}

async function main(){
  const shared = loadSharedConfig();
  if(shared){
    if(shared.watchlist) WATCHLIST = shared.watchlist.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    if(shared.scanMode) SCAN_MODE = shared.scanMode;
    if(shared.filteredTopN) FILTERED_TOP_N = parseInt(shared.filteredTopN, 10);
    if(shared.filteredMinOI) FILTERED_MIN_OI = parseFloat(shared.filteredMinOI);
    if(shared.filteredMinVolume24h) FILTERED_MIN_VOLUME_24H = parseFloat(shared.filteredMinVolume24h);
    if(shared.maxStopLossPct) MAX_STOP_LOSS_PCT = parseFloat(shared.maxStopLossPct);
    if(shared.maxPositionPct) MAX_POSITION_PCT = parseFloat(shared.maxPositionPct);
    if(shared.maxLeverage) MAX_LEVERAGE = parseFloat(shared.maxLeverage);
    if(shared.defaultTakeProfitPct) DEFAULT_TAKE_PROFIT_PCT = parseFloat(shared.defaultTakeProfitPct);
    if(shared.aiResearchEnabled !== undefined) AI_RESEARCH_ENABLED = !!shared.aiResearchEnabled;
  }
  console.log('AI research is ' + (AI_RESEARCH_ENABLED ? 'ENABLED' : 'DISABLED') + ' this run.');

  const allCoins = await resolveCoins();
  if(!allCoins.length){ console.log('No coins resolved (empty watchlist, or filtered-universe thresholds too strict), exiting.'); return; }

  const state = readJson(STATE_PATH, { lastAiCallTime: 0, recentIds: [] });
  const feed = readJson(FEED_PATH, { recommendations: [] });

  // Technical checks run every time, unconditionally — they're free. Nothing below this line
  // is gated by any cooldown until the point where Anthropic itself might get called.
  console.log(`Checking signals (${SCAN_MODE} mode) for: ` + allCoins.join(', '));
  const signals = await loadSignals(allCoins);
  const tripped = findTrippedCoins(signals);

  if(!tripped.length){
    console.log('No signal tripped this run.');
    return;
  }
  console.log('Signal tripped on: ' + tripped.join(', '));

  console.log('Checking multi-timeframe alignment (15m/1h/4h) for: ' + tripped.join(', '));
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
    console.log('Calling Anthropic for research on: ' + scanCoins.join(', '));
    try{
      const parsed = await callAnthropic(system, user);
      newRecs = parsed.recommendations || [];
    }catch(e){
      console.error('Anthropic call failed: ' + e.message);
      console.log('Continuing with technicals-only fallback (no sentiment/news check this run).');
      newRecs = buildFallbackRecommendations(scanCoins, technicals, MAX_POSITION_PCT, MAX_LEVERAGE, MAX_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT);
      usedFallback = true;
    }
    state.lastAiCallTime = Date.now(); // resets the cooldown whether the call succeeded or failed
  }
  console.log('Got ' + newRecs.length + ' recommendation(s)' + (usedFallback ? ' (technicals-only)' : ' (AI-researched)') + '.');

  if(!usedFallback){
    newRecs.forEach(rec => resolveRiskLevels(rec, technicals[rec.coin], MAX_STOP_LOSS_PCT, DEFAULT_TAKE_PROFIT_PCT));
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + EXECUTION_WINDOW_MIN * 60000).toISOString();
  for(const rec of newRecs){
    rec.id = shortId();
    rec.generated_at = now;
    rec.expires_at = expiresAt;
    rec.source = usedFallback ? 'backend-fallback' : 'backend';
    rec.status = 'pending';
    const replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Confirm', callback_data: 'confirm:' + rec.id },
        { text: '❌ Deny', callback_data: 'deny:' + rec.id }
      ]]
    };
    const messageId = await sendTelegram(formatTelegramMessage(rec), replyMarkup);
    if(messageId){
      rec.telegram_message_id = messageId;
      rec.telegram_chat_id = TELEGRAM_CHAT_ID;
    } else {
      console.error(`Failed to send Telegram message for ${rec.coin} after retry — this recommendation will still appear in the dashboard, but no confirm/deny buttons went out.`);
    }
  }

  feed.recommendations = newRecs.concat(feed.recommendations || []).slice(0, 30);
  writeJson(FEED_PATH, feed);
  writeJson(STATE_PATH, state);

  console.log('Done.');
}

main().catch(e => { console.error('Scan failed:', e); process.exit(1); });
