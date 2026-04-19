// api/stocks.js — 服务端股市数据抓取（Stooq CSV API，替代被封锁的 Yahoo Finance）
// 覆盖全球15大股市，每次请求均为最新收盘/盘中数据
// Stooq 是波兰金融数据网站，不封锁 Vercel 服务器 IP

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── 15大股市 Stooq 符号映射 ──
  const MARKETS = [
    { stooq: '^spx',   name: 'S&P 500',    zh: '纽约',     flag: 'US' },
    { stooq: '^ndq',   name: 'NASDAQ',     zh: '纳斯达克',  flag: 'US' },
    { stooq: '^ukx',   name: 'FTSE 100',   zh: '伦敦',     flag: 'GB' },
    { stooq: '^nkx',   name: 'Nikkei 225', zh: '东京',     flag: 'JP' },
    { stooq: '^sha',   name: '上证综指',    zh: '上海',     flag: 'CN', alt: ['000001.ss'] },
    { stooq: '^szs',   name: '深证成指',    zh: '深圳',     flag: 'CN', alt: ['399001.sz'] },
    { stooq: '^hsi',   name: 'HSI',        zh: '香港',     flag: 'HK' },
    { stooq: '^sx5e',  name: 'EURO STOXX', zh: '泛欧',     flag: 'EU' },
    { stooq: '^dax',   name: 'DAX',        zh: '法兰克福',  flag: 'DE' },
    { stooq: '^tsx',   name: 'TSX',        zh: '多伦多',    flag: 'CA' },
    { stooq: '^sen',   name: 'BSE SENSEX', zh: '孟买',     flag: 'IN', alt: ['^bse'] },
    { stooq: '^kospi', name: 'KOSPI',      zh: '首尔',     flag: 'KR' },
    { stooq: '^xjo',   name: 'ASX 200',    zh: '悉尼',     flag: 'AU' },
    { stooq: '^sti',   name: 'STI',        zh: '新加坡',    flag: 'SG' },
    { stooq: '^twi',   name: 'TWII',       zh: '台北',     flag: 'TW' },
  ];

  try {
    // ── 策略：先批量请求，再对失败的逐个重试（含备选符号）──
    const batchSymbols = MARKETS.map(m => m.stooq).join(';');
    const batchUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(batchSymbols)}&f=sd2t2ohlcv&h&e=csv`;

    let batchRows = {};
    try {
      const csv = await fetchWithTimeout(batchUrl, 10000);
      batchRows = parseStooqCSV(csv);
    } catch {
      // 批量请求失败，后面逐个请求
    }

    // ── 对每个市场匹配数据，失败的逐个重试 ──
    const markets = await Promise.all(MARKETS.map(async (m) => {
      // 先从批量结果中查找
      const key = m.stooq.toUpperCase();
      if (batchRows[key] && batchRows[key].close != null) {
        return formatMarket(m, batchRows[key]);
      }

      // 批量中没有，逐个请求主符号
      const single = await fetchSingleQuote(m.stooq);
      if (single) return formatMarket(m, single);

      // 主符号失败，尝试备选符号
      if (m.alt && m.alt.length > 0) {
        for (const altSym of m.alt) {
          const altData = await fetchSingleQuote(altSym);
          if (altData) return formatMarket(m, altData);
        }
      }

      // 全部失败
      return { symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, error: true };
    }));

    return res.status(200).json({ markets, fetchedAt: new Date().toISOString() });

  } catch (err) {
    return res.status(200).json({
      markets: MARKETS.map(m => ({ symbol: m.stooq, name: m.name, zh: m.zh, flag: m.flag, error: true })),
      error: err.message,
      fetchedAt: new Date().toISOString(),
    });
  }
}

// ── 单个符号请求 ──
async function fetchSingleQuote(symbol) {
  try {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
    const csv = await fetchWithTimeout(url, 6000);
    const rows = parseStooqCSV(csv);
    const key = symbol.toUpperCase();
    if (rows[key] && rows[key].close != null) return rows[key];
    // Stooq 返回的符号可能大小写不同，取第一个有效结果
    const values = Object.values(rows);
    if (values.length > 0 && values[0].close != null) return values[0];
    return null;
  } catch {
    return null;
  }
}

// ── 解析 Stooq CSV 响应 ──
// 格式（带 &h 头）：Symbol,Date,Time,Open,High,Low,Close,Volume
// 数据不可用时值为 "N/D"
function parseStooqCSV(csv) {
  const result = {};
  if (!csv || typeof csv !== 'string') return result;

  const lines = csv.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return result;

  // 第一行是表头，跳过
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 7) continue;

    const symbol = (cols[0] || '').trim().toUpperCase();
    const date   = (cols[1] || '').trim();
    const time   = (cols[2] || '').trim();
    const open   = parseNum(cols[3]);
    const high   = parseNum(cols[4]);
    const low    = parseNum(cols[5]);
    const close  = parseNum(cols[6]);
    const volume = cols.length > 7 ? parseNum(cols[7]) : null;

    // 关键数据为 N/D 则跳过
    if (close == null) continue;

    result[symbol] = { symbol, date, time, open, high, low, close, volume };
  }
  return result;
}

// ── 格式化为前端期望的数据结构 ──
function formatMarket(marketDef, data) {
  const price = data.close;
  const open = data.open;

  // 涨跌计算：(收盘/现价 - 开盘价) / 开盘价 × 100
  let change = 0;
  let changePct = 0;
  if (open != null && open !== 0) {
    change = price - open;
    changePct = (change / open) * 100;
  }

  // 推断市场状态
  const state = inferMarketState(data.date, marketDef.flag);

  return {
    symbol:    marketDef.stooq,
    name:      marketDef.name,
    zh:        marketDef.zh,
    flag:      marketDef.flag,
    price:     price,
    change:    Math.round(change * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    prevClose: open,
    state:     state,
    currency:  '',
    ts:        data.date + ' ' + data.time,
  };
}

// ── 推断市场开/收盘状态 ──
function inferMarketState(dateStr, flag) {
  try {
    const now = new Date();
    const clean = (dateStr || '').replace(/-/g, '');
    const todayStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    // 数据不是今天 → 收盘
    if (clean !== todayStr) return 'CLOSED';
    // 数据是今天 → 视为开盘中
    return 'REGULAR';
  } catch {
    return 'CLOSED';
  }
}

// ── 带超时的 fetch ──
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/csv, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
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

// ── 解析数字，处理 "N/D" 和空值 ──
function parseNum(val) {
  if (!val || val.trim() === '' || val.trim().toUpperCase() === 'N/D') return null;
  const n = Number(val.trim());
  return isNaN(n) ? null : n;
}
