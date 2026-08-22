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
const WATCHLIST = (process.env.WATCHLIST || 'BTC,ETH,SOL,HYPE').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SENSITIVITY = (process.env.SIGNAL_SENSITIVITY || 'medium').toLowerCase();
const INTERVAL_MIN = parseFloat(process.env.AUTO_SCAN_INTERVAL_MIN || '30');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STATE_PATH = path.join(__dirname, 'state.json');
const FEED_PATH = path.join(__dirname, '..', 'docs', 'recommendations.json');

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

function buildAgentPrompt(signals){
  const rows = Object.values(signals);
  const table = rows.map(r =>
    r.coin+': mark $'+r.markPx.toFixed(2)+', 24h '+(r.chg24hPct>=0?'+':'')+r.chg24hPct.toFixed(2)+'%, '
    + 'funding '+(r.funding*100).toFixed(4)+'%/8h, OI '+Math.round(r.openInterest)+', '
    + 'order-book imbalance '+(r.imbalance*100).toFixed(1)+'% ('+(r.imbalance>0?'bid-heavy':'ask-heavy')+'), '
    + 'spread '+(r.spreadPct!=null? r.spreadPct.toFixed(3)+'%':'n/a')+', '
    + '5m volume vs trailing avg '+r.volRatio.toFixed(2)+'x'
  ).join('\n');

  const system = "You are JARVIS's trading research sub-agent for a Hyperliquid perpetuals account. "
    + "Your job: find VERY SHORT-TERM, QUICK-TURNAROUND trade opportunities only — think minutes to roughly 24 hours, not multi-day swing theses — "
    + "with an early, near-term catalyst. Research using social media sentiment (X/Twitter, Reddit, crypto forums), recent economic and geopolitical "
    + "news, and company/industry/sector news and trends. You have web search — use it. Combine what you find with the funding, open-interest, "
    + "order-book imbalance and volume-spike readings provided below; a volume spike or heavy book imbalance alongside a real news/sentiment catalyst "
    + "is a stronger signal than either alone, but do not recommend a trade on technical signals alone with no identifiable catalyst. "
    + "You NEVER place trades yourself; you only propose them for human review. "
    + "Return at most 3 ideas — only ones with genuine quick-turnaround conviction; return fewer or none if nothing qualifies. "
    + "Every idea MUST include a concrete stop_loss_price. Be concise: rationale <= 35 words, catalyst <= 15 words. "
    + "Respond with ONLY raw JSON (no markdown fences, no prose) matching exactly: "
    + '{"recommendations":[{"coin":string,"direction":"long"|"short","conviction":"low"|"medium"|"high",'
    + '"catalyst":string,"rationale":string,"time_horizon":string,"entry_price":number,"stop_loss_price":number,'
    + '"take_profit_price":number|null,"suggested_size_pct_equity":number,"suggested_leverage":number,"risk_flags":[string]}]}';

  const user = "Watchlist market + order-book + volume context (coins that tripped a signal threshold):\n" + table
    + "\n\nFind the best quick-turnaround opportunities right now among these coins (or state none if nothing compelling).";
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

async function sendTelegram(text){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    console.log('Telegram not configured, skipping send. Message would have been:\n' + text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true })
  });
  if(!res.ok) console.error('Telegram send failed: HTTP ' + res.status);
}

function formatTelegramMessage(rec){
  const dir = rec.direction === 'short' ? 'SHORT' : 'LONG';
  const flags = (rec.risk_flags || []).length ? '\n⚠ ' + rec.risk_flags.join(', ') : '';
  return `*JARVIS Trade Agent* — ${rec.coin} ${dir} (${rec.conviction || 'low'} conviction)\n`
    + `Catalyst: ${rec.catalyst || '—'}\n`
    + `Why: ${rec.rationale || '—'}\n`
    + `Horizon: ${rec.time_horizon || '—'}\n`
    + `Entry ~$${rec.entry_price} · Stop $${rec.stop_loss_price}` + (rec.take_profit_price ? ` · Target $${rec.take_profit_price}` : '') + `\n`
    + `Suggested size: ${rec.suggested_size_pct_equity}% of equity, ${rec.suggested_leverage}x leverage${flags}\n`
    + `Not financial advice. Review and confirm in the dashboard before anything is placed.`;
}

async function main(){
  if(!ANTHROPIC_API_KEY){ console.log('No ANTHROPIC_API_KEY set, exiting.'); return; }
  if(!WATCHLIST.length){ console.log('Empty watchlist, exiting.'); return; }

  const state = readJson(STATE_PATH, { lastFullScanTime: 0, recentIds: [] });
  const feed = readJson(FEED_PATH, { recommendations: [] });

  const minGapMs = INTERVAL_MIN * 60000;
  const maxGapMs = minGapMs * 4;
  const sinceLastScan = Date.now() - (state.lastFullScanTime || 0);

  if(sinceLastScan < minGapMs){
    console.log(`Cooldown active (${Math.round(sinceLastScan/60000)}m of ${INTERVAL_MIN}m min gap). Skipping.`);
    return;
  }

  console.log('Checking signals for: ' + WATCHLIST.join(', '));
  const signals = await loadSignals(WATCHLIST);
  const tripped = findTrippedCoins(signals);

  let scanCoins = null;
  if(tripped.length){
    console.log('Signal tripped on: ' + tripped.join(', '));
    scanCoins = tripped;
  } else if(sinceLastScan >= maxGapMs){
    console.log('No signal tripped, running scheduled safety-net scan across full watchlist.');
    scanCoins = WATCHLIST;
  } else {
    console.log('No signal tripped, within safety-net window. Nothing to do.');
    return;
  }

  const subsetSignals = {};
  scanCoins.forEach(c => { if(signals[c]) subsetSignals[c] = signals[c]; });
  const { system, user } = buildAgentPrompt(subsetSignals);

  console.log('Calling Anthropic for research on: ' + scanCoins.join(', '));
  const parsed = await callAnthropic(system, user);
  const newRecs = parsed.recommendations || [];
  console.log('Got ' + newRecs.length + ' recommendation(s).');

  const now = new Date().toISOString();
  for(const rec of newRecs){
    rec.id = rec.coin + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,7);
    rec.generated_at = now;
    rec.source = 'backend';
    await sendTelegram(formatTelegramMessage(rec));
  }

  feed.recommendations = newRecs.concat(feed.recommendations || []).slice(0, 30);
  writeJson(FEED_PATH, feed);

  state.lastFullScanTime = Date.now();
  writeJson(STATE_PATH, state);

  console.log('Done.');
}

main().catch(e => { console.error('Scan failed:', e); process.exit(1); });
