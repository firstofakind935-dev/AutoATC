const Anthropic = require('@anthropic-ai/sdk');

let client = null;
function getClient(apiKey) {
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

async function generateReply({ apiKey, model, systemPrompt, history }) {
  const anthropic = getClient(apiKey);
  const response = await anthropic.messages.create({
    model,
    max_tokens: 200,
    system: systemPrompt,
    messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
    // Same safety net as the openai provider: stop before the model can
    // hallucinate a second "Pilot transmission:" turn and answer itself,
    // or ramble into a second paragraph.
    stop_sequences: ['\n\n', 'Pilot transmission:'],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

module.exports = { generateReply };
