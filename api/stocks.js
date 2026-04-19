// api/stocks.js — 全球市场体征（15股指 + 10商品 + 5汇率 + VIX）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MARKETS = [
    // ── 股指 15 ──
    { stooq: '^spx',   yahoo: '^GSPC',     zh: '标普500',    cat: 'idx', name: 'S&P 500' },
    { stooq: '^ndq',   yahoo: '^IXIC',     zh: '纳斯达克',   cat: 'idx', name: 'NASDAQ' },
    { stooq: '^ukx',   yahoo: '^FTSE',     zh: '伦敦',      cat: 'idx', name: 'FTSE 100' },
    { stooq: '^nkx',   yahoo: '^N225',     zh: '东京',      cat: 'idx', name: 'Nikkei' },
    { stooq: '^shc',   yahoo: '000001.SS', zh: '上海',      cat: 'idx', name: 'SSE' },
    { stooq: '^szc',   yahoo: '399001.SZ', zh: '深圳',      cat: 'idx', name: 'SZSE' },
    { stooq: '^hsi',   yahoo: '^HSI',      zh: '香港',      cat: 'idx', name: 'HSI' },
    { stooq: '^sx5e',  yahoo: '^STOXX50E', zh: '泛欧',      cat: 'idx', name: 'STOXX50' },
    { stooq: '^dax',   yahoo: '^GDAXI',    zh: '法兰克福',   cat: 'idx', name: 'DAX' },
    { stooq: '^tsx',   yahoo: '^GSPTSE',   zh: '多伦多',     cat: 'idx', name: 'TSX' },
    { stooq: '^sen',   yahoo: '^BSESN',    zh: '孟买',      cat: 'idx', name: 'SENSEX' },
    { stooq: '^kospi', yahoo: '^KS11',     zh: '首尔',      cat: 'idx', name: 'KOSPI' },
    { stooq: '^xjo',   yahoo: '^AXJO',     zh: '悉尼',      cat: 'idx', name: 'ASX200' },
    { stooq: '^sti',   yahoo: '^STI',      zh: '新加坡',     cat: 'idx', name: 'STI' },
    { stooq: '^twii',  yahoo: '^TWII',     zh: '台北',      cat: 'idx', name: 'TWII' },
    // ── 大宗商品 10 ──
    { stooq: 'xauusd', yahoo: 'GC=F',      zh: '黄金',      cat: 'cmd', name: 'Gold' },
    { stooq: 'xagusd', yahoo: 'SI=F',      zh: '白银',      cat: 'cmd', name: 'Silver' },
    { stooq: 'cl.f',   yahoo: 'CL=F',      zh: '原油WTI',   cat: 'cmd', name: 'WTI' },
    { stooq: 'cb.f',   yahoo: 'BZ=F',      zh: '布伦特',     cat: 'cmd', name: 'Brent' },
    { stooq: 'ng.f',   yahoo: 'NG=F',      zh: '天然气',     cat: 'cmd', name: 'NatGas' },
    { stooq: 'hg.f',   yahoo: 'HG=F',      zh: '铜',        cat: 'cmd', name: 'Copper' },
    { stooq: 'zs.f',   yahoo: 'ZS=F',      zh: '大豆',      cat: 'cmd', name: 'Soybean' },
    { stooq: 'zw.f',   yahoo: 'ZW=F',      zh: '小麦',      cat: 'cmd', name: 'Wheat' },
    { stooq: 'zc.f',   yahoo: 'ZC=F',      zh: '玉米',      cat: 'cmd', name: 'Corn' },
    { stooq: 'ct.f',   yahoo: 'CT=F',      zh: '棉花',      cat: 'cmd', name: 'Cotton' },
    // ── 汇率 5 ──
    { stooq: 'dx.f',   yahoo: 'DX-Y.NYB',  zh: '美元指数',   cat: 'fx',  name: 'DXY' },
    { stooq: 'eurusd', yahoo: 'EURUSD=X',  zh: '欧元/美元',  cat: 'fx',  name: 'EUR/USD' },
    { stooq: 'usdcny', yahoo: 'CNY=X',     zh: '美元/人民币', cat: 'fx',  name: 'USD/CNY' },
    { stooq: 'usdjpy', yahoo: 'JPY=X',     zh: '美元/日元',  cat: 'fx',  name: 'USD/JPY' },
    { stooq: 'gbpusd', yahoo: 'GBPUSD=X',  zh: '英镑/美元',  cat: 'fx',  name: 'GBP/USD' },
    // ── 风险 1 ──
    { stooq: '^vix',   yahoo: '^VIX',      zh: '恐慌指数',   cat: 'risk', name: 'VIX' },
  ];

  try {
    const stooqData = {};
    try {
      const symbols = MARKETS.map(m => m.stooq).join(';');
      const csv = await fetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(symbols)}&f=sd2t2ohlcv&h&e=csv`, 12000);
      if (csv) {
        const lines = csv.trim().split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = 1; i < lines.length; i++) {
          const c = lines[i].split(',');
          if (c.length < 7) continue;
          const sym = (c[0] || '').trim().toUpperCase();
          const close = toNum(c[6]);
          if (close == null) continue;
          stooqData[sym] = { date: (c[1]||'').trim(), time: (c[2]||'').trim(), open: toNum(c[3]), close };
        }
      }
    } catch {}

    const results = [];
    const needYahoo = [];
    for (const m of MARKETS) {
      const sd = stooqData[m.stooq.toUpperCase()];
      if (sd && sd.close != null) {
        let ch = 0, pct = 0;
        if (sd.open && sd.open !== 0) { ch = sd.close - sd.open; pct = (ch / sd.open) * 100; }
        results.push({ symbol: m.stooq, name: m.name, zh: m.zh, cat: m.cat, price: sd.close, change: r2(ch), changePct: r2(pct), prevClose: sd.open, state: isToday(sd.date) ? 'REGULAR' : 'CLOSED', currency: '', ts: `${sd.date} ${sd.time}` });
      } else {
        needYahoo.push({ idx: results.length, market: m });
        results.push({ symbol: m.stooq, name: m.name, zh: m.zh, cat: m.cat, error: true });
      }
    }

    if (needYahoo.length > 0) {
      const yr = await Promise.all(needYahoo.map(({ market }) => fetchYahoo(market.yahoo).catch(() => null)));
      for (let i = 0; i < needYahoo.length; i++) {
        if (yr[i]) { const m = needYahoo[i].market; results[needYahoo[i].idx] = { symbol: m.yahoo, name: m.name, zh: m.zh, cat: m.cat, ...yr[i] }; }
      }
    }
    return res.status(200).json({ markets: results, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({ markets: MARKETS.map(m => ({ symbol: m.stooq, name: m.name, zh: m.zh, cat: m.cat, error: true })), error: err.message, fetchedAt: new Date().toISOString() });
  }
}

async function fetchYahoo(symbol) {
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      const text = await fetchText(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d`, 8000, { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' });
      const meta = JSON.parse(text)?.chart?.result?.[0]?.meta;
      if (!meta || meta.regularMarketPrice == null) continue;
      const p = meta.regularMarketPrice, prev = meta.chartPreviousClose || meta.previousClose || 0;
      let ch = 0, pct = 0; if (prev > 0) { ch = p - prev; pct = (ch / prev) * 100; }
      return { price: p, change: r2(ch), changePct: r2(pct), prevClose: prev, state: meta.marketState || 'CLOSED', currency: meta.currency || '', ts: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '' };
    } catch { continue; }
  }
  return null;
}

async function fetchText(url, ms, extraH = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': '*/*', ...extraH } }); clearTimeout(t); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
  catch (e) { clearTimeout(t); throw e; }
}
function toNum(v) { if (!v || !v.trim() || v.trim().toUpperCase() === 'N/D') return null; const n = Number(v.trim()); return isNaN(n) ? null : n; }
function r2(n) { return Math.round(n * 100) / 100; }
function isToday(ds) { try { return (ds || '').replace(/-/g, '') === new Date().toISOString().slice(0, 10).replace(/-/g, ''); } catch { return false; } }
