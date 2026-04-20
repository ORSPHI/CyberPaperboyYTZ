// api/fedregister.js — 美国联邦公报 API（关税、出口管制、制裁、行政命令）
// 免费、无需 API Key、返回 JSON
// 文档：https://www.federalregister.gov/developers/documentation/api/v1

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 获取最近7天内与贸易/出口管制/制裁相关的联邦公报文件
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const dateFrom = weekAgo.toISOString().slice(0, 10);

    // 并行请求：贸易规则 + 总统文件 + 出口管制
    const [tradeRules, presActions, exportCtrl] = await Promise.all([
      fetchFR({
        'conditions[term]': 'tariff OR duties OR antidumping OR countervailing OR sanctions',
        'conditions[publication_date][gte]': dateFrom,
        'conditions[type][]': ['RULE', 'NOTICE'],
        'per_page': 5,
        'order': 'newest',
        'fields[]': ['title', 'abstract', 'agencies', 'publication_date', 'type', 'html_url'],
      }).catch(() => []),

      fetchFR({
        'conditions[type][]': 'PRESDOCU',
        'conditions[publication_date][gte]': dateFrom,
        'per_page': 5,
        'order': 'newest',
        'fields[]': ['title', 'abstract', 'publication_date', 'type', 'subtype', 'html_url'],
      }).catch(() => []),

      fetchFR({
        'conditions[agencies][]': 'bureau-of-industry-and-security',
        'conditions[publication_date][gte]': dateFrom,
        'per_page': 3,
        'order': 'newest',
        'fields[]': ['title', 'abstract', 'publication_date', 'type', 'html_url'],
      }).catch(() => []),
    ]);

    const items = [];
    const seen = new Set();

    for (const doc of [...presActions, ...tradeRules, ...exportCtrl]) {
      if (!doc.title || seen.has(doc.title)) continue;
      seen.add(doc.title);
      items.push({
        title: doc.title,
        abstract: (doc.abstract || '').slice(0, 120),
        type: doc.subtype || doc.type || '',
        agencies: (doc.agencies || []).map(a => a.name || a).join(', '),
        date: doc.publication_date || '',
        url: doc.html_url || '',
      });
    }

    // 最多返回8条（控制 prompt 长度）
    return res.status(200).json({
      items: items.slice(0, 8),
      count: items.length,
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(200).json({ items: [], error: err.message, fetchedAt: new Date().toISOString() });
  }
}

async function fetchFR(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
    else qs.append(k, v);
  }
  const url = `https://www.federalregister.gov/api/v1/documents.json?${qs.toString()}`;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'CyberPaperboy/1.0' },
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return data.results || [];
  } catch (e) { clearTimeout(t); throw e; }
}
