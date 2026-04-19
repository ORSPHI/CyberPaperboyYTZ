// api/stocks.js — 多数据源股市数据（Stooq 主 + Yahoo v8 Chart 备）
// 覆盖全球15大股市，Stooq 失败时自动切换 Yahoo Finance v8 Chart API
// v8 Chart API 使用 query2 域名，与被封的 v7 Quote API 不同

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── 15大股市：每个市场配置 Stooq 符号列表 + Yahoo 备选符号 ──
  const MARKETS = [
    { name: 'S&P 500',     zh: '纽约',     flag: 'US', stooq: ['^spx'],             yahoo: '^GSPC' },
    { name: 'NASDAQ',      zh: '纳斯达克',  flag: 'US', stooq: ['^ndq', '^ndx'],     yahoo: '^IXIC' },
    { name: 'FTSE 100',    zh: '伦敦',     flag: 'GB', stooq: ['^ukx'],             yahoo: '^FTSE' },
    { name: 'Nikkei 225',  zh: '东京',     flag: 'JP', stooq: ['^nkx', '^n225'],    yahoo: '^N225' },
    { name: '上证综指',     zh: '上海',     flag: 'CN', stooq: ['^sha', '^sse'],     yahoo: '000001.SS' },
    { name: '深证成指',     zh: '深圳',     flag: 'CN', stooq: ['^szs', '^szc'],     yahoo: '399001.SZ' },
    { name: 'HSI',         zh: '香港',     flag: 'HK', stooq: ['^hsi'],             yahoo: '^HSI' },
    { name: 'EURO STOXX',  zh: '泛欧',     flag: 'EU', stooq: ['^sx5e'],            yahoo: '^STOXX50E' },
    { name: 'DAX',         zh: '法兰克福',  flag: 'DE', stooq: ['^dax', '^gdaxi'],   yahoo: '^GDAXI' },
    { name: 'TSX',         zh: '多伦多',    flag: 'CA', stooq: ['^tsx'],             yahoo: '^GSPTSE' },
    { name: 'BSE SENSEX',  zh: '孟买',     flag: 'IN', stooq: ['^bse30', '^sen'],   yahoo: '^BSESN' },
    { name: 'KOSPI',       zh: '首尔',     flag: 'KR', stooq: ['^kospi'],           yahoo: '^KS11' },
    { name: 'ASX 200',     zh: '悉尼',     flag: 'AU', stooq: ['^xjo', '^aord'],    yahoo: '^AXJO' },
    { name: 'STI',         zh: '新加坡',    flag: 'SG', stooq: ['^sti'],             yahoo: '^STI' },
    { name: 'TWII',        zh: '台北',     flag: 'TW', stooq: ['^twii', '^twi'],    yahoo: '^TWII' },
  ];

  try {
    // ── 所有市场并行请求，每个市场内部按顺序尝试多个源 ──
    const markets = await Promise.all(MARKETS.map(m => fetchMarketData(m)));
    return res.status(200).json({ markets, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({
      markets: MARKETS.map(m => ({ symbol: m.yahoo, name: m.name, zh: m.zh, flag: m.flag, error: true })),
      error: err.message,
      fetchedAt: new Date().toISOString(),
    });
  }
}

// ══════════════════════════════════════════════
// 每个市场的数据获取：Stooq → Yahoo v8 → 失败
// ══════════════════════════════════════════════
async function fetchMarketData(market) {
  const baseMeta = { name: market.name, zh: market.zh, flag: market.flag };

  // ── 第一层：尝试 Stooq（逐个符号）──
  for (const sym of market.stooq) {
    try {
      const data = await fetchStooq(sym);
      if (data) return { symbol: sym, ...baseMeta, ...data };
    } catch { /* 继续下一个符号 */ }
  }

  // ── 第二层：尝试 Yahoo Finance v8 Chart API（query2 域名）──
  try {
    const data = await fetchYahooV8(market.yahoo);
    if (data) return { symbol: market.yahoo, ...baseMeta, ...data };
  } catch { /* 继续 */ }

  // ── 第三层：尝试 Yahoo Finance v8（query1 域名作为最后手段）──
  try {
    const data = await fetchYahooV8(market.yahoo, 'query1.finance.yahoo.com');
    if (data) return { symbol: market.yahoo, ...baseMeta, ...data };
  } catch { /* 放弃 */ }

  // ── 全部失败 ──
  return { symbol: market.yahoo, ...baseMeta, error: true };
}

// ══════════════════════════════════════════════
// 数据源 1：Stooq CSV API
// ══════════════════════════════════════════════
async function fetchStooq(symbol) {
  // 注意：不对符号做 encodeURIComponent，Stooq 需要原始的 ^ 字符
  const url = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`;
  const csv = await fetchWithTimeout(url, 6000);

  if (!csv || typeof csv !== 'string') return null;

  const lines = csv.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // 解析第一行数据（跳过表头）
  const cols = lines[1].split(',');
  if (cols.length < 7) return null;

  const close = parseNum(cols[6]);
  if (close == null) return null;

  const open = parseNum(cols[3]);
  const date = (cols[1] || '').trim();
  const time = (cols[2] || '').trim();

  let change = 0, changePct = 0;
  if (open != null && open !== 0) {
    change = close - open;
    changePct = (change / open) * 100;
  }

  return {
    price: close,
    change: round2(change),
    changePct: round2(changePct),
    prevClose: open,
    state: inferState(date),
    currency: '',
    ts: `${date} ${time}`,
  };
}

// ══════════════════════════════════════════════
// 数据源 2：Yahoo Finance v8 Chart API
// 与被封的 v7 Quote API 不同，使用不同的端点和响应格式
// ══════════════════════════════════════════════
async function fetchYahooV8(symbol, host = 'query2.finance.yahoo.com') {
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=2d&interval=1d&includePrePost=false`;

  const text = await fetchWithTimeout(url, 8000, {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
  });

  const data = JSON.parse(text);
  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta;
  if (!meta || meta.regularMarketPrice == null) return null;

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;

  let change = 0, changePct = 0;
  if (prevClose && prevClose !== 0) {
    change = price - prevClose;
    changePct = (change / prevClose) * 100;
  }

  return {
    price: price,
    change: round2(change),
    changePct: round2(changePct),
    prevClose: prevClose || 0,
    state: meta.marketState || 'CLOSED',
    currency: meta.currency || '',
    ts: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '',
  };
}

// ══════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════
async function fetchWithTimeout(url, timeoutMs, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function parseNum(val) {
  if (!val || val.trim() === '' || val.trim().toUpperCase() === 'N/D') return null;
  const n = Number(val.trim());
  return isNaN(n) ? null : n;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function inferState(dateStr) {
  try {
    const clean = (dateStr || '').replace(/-/g, '');
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return clean === todayStr ? 'REGULAR' : 'CLOSED';
  } catch {
    return 'CLOSED';
  }
}
