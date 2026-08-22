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
let MAX_POSITION_PCT = MAX_POSITION_PCT_DEFAULT;
let MAX_LEVERAGE = MAX_LEVERAGE_DEFAULT;
let DEFAULT_TAKE_PROFIT_PCT = DEFAULT_TAKE_PROFIT_PCT_DEFAULT;
const EXECUTION_WINDOW_MIN = parseFloat(process.env.EXECUTION_WINDOW_MIN || '180');
const MAX_PRICE_DRIFT_PCT = 2.5; // abort if price moved more than this since the recommendation was made

const INFO_URL = HL_EXEC_NETWORK === 'mainnet' ? 'https://api.hyperliquid.xyz/info' : 'https://api.hyperliquid-testnet.xyz/info';
const FEED_PATH = path.join(__dirname, '..', 'docs', 'recommendations.json');
const OFFSET_PATH = path.join(__dirname, 'telegram_offset.json');
const SHARED_CONFIG_PATH = path.join(__dirname, '..', 'docs', 'agent-config.json');
const POLL_BUDGET_MS = 4 * 60 * 1000; // stay comfortably under the 5-minute schedule

function readJson(p, fallback){ try{ return JSON.parse(fs.readFileSync(p, 'utf8')); }catch(e){ return fallback; } }
function writeJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function loadSharedConfig(){
  const shared = readJson(SHARED_CONFIG_PATH, null);
  if(!shared) return;
  if(shared.maxPositionPct) MAX_POSITION_PCT = parseFloat(shared.maxPositionPct);
  if(shared.maxLeverage) MAX_LEVERAGE = parseFloat(shared.maxLeverage);
  if(shared.defaultTakeProfitPct) DEFAULT_TAKE_PROFIT_PCT = parseFloat(shared.defaultTakeProfitPct);
  console.log(`Using dashboard-published risk config: max ${MAX_POSITION_PCT}% equity, ${MAX_LEVERAGE}x leverage, ${DEFAULT_TAKE_PROFIT_PCT}% default TP (updated ${shared.updated_at || 'unknown'})`);
}

async function tg(method, body){
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return res.json();
}

