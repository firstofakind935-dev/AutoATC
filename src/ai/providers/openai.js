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
    // Generous headroom: a reasoning model's <think> block can run long,
    // and if it got cut off before max_tokens ever reached the real
    // answer, there'd be nothing left to say after llmProvider.js strips
    // the thinking block. That stripping is the actual safety net here -
    // this higher cap just makes truncation-with-no-answer less likely.
    max_tokens: 600,
    // Low temperature: ATC phraseology should be consistent and rule-
    // following, not creative. Testing showed the same garbled input
    // sometimes correctly got a "say again" and sometimes got a fabricated
    // clearance, purely from sampling randomness - this cuts that variance
    // down without going fully greedy (0), which some backends handle oddly.
    temperature: 0.2,
    messages: [{ role: 'system', content: systemPrompt }, ...history],
  };

  // Reasoning models (e.g. Qwen3 on Ollama) emit a <think>...</think> block
  // before the actual reply unless told not to - real latency and cost for
  // a live voice reply. Opt-in only (via LLM_REASONING_EFFORT, e.g. "none"),
  // since real OpenAI models don't necessarily expect this field and other
  // self-hosted backends may not either.
  //
  // Neither this field nor the CLI-level `ollama run --think=false` flag
  // reliably suppresses thinking on every Ollama/model version - tested
  // and confirmed both fail on qwen3:30b-a3b (this field worked on
  // qwen3:8b, for comparison, so it's genuinely model/version-dependent,
  // not just broken outright). Set it anyway since it's free to try and
  // helps when it works, but llmProvider.js's stripping of <think> blocks
  // is what actually guarantees the bot never speaks raw reasoning aloud
  // regardless of whether this field takes effect.
  if (process.env.LLM_REASONING_EFFORT) {
    body.reasoning_effort = process.env.LLM_REASONING_EFFORT;
  }

  // Smaller/weaker models tend to keep going past the actual reply -
  // hallucinating another "Pilot transmission:" line (the literal text
  // llmProvider.js uses to mark where context ends and the live
  // transmission starts) and answering their own fabrication, or just
  // rambling into a second paragraph. Cutting at the first blank line or
  // at that literal marker stops it right after the real, single-line
  // reply instead of speaking an invented conversation aloud.
  body.stop = ['\n\n', 'Pilot transmission:'];

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
