// JARVIS Trade Agent — backend scanner
//
// Runs on a GitHub Actions schedule. Cheap, free order-book/volume checks happen
// every run; Anthropic (with web search) is only called when a coin actually trips
// a threshold, or a safety-net interval has elapsed with no trigger.
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

async function loadTechnicals(coin){
  try{
    const endTime = Date.now();
    const startTime = endTime - 15*60000*120; // ~120 x 15m candles, ~30h lookback
    const candles = await infoPost({ type:'candleSnapshot', req:{ coin, interval:'15m', startTime, endTime } });
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
    const bbMid = sma20;
    const bbSd = stddev(closes, 20);
    const bbUpper = (bbMid!=null && bbSd!=null) ? bbMid + 2*bbSd : null;
    const bbLower = (bbMid!=null && bbSd!=null) ? bbMid - 2*bbSd : null;
    const volSma20 = sma(vols, 20);
    const lastVol = vols[vols.length-1];
    const patterns = detectPatterns(opens, highs, lows, closes);
    const swingHigh = Math.max(...highs.slice(-50));
    const swingLow = Math.min(...lows.slice(-50));

    return {
      lastClose: closes[closes.length-1], rsi14, sma20, sma50,
      macd, macdSignal: signal, macdHist: hist,
      bbUpper, bbMid, bbLower, volSma20, lastVol, patterns, swingHigh, swingLow
    };
  }catch(e){ console.error('Technicals failed for ' + coin + ':', e.message); return null; }
}

