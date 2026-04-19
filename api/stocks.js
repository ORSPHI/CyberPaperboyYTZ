// api/stocks.js — 全球15大股市数据
// 策略：一次 Stooq 批量请求（不触发速率限制）→ 失败的用 Yahoo v8 逐个补救
// 已验证 Stooq 批量请求可获取约5个指数，Yahoo v8 可补救部分

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MARKETS = [
    { stooq: '^spx',   yahoo: '^GSPC',      name: 'S&P 500',     zh: '纽约',     flag: 'US' },
    { stooq: '^ndq',   yahoo: '^IXIC',      name: 'NASDAQ',      zh: '纳斯达克',  flag: 'US' },
    { stooq: '^ukx',   yahoo: '^FTSE',      name: 'FTSE 100',    zh: '伦敦',     flag: 'GB' },
    { stooq: '^nkx',   yahoo: '^N225',      name: 'Nikkei 225',  zh: '东京',     flag: 'JP' },
    { stooq: '^shc',   yahoo: '000001.SS',  name: '上证综指',     zh: '上海',     flag: 'CN' },
    { stooq: '^szc',   yahoo: '399001.SZ',  name: '深证成指',     zh: '深圳',     flag: 'CN' },
    { stooq: '^hsi',   yahoo: '^HSI',       name: 'HSI',         zh: '香港',     flag: 'HK' },
    { stooq: '^sx5e',  yahoo: '^STOXX50E',  name: 'EURO STOXX',  zh: '泛欧',     flag: 'EU' },
    { stooq: '^dax',   yahoo: '^GDAXI',     name: 'DAX',         zh: '法兰克福',  flag: 'DE' },
    { stooq: '^tsx',   yahoo: '^GSPTSE',    name: 'TSX',         zh: '多伦多',    flag: 'CA' },
    { stooq: '^sen',   yahoo: '^BSESN',     name: 'BSE SENSEX',  zh: '孟买',     flag: 'IN' },
    { stooq: '^kospi', yahoo: '^KS11',      name: 'KOSPI',       zh: '首尔',     flag: 'KR' },
    { stooq: '^xjo',   yahoo: '^AXJO',      name: 'ASX 200',     zh: '悉尼',     flag: 'AU' },
    { stooq: '^sti',   yahoo: '^STI',       name: 'STI',         zh: '新加坡',    flag: 'SG' },
    { stooq: '^twii',  yahoo: '^TWII',      name: 'TWII',        zh: '台北',     flag: 'TW' },
  ];

  try {
    // ═══ 第一步：Stooq 批量请求（一次请求，不触发速率限制）═══
    const stooqData = {};
    try {
      const symbols = MARKETS.map(m => m.stooq).join(';');
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbols)}&f=sd2t2ohlcv&h&e=csv`;
      const csv = await fetchText(url, 12000);
      if (csv) {
        const lines = csv.trim().split('\n').map(l => l.trim()).filter(Boolean);
        // 跳过表头，解析每一行
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
    } catch { /* Stooq 整体失败，继续用 Yahoo */ }

    // ═══ 第二步：组装结果，识别哪些需要 Yahoo 补救 ═══
    const results = [];
    const needYahoo = [];

    for (const m of MARKETS) {
      const key = m.stooq.toUpperCase();
      const sd = stooqData[key];
      if (sd && sd.close != null) {
        // Stooq 成功
        let change = 0, changePct = 0;
        if (sd.open != null && sd.open !== 0) {
          change = sd.close - sd.open;
          changePct = (change / sd.open) * 100;
        }
        results.push({
          symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag,
          price: sd.close,
          change: r2(change),
          changePct: r2(changePct),
          prevClose: sd.open,
          state: isToday(sd.date) ? 'REGULAR' : 'CLOSED',
          currency: '', ts: `${sd.date} ${sd.time}`,
        });
      } else {
        // 需要 Yahoo 补救
        needYahoo.push({ idx: results.length, market: m });
        results.push({ symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, error: true });
      }
    }

    // ═══ 第三步：Yahoo v8 Chart API 补救失败的市场（并行请求）═══
    if (needYahoo.length > 0) {
      const yahooResults = await Promise.all(
        needYahoo.map(({ market }) => fetchYahoo(market.yahoo).catch(() => null))
      );
      for (let i = 0; i < needYahoo.length; i++) {
        const yd = yahooResults[i];
        if (yd) {
          const m = needYahoo[i].market;
          results[needYahoo[i].idx] = {
            symbol: m.yahoo, name: m.name, zh: m.zh, flag: m.flag, ...yd,
          };
        }
      }
    }

    return res.status(200).json({ markets: results, fetchedAt: new Date().toISOString() });

  } catch (err) {
    return res.status(200).json({
      markets: MARKETS.map(m => ({ symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, error: true })),
      error: err.message,
      fetchedAt: new Date().toISOString(),
    });
  }
}

// ── Yahoo Finance v8 Chart API ──
async function fetchYahoo(symbol) {
  // 依次尝试 query2 和 query1
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

// ── 工具函数 ──
async function fetchText(url, ms, extraH = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*', ...extraH,
      },
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) { clearTimeout(t); throw e; }
}

function toNum(v) {
  if (!v || !v.trim() || v.trim().toUpperCase() === 'N/D') return null;
  const n = Number(v.trim());
  return isNaN(n) ? null : n;
}

function r2(n) { return Math.round(n * 100) / 100; }

function isToday(ds) {
  try {
    return (ds || '').replace(/-/g, '') === new Date().toISOString().slice(0, 10).replace(/-/g, '');
  } catch { return false; }
}
