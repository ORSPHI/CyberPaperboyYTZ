// api/stocks.js — 全球15大股市数据（三层数据源瀑布架构）
// 第一层：Stooq 历史数据端点 /q/d/l/（覆盖广，pandas-datareader 同款端点）
// 第二层：Stooq 实时报价端点 /q/l/（覆盖窄但数据更新）
// 第三层：Yahoo Finance v8 Chart API（query2 域名，备用）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── 15大股市配置 ──
  const MARKETS = [
    { name: 'S&P 500',     zh: '纽约',     flag: 'US', stooq: '^spx',   yahoo: '^GSPC' },
    { name: 'NASDAQ',      zh: '纳斯达克',  flag: 'US', stooq: '^ndq',   yahoo: '^IXIC' },
    { name: 'FTSE 100',    zh: '伦敦',     flag: 'GB', stooq: '^ukx',   yahoo: '^FTSE' },
    { name: 'Nikkei 225',  zh: '东京',     flag: 'JP', stooq: '^nkx',   yahoo: '^N225' },
    { name: '上证综指',     zh: '上海',     flag: 'CN', stooq: '^shc',   yahoo: '000001.SS' },
    { name: '深证成指',     zh: '深圳',     flag: 'CN', stooq: '^szc',   yahoo: '399001.SZ' },
    { name: 'HSI',         zh: '香港',     flag: 'HK', stooq: '^hsi',   yahoo: '^HSI' },
    { name: 'EURO STOXX',  zh: '泛欧',     flag: 'EU', stooq: '^sx5e',  yahoo: '^STOXX50E' },
    { name: 'DAX',         zh: '法兰克福',  flag: 'DE', stooq: '^dax',   yahoo: '^GDAXI' },
    { name: 'TSX',         zh: '多伦多',    flag: 'CA', stooq: '^tsx',   yahoo: '^GSPTSE' },
    { name: 'BSE SENSEX',  zh: '孟买',     flag: 'IN', stooq: '^sen',   yahoo: '^BSESN' },
    { name: 'KOSPI',       zh: '首尔',     flag: 'KR', stooq: '^kospi', yahoo: '^KS11' },
    { name: 'ASX 200',     zh: '悉尼',     flag: 'AU', stooq: '^xjo',   yahoo: '^AXJO' },
    { name: 'STI',         zh: '新加坡',    flag: 'SG', stooq: '^sti',   yahoo: '^STI' },
    { name: 'TWII',        zh: '台北',     flag: 'TW', stooq: '^twii',  yahoo: '^TWII' },
  ];

  try {
    // 所有市场并行请求
    const markets = await Promise.all(MARKETS.map(m => fetchMarketData(m)));
    return res.status(200).json({ markets, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({
      markets: MARKETS.map(m => ({ symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, error: true })),
      error: err.message,
      fetchedAt: new Date().toISOString(),
    });
  }
}

// ══════════════════════════════════════════════
// 每个市场的三层瀑布请求
// ══════════════════════════════════════════════
async function fetchMarketData(market) {
  const base = { name: market.name, zh: market.zh, flag: market.flag };

  // ── 第一层：Stooq 历史数据端点（覆盖面最广）──
  try {
    const data = await fetchStooqHistorical(market.stooq);
    if (data) return { symbol: market.stooq, ...base, ...data };
  } catch { /* 继续 */ }

  // ── 第二层：Stooq 实时报价端点（覆盖面窄但更实时）──
  try {
    const data = await fetchStooqRealtime(market.stooq);
    if (data) return { symbol: market.stooq, ...base, ...data };
  } catch { /* 继续 */ }

  // ── 第三层：Yahoo Finance v8 Chart API ──
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      const data = await fetchYahooV8(market.yahoo, host);
      if (data) return { symbol: market.yahoo, ...base, ...data };
    } catch { /* 继续 */ }
  }

  // ── 全部失败 ──
  return { symbol: market.stooq, ...base, error: true };
}

// ══════════════════════════════════════════════
// 数据源 1：Stooq 历史数据下载端点 /q/d/l/
// 这是 pandas-datareader 使用的同一端点，全球覆盖面广
// 返回格式：Date,Open,High,Low,Close,Volume
// ══════════════════════════════════════════════
async function fetchStooqHistorical(symbol) {
  // 取最近10天的数据（覆盖周末和假期）
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const d1 = fmtDate(start);
  const d2 = fmtDate(now);

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&d1=${d1}&d2=${d2}&i=d`;
  const csv = await fetchWithTimeout(url, 8000);

  if (!csv || typeof csv !== 'string') return null;

  const lines = csv.trim().split('\n').map(l => l.trim()).filter(Boolean);
  // 至少需要表头 + 1行数据
  if (lines.length < 2) return null;

  // 检查是否为有效CSV（表头应含 Date 和 Close）
  const header = lines[0].toLowerCase();
  if (!header.includes('date') || !header.includes('close')) return null;

  // 取最后一行（最近交易日）
  const lastLine = lines[lines.length - 1];
  const cols = lastLine.split(',');
  if (cols.length < 5) return null;

  const date  = cols[0].trim();
  const open  = parseNum(cols[1]);
  const close = parseNum(cols[4]);

  if (close == null) return null;

  // 如果有前一天数据，用前一天收盘价算涨跌（更准确）
  let prevClose = open; // 默认用当日开盘
  if (lines.length >= 3) {
    const prevLine = lines[lines.length - 2];
    const prevCols = prevLine.split(',');
    if (prevCols.length >= 5) {
      const pc = parseNum(prevCols[4]);
      if (pc != null) prevClose = pc;
    }
  }

  let change = 0, changePct = 0;
  if (prevClose != null && prevClose !== 0) {
    change = close - prevClose;
    changePct = (change / prevClose) * 100;
  }

  return {
    price: close,
    change: round2(change),
    changePct: round2(changePct),
    prevClose: prevClose,
    state: inferState(date),
    currency: '',
    ts: date,
  };
}

// ══════════════════════════════════════════════
// 数据源 2：Stooq 实时报价端点 /q/l/
// 覆盖面窄（仅约5个指数），但数据更实时
// 返回格式：Symbol,Date,Time,Open,High,Low,Close,Volume
// ══════════════════════════════════════════════
async function fetchStooqRealtime(symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
  const csv = await fetchWithTimeout(url, 6000);

  if (!csv || typeof csv !== 'string') return null;

  const lines = csv.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

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
// 数据源 3：Yahoo Finance v8 Chart API
// ══════════════════════════════════════════════
async function fetchYahooV8(symbol, host) {
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

// 格式化日期为 YYYYMMDD
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
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