function formatTechnicalLine(coin, t){
  if(!t) return coin + ': technical data unavailable';
  const fmt = (v,d) => v==null ? 'n/a' : v.toFixed(d);
  return coin + ': price $'+fmt(t.lastClose,2)+', RSI14 '+fmt(t.rsi14,1)
    + ', SMA20 $'+fmt(t.sma20,2)+' / SMA50 $'+fmt(t.sma50,2)
    + ', MACD '+fmt(t.macd,4)+' vs signal '+fmt(t.macdSignal,4)+' (hist '+fmt(t.macdHist,4)+')'
    + ', Bollinger $'+fmt(t.bbLower,2)+'–$'+fmt(t.bbUpper,2)+' (mid $'+fmt(t.bbMid,2)+')'
    + ', volume '+fmt(t.lastVol,0)+' vs 20-bar avg '+fmt(t.volSma20,0)
    + ', 50-bar range $'+fmt(t.swingLow,2)+'–$'+fmt(t.swingHigh,2)
    + ', candlestick patterns: '+(t.patterns.length ? t.patterns.join(', ') : 'none detected')
    + ' (15m candles)';
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

function buildAgentPrompt(signals, technicals){
  const techTable = Object.keys(technicals).map(coin => formatTechnicalLine(coin, technicals[coin])).join('\n');
  const rows = Object.values(signals);
  const supportTable = rows.map(r =>
    r.coin+': funding '+(r.funding*100).toFixed(4)+'%/8h, OI '+Math.round(r.openInterest)+', '
    + 'order-book imbalance '+(r.imbalance*100).toFixed(1)+'% ('+(r.imbalance>0?'bid-heavy':'ask-heavy')+'), '
    + 'spread '+(r.spreadPct!=null? r.spreadPct.toFixed(3)+'%':'n/a')+', '
    + '5m volume vs trailing avg '+r.volRatio.toFixed(2)+'x'
  ).join('\n');

  const system = "You are JARVIS's trading research sub-agent for a Hyperliquid perpetuals account, acting as a master chart technician. "
    + "Your PRIMARY basis for every recommendation must be technical analysis: candlestick chart patterns, confirmed by volume, and agreement from "
    + "popular indicators (RSI, MACD, Bollinger Bands, moving averages) — all computed for you below from real 15-minute candle data. Only recommend "
    + "a trade when the technical picture is genuinely compelling: a real pattern, confirmed by volume, with at least one indicator in agreement — "
    + "not a single signal in isolation, and never a trade with no identifiable pattern or indicator confluence. "
    + "After forming your technical view, do ONE quick supplementary web search per candidate for sentiment and social buzz (X/Twitter, Reddit, "
    + "crypto forums) and recent news — use this only to confirm or flag a conflict with the technical picture, never as the primary reason for a trade. "
    + "Your job: find VERY SHORT-TERM, QUICK-TURNAROUND trade opportunities only — think minutes to roughly 24 hours, not multi-day swing theses. "
    + "You NEVER place trades yourself; you only propose them for human review. "
    + "Return at most 3 ideas — only ones with genuine technical conviction; return fewer or none if nothing qualifies. "
    + "Every idea MUST include a concrete stop_loss_price, placed at a technically sensible level (e.g. beyond the pattern's invalidation point or recent swing). "
    + "Be concise: rationale <= 35 words, sentiment_note <= 20 words. "
    + "Respond with ONLY raw JSON (no markdown fences, no prose) matching exactly: "
    + '{"recommendations":[{"coin":string,"direction":"long"|"short","conviction":"low"|"medium"|"high",'
    + '"pattern":string,"indicators_confirming":[string],"sentiment_note":string,"rationale":string,"time_horizon":string,'
    + '"entry_price":number,"stop_loss_price":number,"take_profit_price":number|null,'
    + '"suggested_size_pct_equity":number,"suggested_leverage":number,"risk_flags":[string]}]}';

  const user = "Technical readout (primary evidence):\n" + techTable
    + "\n\nSupporting market data (funding/OI/book/volume):\n" + supportTable
    + "\n\nFind the best technically-confirmed, quick-turnaround opportunities right now among these coins (or state none if the technical picture isn't compelling for any of them).";
  return { system, user };
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

async function sendTelegram(text, replyMarkup){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.log('Telegram not configured, skipping send. Message would have been:\n' + text);
    return null;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true };
  if(replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if(!res.ok || !data.ok){ console.error('Telegram send failed:', data.description || res.status); return null; }
  return data.result.message_id;
}

function formatTelegramMessage(rec){
  const dir = rec.direction === 'short' ? 'SHORT' : 'LONG';
  const flags = (rec.risk_flags || []).length ? '\n⚠ ' + rec.risk_flags.join(', ') : '';
  const confirming = (rec.indicators_confirming || []).length ? rec.indicators_confirming.join(', ') : '—';
  return `*JARVIS Trade Agent* — ${rec.coin} ${dir} (${rec.conviction || 'low'} conviction)\n`
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
  if(!ANTHROPIC_API_KEY){ console.log('No ANTHROPIC_API_KEY set, exiting.'); return; }

  const shared = loadSharedConfig();
  if(shared && shared.paused){
    console.log('Scanner is paused via the dashboard. Skipping this run.');
    return;
  }
  if(shared){
    if(shared.watchlist) WATCHLIST = shared.watchlist.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    if(shared.scanMode) SCAN_MODE = shared.scanMode;
    if(shared.filteredTopN) FILTERED_TOP_N = parseInt(shared.filteredTopN, 10);
    if(shared.filteredMinOI) FILTERED_MIN_OI = parseFloat(shared.filteredMinOI);
    if(shared.filteredMinVolume24h) FILTERED_MIN_VOLUME_24H = parseFloat(shared.filteredMinVolume24h);
  }

  const allCoins = await resolveCoins();
  if(!allCoins.length){ console.log('No coins resolved (empty watchlist, or filtered-universe thresholds too strict), exiting.'); return; }

  const state = readJson(STATE_PATH, { lastFullScanTime: 0, recentIds: [] });
  const feed = readJson(FEED_PATH, { recommendations: [] });

  const minGapMs = INTERVAL_MIN * 60000;
  const maxGapMs = minGapMs * 4;
  const sinceLastScan = Date.now() - (state.lastFullScanTime || 0);

  if(sinceLastScan < minGapMs){
    console.log(`Cooldown active (${Math.round(sinceLastScan/60000)}m of ${INTERVAL_MIN}m min gap). Skipping.`);
    return;
  }

  console.log(`Checking signals (${SCAN_MODE} mode) for: ` + allCoins.join(', '));
  const signals = await loadSignals(allCoins);
  const tripped = findTrippedCoins(signals);

  let scanCoins = null;
  if(tripped.length){
    console.log('Signal tripped on: ' + tripped.join(', '));
    scanCoins = tripped;
  } else if(sinceLastScan >= maxGapMs){
    console.log('No signal tripped, running scheduled safety-net scan across full set.');
    scanCoins = allCoins;
  } else {
    console.log('No signal tripped, within safety-net window. Nothing to do.');
    return;
  }

  const subsetSignals = {};
  scanCoins.forEach(c => { if(signals[c]) subsetSignals[c] = signals[c]; });

  console.log('Computing technical readout (candlestick patterns, RSI, MACD, Bollinger, volume) for: ' + scanCoins.join(', '));
  const technicals = {};
  for(const c of scanCoins){ technicals[c] = await loadTechnicals(c); }

  const { system, user } = buildAgentPrompt(subsetSignals, technicals);

  console.log('Calling Anthropic for research on: ' + scanCoins.join(', '));
  const parsed = await callAnthropic(system, user);
  const newRecs = parsed.recommendations || [];
  console.log('Got ' + newRecs.length + ' recommendation(s).');

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + EXECUTION_WINDOW_MIN * 60000).toISOString();
  for(const rec of newRecs){
    rec.id = shortId();
    rec.generated_at = now;
    rec.expires_at = expiresAt;
    rec.source = 'backend';
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
    }
  }

  feed.recommendations = newRecs.concat(feed.recommendations || []).slice(0, 30);
  writeJson(FEED_PATH, feed);

  state.lastFullScanTime = Date.now();
  writeJson(STATE_PATH, state);

  console.log('Done.');
}

main().catch(e => { console.error('Scan failed:', e); process.exit(1); });
