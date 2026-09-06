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
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

module.exports = { generateReply };
