const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

async function generateReply({ apiKey, model, systemPrompt, history }) {
  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: 'system', content: systemPrompt }, ...history],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI chat completion failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

module.exports = { generateReply };
