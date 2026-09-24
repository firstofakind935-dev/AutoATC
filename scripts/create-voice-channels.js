#!/usr/bin/env node
/**
 * One-off/re-runnable provisioning tool: creates a real Discord voice
 * channel for every ATC-position entry in config/bots.json that doesn't
 * have one yet (voiceChannelId is null), grouped into one category per
 * airport/carrier, and writes the resulting channel IDs straight back
 * into config/bots.json.
 *
 * Discord's API has no way to create a new bot *application* (that's
 * always a manual step in the Developer Portal - see the fleet setup
 * checklist), but channel creation IS a normal guild-management API call,
 * so this removes the other big chunk of manual work: hand-creating ~60
 * voice channels one at a time in the Discord app.
 *
 * Requirements: the token you run this with must belong to a bot already
 * invited to the target guild with the "Manage Channels" permission (any
 * one bot works - Bot Manager is a reasonable choice since it's not tied
 * to a single ATC position). This is safe to re-run: entries that already
 * have a voiceChannelId are skipped, so a partial/interrupted run can just
 * be run again.
 *
 * Usage:
 *   BOT_TOKEN=<a-real-token-with-manage-channels> node scripts/create-voice-channels.js
 */

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ChannelType, PermissionsBitField } = require('discord.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'bots.json');

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error('Set BOT_TOKEN to a real Discord bot token (one already invited to the guild with Manage Channels).');
    process.exit(1);
  }

  const bots = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const isAtc = (b) => (b.type || 'atc') === 'atc';
  const needsChannel = bots.filter((b) => isAtc(b) && !b.voiceChannelId);

  if (needsChannel.length === 0) {
    console.log('Every ATC entry already has a voiceChannelId - nothing to do.');
    return;
  }

  const guildId = needsChannel[0].guildId;
  console.log(`${needsChannel.length} position(s) need a voice channel, in guild ${guildId}.`);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  await new Promise((resolve) => client.once('ready', resolve));
  console.log(`Logged in as ${client.user.tag}.`);

  const guild = await client.guilds.fetch(guildId);
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    console.error(
      `${client.user.tag} does not have "Manage Channels" in this guild - grant it a role with that ` +
        `permission (or re-invite it with that permission bit) and re-run.`
    );
    process.exit(1);
  }

  const categoryByKey = new Map(); // grouping key (airport/"General") -> category channel

  async function getOrCreateCategory(key, label) {
    if (categoryByKey.has(key)) return categoryByKey.get(key);
    const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === label);
    const category = existing || (await guild.channels.create({ name: label, type: ChannelType.GuildCategory }));
    categoryByKey.set(key, category);
    return category;
  }

  let created = 0;
  for (const bot of needsChannel) {
    const key = bot.persona.airport || 'General';
    const category = await getOrCreateCategory(key, key);

    const channel = await guild.channels.create({
      name: bot.persona.callsign,
      type: ChannelType.GuildVoice,
      parent: category.id,
    });

    bot.voiceChannelId = channel.id;
    created += 1;
    console.log(`Created "${bot.persona.callsign}" (${channel.id}) under "${key}" for ${bot.name}.`);
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(bots, null, 2) + '\n');
  console.log(`Done. Created ${created} channel(s) and updated ${CONFIG_PATH}.`);

  client.destroy();
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