async function infoPost(body){
  const res = await fetch(INFO_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if(!res.ok) throw new Error('info ' + body.type + ' HTTP ' + res.status);
  return res.json();
}

function findRec(feed, id){ return (feed.recommendations || []).find(r => r.id === id); }

async function editStatusMessage(rec, text){
  if(!rec.telegram_message_id) return;
  try{
    await tg('editMessageText', {
      chat_id: rec.telegram_chat_id || TELEGRAM_CHAT_ID,
      message_id: rec.telegram_message_id,
      text,
      parse_mode: 'Markdown'
    });
  }catch(e){ console.error('Failed to edit Telegram message:', e.message); }
}

async function getCurrentMid(coin){
  const mids = await infoPost({ type: 'allMids' });
  return mids[coin] ? parseFloat(mids[coin]) : null;
}

async function getAccountEquity(){
  if(!HL_ACCOUNT_ADDRESS) return null;
  const state = await infoPost({ type: 'clearinghouseState', user: HL_ACCOUNT_ADDRESS });
  return parseFloat((state.marginSummary || {}).accountValue) || null;
}

async function executeTrade(rec){
  if(!HL_AGENT_PRIVATE_KEY || !HL_ACCOUNT_ADDRESS){
    throw new Error('Execution key not configured (HL_AGENT_PRIVATE_KEY / HL_ACCOUNT_ADDRESS missing)');
  }

  const currentMid = await getCurrentMid(rec.coin);
  if(!currentMid) throw new Error('No live price available for ' + rec.coin);

  const driftPct = Math.abs(currentMid - rec.entry_price) / rec.entry_price * 100;
  if(driftPct > MAX_PRICE_DRIFT_PCT){
    throw new Error(`Price moved ${driftPct.toFixed(2)}% since the recommendation (>${MAX_PRICE_DRIFT_PCT}% limit) — skipped for safety`);
  }

  const isBuy = rec.direction !== 'short';
  if(isBuy && !(rec.stop_loss_price < currentMid)) throw new Error('Stop-loss is no longer below current price — thesis looks invalidated');
  if(!isBuy && !(rec.stop_loss_price > currentMid)) throw new Error('Stop-loss is no longer above current price — thesis looks invalidated');

  const equity = await getAccountEquity();
  if(!equity) throw new Error('Could not read account equity to size the trade');

  const pctEquity = Math.min(rec.suggested_size_pct_equity || MAX_POSITION_PCT, MAX_POSITION_PCT);
  const leverage = Math.min(rec.suggested_leverage || 1, MAX_LEVERAGE);
  const notional = equity * (pctEquity / 100);
  const size = notional / currentMid;
  if(!size || size <= 0) throw new Error('Computed size was zero — check account equity and risk settings');

  const slippage = 0.03;
  const entryPx = isBuy ? currentMid * (1 + slippage) : currentMid * (1 - slippage);

  const orders = [{
    coin: rec.coin + '-PERP', is_buy: isBuy, sz: parseFloat(size.toFixed(5)),
    limit_px: parseFloat(entryPx.toFixed(2)), order_type: { limit: { tif: 'Ioc' } }, reduce_only: false
  }, {
    coin: rec.coin + '-PERP', is_buy: !isBuy, sz: parseFloat(size.toFixed(5)),
    limit_px: parseFloat(rec.stop_loss_price.toFixed(2)),
    order_type: { trigger: { isMarket: true, triggerPx: rec.stop_loss_price.toFixed(2), tpsl: 'sl' } }, reduce_only: true
  }];
  if(rec.take_profit_price){
    orders.push({
      coin: rec.coin + '-PERP', is_buy: !isBuy, sz: parseFloat(size.toFixed(5)),
      limit_px: parseFloat(rec.take_profit_price.toFixed(2)),
      order_type: { trigger: { isMarket: true, triggerPx: rec.take_profit_price.toFixed(2), tpsl: 'tp' } }, reduce_only: true
    });
  } else if(DEFAULT_TAKE_PROFIT_PCT){
    const mult = 1 + (DEFAULT_TAKE_PROFIT_PCT/100) * (isBuy ? 1 : -1);
    const tpPx = parseFloat((currentMid * mult).toFixed(2));
    orders.push({
      coin: rec.coin + '-PERP', is_buy: !isBuy, sz: parseFloat(size.toFixed(5)),
      limit_px: tpPx,
      order_type: { trigger: { isMarket: true, triggerPx: tpPx.toFixed(2), tpsl: 'tp' } }, reduce_only: true
    });
    rec.take_profit_price = tpPx;
  }

  const sdk = new Hyperliquid({
    enableWs: false,
    privateKey: HL_AGENT_PRIVATE_KEY,
    testnet: HL_EXEC_NETWORK !== 'mainnet',
    walletAddress: HL_ACCOUNT_ADDRESS
  });

  const result = await sdk.exchange.placeOrder({ orders, grouping: 'normalTpsl' });
  return { result, size, entryPx, leverage, pctEquity };
}

async function handleCallback(cb, feed){
  const fromId = String(cb.from && cb.from.id);
  const [action, id] = String(cb.data || '').split(':');

  if(fromId !== TELEGRAM_CHAT_ID){
    console.warn('Ignoring callback from unauthorized chat id:', fromId);
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not authorized.', show_alert: true });
    return;
  }

  const rec = findRec(feed, id);
  if(!rec || rec.status !== 'pending'){
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Already handled or expired.' });
    return;
  }

  if(Date.now() > new Date(rec.expires_at).getTime()){
    rec.status = 'expired';
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'This recommendation has expired.' });
    await editStatusMessage(rec, `⏰ *${rec.coin} ${rec.direction}* — expired before you responded.`);
    return;
  }

  if(action === 'deny'){
    rec.status = 'denied';
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Denied.' });
    await editStatusMessage(rec, `❌ *${rec.coin} ${rec.direction}* — denied.`);
    return;
  }

  if(action === 'confirm'){
    rec.status = 'processing';
    await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Executing…' });
    await editStatusMessage(rec, `⏳ *${rec.coin} ${rec.direction}* — confirmed, placing order…`);
    try{
      const { size, entryPx, leverage, pctEquity } = await executeTrade(rec);
      rec.status = 'executed';
      rec.executed_at = new Date().toISOString();
      await editStatusMessage(rec,
        `✅ *${rec.coin} ${rec.direction}* — executed on ${HL_EXEC_NETWORK}.\n` +
        `Size ${size.toFixed(5)} @ ~$${entryPx.toFixed(2)}, ${leverage}x, ${pctEquity.toFixed(1)}% of equity.\n` +
        `Stop $${rec.stop_loss_price}` + (rec.take_profit_price ? ` · Target $${rec.take_profit_price}` : '') + `.`
      );
    }catch(e){
      rec.status = 'failed';
      rec.error = e.message;
      await editStatusMessage(rec, `⚠ *${rec.coin} ${rec.direction}* — execution failed: ${e.message}`);
    }
  }
}

async function sweepExpired(feed){
  const now = Date.now();
  for(const rec of (feed.recommendations || [])){
    if(rec.status === 'pending' && rec.expires_at && now > new Date(rec.expires_at).getTime()){
      rec.status = 'expired';
      await editStatusMessage(rec, `⏰ *${rec.coin} ${rec.direction}* — expired, no response in time.`);
    }
  }
}

async function main(){
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){ console.log('Telegram not configured, exiting.'); return; }
  loadSharedConfig();

  let offsetState = readJson(OFFSET_PATH, { offset: 0 });
  const feed = readJson(FEED_PATH, { recommendations: [] });

  await sweepExpired(feed);

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

main().catch(e => { console.error('Poller failed:', e); process.exit(1); });
