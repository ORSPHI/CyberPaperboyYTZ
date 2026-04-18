// api/rss.js — 服务端 RSS 抓取与解析
// 直接从 Vercel 服务器请求各 RSS 源，完全绕开浏览器 CORS 限制和 allorigins.win 缓存问题
// 保证每次都拿到最新内容

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { feeds } = req.body;
  if (!feeds || !Array.isArray(feeds)) {
    return res.status(400).json({ error: 'Missing feeds array' });
  }

  // 并行抓取所有 RSS 源，单个失败不影响其他
  const results = await Promise.allSettled(
    feeds.map(feed => fetchAndParse(feed))
  );

  const allItems = results.flatMap(r =>
    r.status === 'fulfilled' ? r.value : []
  );

  return res.status(200).json({ items: allItems, count: allItems.length });
}

// ── 抓取单个 RSS 源 ──
async function fetchAndParse(feed) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CyberPaperboyYTZ/1.0; RSS Reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        // 关键：明确禁用缓存，每次都拿新内容
        'Cache-Control': 'no-cache, no-store',
        'Pragma': 'no-cache',
      },
    });
    clearTimeout(timer);

    if (!response.ok) return [];

    const text = await response.text();
    return parseRSS(text, feed.label);

  } catch (e) {
    // 静默忽略单个源的失败
    return [];
  }
}

// ── RSS / Atom 解析器 ──
function parseRSS(xmlText, sourceLabel) {
  const items = [];

  // 匹配 RSS 2.0 的 <item> 和 Atom 的 <entry>
  const itemPattern = /<item[\s>]([\s\S]*?)<\/item>|<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = itemPattern.exec(xmlText)) !== null && items.length < 6) {
    const block = match[1] || match[2] || '';

    const title = extractTag(block, 'title');
    if (!title) continue;

    const desc =
      extractTag(block, 'description') ||
      extractTag(block, 'summary')     ||
      extractTag(block, 'content')     || '';

    // 发布时间：尽量提取
    const pubDate =
      extractTag(block, 'pubDate')   ||
      extractTag(block, 'published') ||
      extractTag(block, 'updated')   || '';

    items.push({
      title:   cleanText(title).slice(0, 150),
      desc:    cleanText(desc).slice(0, 300),
      pubDate: pubDate.trim(),
      source:  sourceLabel,
    });
  }

  return items;
}

// 提取标签内容，处理 CDATA
function extractTag(text, tag) {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`,
    'i'
  );
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// 清理 HTML 标签和常见 HTML 实体
function cleanText(str) {
  return str
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g,    ' ')
    .trim();
}
