const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * Calls a Chat-Completions-compatible endpoint. Defaults to OpenAI's
 * hosted API, but baseUrl can point at any self-hosted server that
 * implements the same /v1/chat/completions contract - this covers most
 * local LLM servers (Ollama, llama.cpp's server, vLLM, text-generation-webui)
 * since they're built to be OpenAI-API compatible.
 */
async function generateReply({ apiKey, baseUrl = DEFAULT_BASE_URL, model, systemPrompt, history }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: 'system', content: systemPrompt }, ...history],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Chat completion request to ${baseUrl} failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

module.exports = { generateReply, DEFAULT_BASE_URL };
