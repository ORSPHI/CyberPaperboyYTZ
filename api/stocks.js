// api/stocks.js — 全球市场体征数据（股指 + 商品 + 汇率 + 风险指标）
// 策略：Stooq 批量请求 → Yahoo v8 补救

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MARKETS = [
    // ── 股指（15个）──
    { stooq: '^spx',   yahoo: '^GSPC',      name: 'S&P 500',     zh: '标普500',   flag: 'US', cat: 'idx' },
    { stooq: '^ndq',   yahoo: '^IXIC',      name: 'NASDAQ',      zh: '纳斯达克',  flag: 'US', cat: 'idx' },
    { stooq: '^ukx',   yahoo: '^FTSE',      name: 'FTSE 100',    zh: '伦敦',     flag: 'GB', cat: 'idx' },
    { stooq: '^nkx',   yahoo: '^N225',      name: 'Nikkei 225',  zh: '东京',     flag: 'JP', cat: 'idx' },
    { stooq: '^shc',   yahoo: '000001.SS',  name: '上证综指',     zh: '上海',     flag: 'CN', cat: 'idx' },
    { stooq: '^szc',   yahoo: '399001.SZ',  name: '深证成指',     zh: '深圳',     flag: 'CN', cat: 'idx' },
    { stooq: '^hsi',   yahoo: '^HSI',       name: 'HSI',         zh: '香港',     flag: 'HK', cat: 'idx' },
    { stooq: '^sx5e',  yahoo: '^STOXX50E',  name: 'EURO STOXX',  zh: '泛欧',     flag: 'EU', cat: 'idx' },
    { stooq: '^dax',   yahoo: '^GDAXI',     name: 'DAX',         zh: '法兰克福',  flag: 'DE', cat: 'idx' },
    { stooq: '^tsx',   yahoo: '^GSPTSE',    name: 'TSX',         zh: '多伦多',    flag: 'CA', cat: 'idx' },
    { stooq: '^sen',   yahoo: '^BSESN',     name: 'BSE SENSEX',  zh: '孟买',     flag: 'IN', cat: 'idx' },
    { stooq: '^kospi', yahoo: '^KS11',      name: 'KOSPI',       zh: '首尔',     flag: 'KR', cat: 'idx' },
    { stooq: '^xjo',   yahoo: '^AXJO',      name: 'ASX 200',     zh: '悉尼',     flag: 'AU', cat: 'idx' },
    { stooq: '^sti',   yahoo: '^STI',       name: 'STI',         zh: '新加坡',    flag: 'SG', cat: 'idx' },
    { stooq: '^twii',  yahoo: '^TWII',      name: 'TWII',        zh: '台北',     flag: 'TW', cat: 'idx' },
    // ── 大宗商品 ──
    { stooq: 'xauusd', yahoo: 'GC=F',       name: 'Gold',        zh: '黄金',     flag: '',   cat: 'cmd' },
    { stooq: 'cl.f',   yahoo: 'CL=F',       name: 'WTI Crude',   zh: '原油WTI',  flag: '',   cat: 'cmd' },
    { stooq: 'ng.f',   yahoo: 'NG=F',       name: 'Natural Gas',  zh: '天然气',   flag: '',   cat: 'cmd' },
    // ── 汇率 ──
    { stooq: 'dx.f',   yahoo: 'DX-Y.NYB',   name: 'DXY',         zh: '美元指数',  flag: '',   cat: 'fx' },
    { stooq: 'eurusd', yahoo: 'EURUSD=X',   name: 'EUR/USD',     zh: '欧元/美元', flag: '',   cat: 'fx' },
    { stooq: 'usdcny', yahoo: 'CNY=X',      name: 'USD/CNY',     zh: '美元/人民币',flag: '',  cat: 'fx' },
    // ── 风险指标 ──
    { stooq: '^vix',   yahoo: '^VIX',       name: 'VIX',         zh: '恐慌指数',  flag: '',   cat: 'risk' },
  ];

  try {
    // ═══ Stooq 批量请求 ═══
    const stooqData = {};
    try {
      const symbols = MARKETS.map(m => m.stooq).join(';');
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbols)}&f=sd2t2ohlcv&h&e=csv`;
      const csv = await fetchText(url, 12000);
      if (csv) {
        const lines = csv.trim().split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length < 7) continue;
          const sym   = (cols[0] || '').trim().toUpperCase();
          const date  = (cols[1] || '').trim();
          const time  = (cols[2] || '').trim();
          const open  = toNum(cols[3]);
          const close = toNum(cols[6]);
          if (close == null) continue;
          stooqData[sym] = { date, time, open, close };
        }
      }
    } catch {}

    // ═══ 组装结果 ═══
    const results = [];
    const needYahoo = [];

    for (const m of MARKETS) {
      const key = m.stooq.toUpperCase();
      const sd = stooqData[key];
      if (sd && sd.close != null) {
        let change = 0, changePct = 0;
        if (sd.open != null && sd.open !== 0) {
          change = sd.close - sd.open;
          changePct = (change / sd.open) * 100;
        }
        results.push({
          symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, cat: m.cat,
          price: sd.close, change: r2(change), changePct: r2(changePct),
          prevClose: sd.open, state: isToday(sd.date) ? 'REGULAR' : 'CLOSED',
          currency: '', ts: `${sd.date} ${sd.time}`,
        });
      } else {
        needYahoo.push({ idx: results.length, market: m });
        results.push({ symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, cat: m.cat, error: true });
      }
    }

    // ═══ Yahoo v8 补救 ═══
    if (needYahoo.length > 0) {
      const yahooResults = await Promise.all(
        needYahoo.map(({ market }) => fetchYahoo(market.yahoo).catch(() => null))
      );
      for (let i = 0; i < needYahoo.length; i++) {
        const yd = yahooResults[i];
        if (yd) {
          const m = needYahoo[i].market;
          results[needYahoo[i].idx] = {
            symbol: m.yahoo, name: m.name, zh: m.zh, flag: m.flag, cat: m.cat, ...yd,
          };
        }
      }
    }

    return res.status(200).json({ markets: results, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({
      markets: MARKETS.map(m => ({ symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, cat: m.cat, error: true })),
      error: err.message, fetchedAt: new Date().toISOString(),
    });
  }
}

async function fetchYahoo(symbol) {
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d`;
      const text = await fetchText(url, 8000, {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      });
      const data = JSON.parse(text);
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta || meta.regularMarketPrice == null) continue;
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose || meta.previousClose || 0;
      let change = 0, changePct = 0;
      if (prev > 0) { change = price - prev; changePct = (change / prev) * 100; }
      return {
        price, change: r2(change), changePct: r2(changePct), prevClose: prev,
        state: meta.marketState || 'CLOSED', currency: meta.currency || '',
        ts: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '',
      };
    } catch { continue; }
  }
  return null;
}

async function fetchText(url, ms, extraH = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*', ...extraH },
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) { clearTimeout(t); throw e; }
}

function toNum(v) {
  if (!v || !v.trim() || v.trim().toUpperCase() === 'N/D') return null;
  const n = Number(v.trim()); return isNaN(n) ? null : n;
}
function r2(n) { return Math.round(n * 100) / 100; }
function isToday(ds) {
  try { return (ds||'').replace(/-/g,'') === new Date().toISOString().slice(0,10).replace(/-/g,''); }
  catch { return false; }
}
