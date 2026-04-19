// api/deepseek.js — DeepSeek API 服务端代理（解决浏览器 CORS 限制）
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, model, apiKey, max_tokens = 4000 } = req.body;
  if (!apiKey) return res.status(400).json({ error: { message: '缺少 API Key' } });
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: { message: '缺少 messages 参数' } });

  try {
    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || 'deepseek-chat', max_tokens, messages }),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: `代理错误: ${err.message}` } });
  }
}
