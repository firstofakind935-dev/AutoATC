#!/usr/bin/env node
/**
 * Head-to-head cost/latency comparison between AI models for the full 70-bot
 * fleet, compressed into one script run instead of a real calendar month.
 *
 * Reuses the real production building blocks (system prompt builder, scenario
 * matcher, chart/frequency/oceanic context, conversation history) so token
 * counts reflect actual prompts rather than a hand-waved estimate - only the
 * pilot transmissions and Discord/voice plumbing are synthetic.
 *
 * Usage:
 *   node scripts/simulate-month.js --dry-run                    # test the harness, no API key/cost
 *   ANTHROPIC_API_KEY=sk-... node scripts/simulate-month.js      # real run, both models
 *   node scripts/simulate-month.js --models=claude-sonnet-5      # one model only
 *   node scripts/simulate-month.js --turns=3000 --bots=70 --concurrency=8 --out=scripts/output/sim-{model}.json
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { buildAtcSystemPrompt } = require('../src/ai/systemPrompt');
const { findBestScenario, formatScenarioHint } = require('../src/ai/scenarioMatcher');
const { ConversationHistory } = require('../src/ai/llmProvider');
const { getChartContext } = require('../src/charts/store');
const { getFrequencyContext } = require('../src/charts/frequencies');
const { getOceanicTracksContext } = require('../src/charts/oceanicTracks');
const { estimateCostUsd } = require('../src/ai/providers/anthropic');

const CHARTS_DIR = path.join(__dirname, '..', 'data', 'charts');
const SCENARIOS_PATH = path.join(__dirname, '..', 'data', 'scenarios.json');
const POSITIONS = ['Ground', 'Tower', 'Apron', 'Clearance Delivery', 'Departure', 'Approach', 'Center'];

function parseArgs(argv) {
  const args = {
    models: ['claude-sonnet-5', 'claude-haiku-4-5'],
    turns: 3000, // 100/day fleet-wide x 30 days, matching the earlier cost projection
    bots: 70,
    concurrency: 6,
    dryRun: false,
    out: null,
  };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--/, '');
    const value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (key === 'models') args.models = value.split(',').map((m) => m.trim());
    else if (key === 'turns') args.turns = Number(value);
    else if (key === 'bots') args.bots = Number(value);
    else if (key === 'concurrency') args.concurrency = Number(value);
    else if (key === 'dry-run') args.dryRun = true;
    else if (key === 'out') args.out = value;
  }
  return args;
}

function buildPersonas(count) {
  const airports = fs
    .readdirSync(CHARTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));

  const personas = [];
  for (let i = 0; i < count; i++) {
    const position = POSITIONS[i % POSITIONS.length];
    const airport = airports[Math.floor(i / POSITIONS.length) % airports.length];
    personas.push({
      id: `${airport}-${position.replace(/\s+/g, '')}-${i}`,
      position,
      airport,
      callsign: `${airport} ${position}`,
    });
  }
  return personas;
}

function buildBotState(persona) {
  return {
    persona,
    systemPrompt: buildAtcSystemPrompt(persona),
    chartContext: getChartContext(persona.airport),
    frequencyContext: getFrequencyContext(),
    oceanicTracksContext: getOceanicTracksContext(),
    history: new ConversationHistory(),
  };
}

const CALLSIGN_STYLES = [
  () => `N${Math.floor(100 + Math.random() * 900)}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`,
  () => `Cessna ${Math.floor(10 + Math.random() * 90)}${['Yankee', 'Charlie', 'Delta', 'Bravo'][Math.floor(Math.random() * 4)]}`,
  () => `Speedbird ${Math.floor(100 + Math.random() * 900)}`,
  () => `Jetstream ${Math.floor(100 + Math.random() * 900)}`,
];

function randomCallsign() {
  return CALLSIGN_STYLES[Math.floor(Math.random() * CALLSIGN_STYLES.length)]();
}

function loadScenarios() {
  return JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
}

function scenariosForPosition(scenarios, position) {
  const lower = position.toLowerCase();
  return scenarios.filter((s) => s.positions.includes('any') || s.positions.some((p) => lower.includes(p)));
}

function syntheticTransmission(scenarios, position) {
  const applicable = scenariosForPosition(scenarios, position);
  const scenario = applicable[Math.floor(Math.random() * applicable.length)];
  const keyword = scenario.keywords[Math.floor(Math.random() * scenario.keywords.length)];
  return `${randomCallsign()}, ${keyword}.`;
}

function buildTurnSequence(personas, scenarios, totalTurns) {
  const seq = [];
  for (let i = 0; i < totalTurns; i++) {
    const botIndex = Math.floor(Math.random() * personas.length);
    const transmission = syntheticTransmission(scenarios, personas[botIndex].position);
    seq.push({ order: i, botIndex, transmission });
  }
  return seq;
}

function groupByBot(sequence) {
  const byBot = new Map();
  for (const turn of sequence) {
    if (!byBot.has(turn.botIndex)) byBot.set(turn.botIndex, []);
    byBot.get(turn.botIndex).push(turn);
  }
  return byBot;
}

// Runs `worker` over `items` with at most `limit` running concurrently.
async function runPool(items, limit, worker) {
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const current = items[next++];
      await worker(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

function estimateTokensFromText(text) {
  // Rough heuristic (~1.3 tokens/word) - only used in --dry-run mode to
  // exercise the harness before spending real API money.
  return Math.round((text || '').split(/\s+/).filter(Boolean).length * 1.3);
}

async function processTurn(client, model, botState, turn, results, options) {
  const scenario = findBestScenario(turn.transmission, botState.persona.position);
  const scenarioContext = scenario ? formatScenarioHint(scenario) : null;
  const turnContext =
    [botState.chartContext, botState.oceanicTracksContext, botState.frequencyContext, scenarioContext]
      .filter(Boolean)
      .join('\n\n') || undefined;

  botState.history.addPilotTransmission(turn.transmission);
  const history = botState.history.toArray({ contextForLastTurn: turnContext });

  const start = Date.now();
  let replyText = '';
  let usage = null;
  let error = null;

  if (options.dryRun) {
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));
    const nonSystemInput = history.map((t) => t.content).join('\n');
    usage = {
      input_tokens: estimateTokensFromText(nonSystemInput),
      output_tokens: 25,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: estimateTokensFromText(botState.systemPrompt),
    };
    replyText = '[dry-run] no reply generated';
  } else {
    try {
      // Mirrors src/ai/providers/anthropic.js's request shape so usage/cost
      // reflect a real call, while letting this script capture per-turn
      // usage and latency directly instead of just log lines.
      const response = await client.messages.create({
        model,
        max_tokens: 200,
        temperature: 0.2,
        system: [{ type: 'text', text: botState.systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: history.map((t) => ({ role: t.role, content: t.content })),
        stop_sequences: ['\n\n', 'Pilot transmission:'],
      });
      usage = response.usage;
      const textBlock = response.content.find((b) => b.type === 'text');
      replyText = textBlock ? textBlock.text.trim() : '';
    } catch (err) {
      error = err.message;
    }
  }

  const latencyMs = Date.now() - start;
  if (replyText && !error) botState.history.addAtcReply(replyText);
  const costUsd = usage ? estimateCostUsd(model, usage) : null;

  results.push({
    order: turn.order,
    bot: botState.persona.id,
    position: botState.persona.position,
    airport: botState.persona.airport,
    transmission: turn.transmission,
    scenario: scenario ? scenario.id : null,
    reply: replyText,
    latencyMs,
    usage,
    costUsd,
    error,
  });
}

function summarize(model, results) {
  const ok = results.filter((r) => !r.error);
  const sum = (fn) => ok.reduce((s, r) => s + fn(r), 0);
  const totalCost = sum((r) => r.costUsd || 0);
  const totalCacheRead = sum((r) => r.usage?.cache_read_input_tokens || 0);
  const totalCacheWrite = sum((r) => r.usage?.cache_creation_input_tokens || 0);

  return {
    model,
    turns: results.length,
    errors: results.length - ok.length,
    totalCostUsd: totalCost,
    avgCostPerTurn: totalCost / (ok.length || 1),
    avgLatencyMs: sum((r) => r.latencyMs) / (ok.length || 1),
    totalInputTokens: sum((r) => r.usage?.input_tokens || 0),
    totalOutputTokens: sum((r) => r.usage?.output_tokens || 0),
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    cacheHitRate: totalCacheRead / (totalCacheRead + totalCacheWrite || 1),
  };
}

function printComparison(summaries) {
  console.log('\n=== Comparison ===');
  console.table(
    summaries.map((s) => ({
      model: s.model,
      turns: s.turns,
      errors: s.errors,
      'total cost': `$${s.totalCostUsd.toFixed(4)}`,
      'avg cost/turn': `$${s.avgCostPerTurn.toFixed(6)}`,
      'avg latency (ms)': Math.round(s.avgLatencyMs),
      'cache hit rate': `${(s.cacheHitRate * 100).toFixed(1)}%`,
    }))
  );

  if (summaries.length === 2 && summaries.every((s) => s.totalCostUsd > 0)) {
    const [a, b] = summaries;
    const cheaper = a.totalCostUsd <= b.totalCostUsd ? a : b;
    const pricier = cheaper === a ? b : a;
    const diff = pricier.totalCostUsd - cheaper.totalCostUsd;
    const pct = (diff / pricier.totalCostUsd) * 100;
    console.log(`\n${cheaper.model} was $${diff.toFixed(4)} cheaper (${pct.toFixed(1)}%) over this run.`);
  }

  console.log(
    '\nCost is only half the comparison - open the per-turn transcript files (--out) and read a ' +
      'sample of replies from each model side by side for phraseology quality/scope-adherence before deciding.'
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!args.dryRun && !apiKey) {
    console.error(
      'ANTHROPIC_API_KEY is not set. Run with --dry-run to test the harness for free, ' +
        'or set ANTHROPIC_API_KEY once you have a key.'
    );
    process.exit(1);
  }

  const client = args.dryRun ? null : new Anthropic({ apiKey });
  const personas = buildPersonas(args.bots);
  const scenarios = loadScenarios();
  const sequence = buildTurnSequence(personas, scenarios, args.turns);

  const summaries = [];
  for (const model of args.models) {
    console.log(
      `\n=== Simulating ${args.turns} turns across ${args.bots} bots on ${model}` +
        `${args.dryRun ? ' (dry run, no API calls)' : ''} ===`
    );

    const botStates = personas.map(buildBotState); // fresh history per model
    const byBot = groupByBot(sequence);
    const results = [];

    await runPool([...byBot.entries()], args.concurrency, async ([botIndex, turns]) => {
      for (const turn of turns) {
        await processTurn(client, model, botStates[botIndex], turn, results, { dryRun: args.dryRun });
      }
    });

    results.sort((a, b) => a.order - b.order);
    summaries.push(summarize(model, results));

    if (args.out) {
      const outPath = args.out.replace('{model}', model.replace(/[^a-z0-9.-]/gi, '_'));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify({ model, args, results }, null, 2));
      console.log(`Wrote ${results.length} turns (transcript + per-turn cost) to ${outPath}`);
    }
  }

  printComparison(summaries);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
