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

  const body = {
    model,
    max_tokens: 200,
    messages: [{ role: 'system', content: systemPrompt }, ...history],
  };

  // Reasoning models (e.g. Qwen3 on Ollama) emit a <think>...</think> block
  // before the actual reply unless told not to - a real latency and cost
  // problem for a live voice reply. Opt-in only (via LLM_REASONING_EFFORT,
  // e.g. "none"), since real OpenAI models don't necessarily expect this
  // field and other self-hosted backends may not either. The CLI-level
  // `ollama run --think=false` flag does NOT reliably suppress this on
  // every Ollama/model version - this request-body field is what actually
  // worked when tested directly against the API.
  if (process.env.LLM_REASONING_EFFORT) {
    body.reasoning_effort = process.env.LLM_REASONING_EFFORT;
  }

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Chat completion request to ${baseUrl} failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

module.exports = { generateReply, DEFAULT_BASE_URL };
