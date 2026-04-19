// api/rss.js — 服务端 RSS 抓取（含重试机制、失败追踪、编码兼容）
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { feeds } = req.body;
  if (!feeds || !Array.isArray(feeds)) return res.status(400).json({ error: 'Missing feeds array' });

  // 并行抓取，单个失败不阻塞其他
  const results = await Promise.allSettled(feeds.map(feed => fetchAndParse(feed)));

  const allItems = [];
  const failures = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      allItems.push(...r.value);
    } else {
      failures.push(feeds[i].label || feeds[i].url);
    }
  });

  return res.status(200).json({
    items:    allItems,
    failures: failures,
    count:    allItems.length,
  });
}

// ── 带重试的抓取 ──
async function fetchAndParse(feed, maxRetries = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt); // 指数退避: 1.5s, 3s
    try {
      const result = await attemptFetch(feed);
      if (result.length > 0) return result;
      // 抓到但解析出0条，不再重试（可能是空 feed）
      return result;
    } catch (e) {
      lastError = e;
    }
  }
  // 所有重试耗尽
  throw lastError || new Error('Unknown fetch error');
}

async function attemptFetch(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CyberPaperboyYTZ/2.0; RSS Reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Cache-Control': 'no-cache, no-store',
        'Pragma': 'no-cache',
      },
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // 处理编码：优先 UTF-8，兼容 GBK（部分中文网站）
    const buffer = await response.arrayBuffer();
    const text = decodeBuffer(buffer);
    return parseRSS(text, feed.label || '未知');

  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── 编码检测与解码 ──
function decodeBuffer(buffer) {
  // 先尝试 UTF-8
  try {
    const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    // 如果 XML 声明里明确写了 GBK/GB2312，用对应解码
    if (/encoding=["'](gbk|gb2312|gb18030)/i.test(utf8.slice(0, 200))) {
      return new TextDecoder('gbk').decode(buffer);
    }
    return utf8;
  } catch {
    // UTF-8 失败则尝试 GBK
    try { return new TextDecoder('gbk').decode(buffer); } catch { return ''; }
  }
}

// ── RSS / Atom XML 解析器（纯正则，无外部依赖）──
function parseRSS(xmlText, sourceLabel) {
  if (!xmlText) return [];
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>|<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = itemRe.exec(xmlText)) !== null && items.length < 5) {
    const block = match[1] || match[2] || '';

    const title = extractTag(block, 'title');
    if (!title || title.length < 3) continue;

    // 优先 description，其次 summary / content:encoded / content
    const rawDesc =
      extractTag(block, 'content:encoded') ||
      extractTag(block, 'description')     ||
      extractTag(block, 'summary')         ||
      extractTag(block, 'content')         || '';

    // 发布时间
    const pubDate =
      extractTag(block, 'pubDate')      ||
      extractTag(block, 'dc:date')      ||
      extractTag(block, 'published')    ||
      extractTag(block, 'updated')      || '';

    items.push({
      title:   cleanText(title).slice(0, 160),
      desc:    cleanText(rawDesc).slice(0, 350),
      pubDate: pubDate.trim().slice(0, 50),
      source:  sourceLabel,
    });
  }
  return items;
}

// 提取 XML 标签内容（含 CDATA）
function extractTag(text, tag) {
  // 带属性的开标签，如 <title type="html">
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`,
    'i'
  );
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// 清理 HTML 标签和实体
function cleanText(s) {
  return s
    .replace(/<[^>]+>/g,  ' ')
    .replace(/&amp;/g,    '&')
    .replace(/&lt;/g,     '<')
    .replace(/&gt;/g,     '>')
    .replace(/&quot;/g,   '"')
    .replace(/&#39;/g,    "'")
    .replace(/&nbsp;/g,   ' ')
    .replace(/&#\d+;/g,   ' ')
    .replace(/\s+/g,      ' ')
    .trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
