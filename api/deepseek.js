export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, model, apiKey, max_tokens = 2500 } = req.body;
  if (!apiKey) return res.status(400).json({ error: { message: '缺少 API Key' } });

  try {
    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        max_tokens,
        messages,
        stream: false,
      }),
      signal: AbortSignal.timeout(55000),
    });

    const text = await Promise.race([
      upstream.text(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('响应读取超时')), 54000)
      ),
    ]);

    const data = JSON.parse(text);
    return res.status(upstream.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: { message: `代理错误: ${err.message}` } });
  }
}
