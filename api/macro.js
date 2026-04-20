// api/macro.js — 官方宏观经济数据（FRED + Eurostat）
// FRED: 需要在 Vercel 环境变量中设置 FRED_API_KEY（免费申请：https://fred.stlouisfed.org/docs/api/api_key.html）
// Eurostat: 免费公开API，无需key

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // 缓存1小时（宏观数据不需实时）
  if (req.method === 'OPTIONS') return res.status(200).end();

  const result = { us: {}, eu: {}, fetchedAt: new Date().toISOString() };

  // ═══ 并行请求 FRED + Eurostat ═══
  await Promise.all([
    fetchFRED(result).catch(() => {}),
    fetchEurostat(result).catch(() => {}),
  ]);

  return res.status(200).json(result);
}

// ═══ FRED API（美国宏观数据）═══
async function fetchFRED(result) {
  const key = process.env.FRED_API_KEY;
  if (!key) { result.us._note = 'FRED_API_KEY 未设置'; return; }

  const series = [
    { id: 'UNRATE',   zh: '失业率',       unit: '%' },
    { id: 'FEDFUNDS', zh: '联邦基金利率',  unit: '%' },
    { id: 'T10YIE',   zh: '10Y通胀预期',  unit: '%' },
    { id: 'T10Y2Y',   zh: '10Y-2Y利差',   unit: '%' },
    { id: 'DEXUSEU',  zh: '美元/欧元',     unit: '' },
  ];

  const fetches = series.map(async (s) => {
    try {
      const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&api_key=${key}&file_type=json&sort_order=desc&limit=2`;
      const text = await fetchWithTimeout(url, 8000);
      const data = JSON.parse(text);
      const obs = data?.observations;
      if (!obs || !obs.length) return;

      const latest = obs[0];
      const val = parseFloat(latest.value);
      if (isNaN(val)) return;

      // 计算环比变化（如果有前一期数据）
      let prev = null, change = null;
      if (obs.length >= 2) {
        prev = parseFloat(obs[1].value);
        if (!isNaN(prev) && prev !== 0) change = val - prev;
      }

      result.us[s.id] = {
        name: s.zh,
        value: val,
        unit: s.unit,
        date: latest.date,
        change: change != null ? Math.round(change * 100) / 100 : null,
      };
    } catch {}
  });

  await Promise.all(fetches);
}

// ═══ Eurostat API（欧盟/欧元区宏观数据）═══
async function fetchEurostat(result) {
  const datasets = [
    {
      key: 'unemployment',
      zh: '欧元区失业率',
      url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/une_rt_m?format=JSON&lang=en&freq=M&s_adj=SA&age=TOTAL&sex=T&unit=PC_ACT&geo=EA20&lastTimePeriod=2',
      unit: '%',
    },
    {
      key: 'hicp',
      zh: '欧元区HICP通胀',
      url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_manr?format=JSON&lang=en&coicop=CP00&geo=EA20&lastTimePeriod=2',
      unit: '%',
    },
    {
      key: 'industry',
      zh: '欧元区工业生产',
      url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/sts_inpr_m?format=JSON&lang=en&s_adj=SCA&unit=PCH_SM&nace_r2=B-D&geo=EA20&lastTimePeriod=2',
      unit: '%MoM',
    },
  ];

  const fetches = datasets.map(async (ds) => {
    try {
      const text = await fetchWithTimeout(ds.url, 10000);
      const data = JSON.parse(text);

      // Eurostat JSON-stat 格式：值在 data.value 对象中
      const values = data?.value;
      if (!values || typeof values !== 'object') return;

      const keys = Object.keys(values).sort((a, b) => Number(b) - Number(a));
      if (!keys.length) return;

      const latest = values[keys[0]];
      if (latest == null) return;

      // 获取对应的时间维度
      let period = '';
      try {
        const timeIdx = data.id?.indexOf('time') ?? data.id?.indexOf('TIME_PERIOD') ?? -1;
        if (timeIdx >= 0) {
          const timeDim = data.dimension?.[data.id[timeIdx]];
          const catIds = timeDim?.category?.index;
          if (catIds) {
            const periods = Object.entries(catIds).sort((a, b) => b[1] - a[1]);
            if (periods.length) period = periods[0][0];
          }
        }
      } catch {}

      let change = null;
      if (keys.length >= 2 && values[keys[1]] != null) {
        change = Math.round((latest - values[keys[1]]) * 100) / 100;
      }

      result.eu[ds.key] = {
        name: ds.zh,
        value: Math.round(latest * 10) / 10,
        unit: ds.unit,
        date: period,
        change: change,
      };
    } catch {}
  });

  await Promise.all(fetches);
}

// ═══ 工具 ═══
async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'CyberPaperboy/1.0', 'Accept': 'application/json' },
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) { clearTimeout(t); throw e; }
}
