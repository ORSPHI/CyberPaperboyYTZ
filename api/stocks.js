// api/stocks.js — 服务端股市数据抓取（Yahoo Finance，免费接口）
// 覆盖全球前15大股市，每次请求均为实时收盘/盘中数据

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const MARKETS = [
    { symbol: '^GSPC',     name: 'S&P 500',   zh: '纽约',    flag: 'US' },
    { symbol: '^IXIC',     name: 'NASDAQ',    zh: '纳斯达克', flag: 'US' },
    { symbol: '^FTSE',     name: 'FTSE 100',  zh: '伦敦',    flag: 'GB' },
    { symbol: '^N225',     name: 'Nikkei 225',zh: '东京',    flag: 'JP' },
    { symbol: '000001.SS', name: '上证指数',   zh: '上海',    flag: 'CN' },
    { symbol: '399001.SZ', name: '深证成指',   zh: '深圳',    flag: 'CN' },
    { symbol: '^HSI',      name: 'HSI',       zh: '香港',    flag: 'HK' },
    { symbol: '^STOXX50E', name: 'EURO STOXX',zh: '泛欧',    flag: 'EU' },
    { symbol: '^GDAXI',    name: 'DAX',       zh: '法兰克福', flag: 'DE' },
    { symbol: '^GSPTSE',   name: 'TSX',       zh: '多伦多',  flag: 'CA' },
    { symbol: '^BSESN',    name: 'BSE SENSEX',zh: '孟买',    flag: 'IN' },
    { symbol: '^KS11',     name: 'KOSPI',     zh: '首尔',    flag: 'KR' },
    { symbol: '^AXJO',     name: 'ASX 200',   zh: '悉尼',    flag: 'AU' },
    { symbol: '^STI',      name: 'STI',       zh: '新加坡',  flag: 'SG' },
    { symbol: '^TWII',     name: '加权指数',   zh: '台北',    flag: 'TW' },
  ];

  const symbols = MARKETS.map(m => m.symbol).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,marketState,regularMarketTime,currency`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
      },
    });
    clearTimeout(timer);

    if (!response.ok) {
      return res.status(200).json({ markets: blankMarkets(MARKETS), error: `Yahoo Finance HTTP ${response.status}`, fetchedAt: new Date().toISOString() });
    }

    const data = await response.json();
    const quotes = data?.quoteResponse?.result || [];

    const markets = MARKETS.map(m => {
      const q = quotes.find(q => q.symbol === m.symbol);
      if (!q || q.regularMarketPrice == null) {
        return { ...m, error: true };
      }
      return {
        symbol:    m.symbol,
        name:      m.name,
        zh:        m.zh,
        flag:      m.flag,
        price:     q.regularMarketPrice,
        change:    q.regularMarketChange,
        changePct: q.regularMarketChangePercent,
        prevClose: q.regularMarketPreviousClose,
        state:     q.marketState || 'CLOSED', // REGULAR=开盘 CLOSED=收盘 PRE/POST=盘前后
        currency:  q.currency || '',
        ts:        q.regularMarketTime,
      };
    });

    return res.status(200).json({ markets, fetchedAt: new Date().toISOString() });

  } catch (err) {
    return res.status(200).json({ markets: blankMarkets(MARKETS), error: err.message, fetchedAt: new Date().toISOString() });
  }
}

function blankMarkets(list) {
  return list.map(m => ({ ...m, error: true }));
}
