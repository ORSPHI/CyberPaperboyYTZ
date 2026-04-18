// Vercel Serverless Function — DeepSeek API Proxy
// 作用：代理所有 DeepSeek API 请求，解决浏览器端 CORS 限制
// 部署后，前端调用 /api/deepseek 而不是直接调用 api.deepseek.com

export default async function handler(req, res) {
  // Handle CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, model, apiKey, max_tokens = 3000 } = req.body;

  if (!apiKey) return res.status(400).json({ error: { message: '缺少 API Key' } });
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: { message: '缺少 messages 参数' } });

  try {
    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: model || 'deepseek-chat', max_tokens, messages }),
    });

    const data = await upstream.json();
    // Pass through the exact status code from DeepSeek (e.g. 401 for bad key, 429 for rate limit)
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: `代理错误: ${err.message}` } });
  }
}
