# AutoATC

A fleet of Discord bots that join voice channels and act as AI air traffic
control for a flight-sim community — until a human controller takes over.

Each bot in the fleet is its own Discord application/token with its own name
and persona (e.g. "Springfield Tower", "Springfield Ground"). A bot:

1. Joins its configured voice channel on startup.
2. Listens for a pilot to key up, using Discord's per-user voice receive.
3. Transcribes the transmission with OpenAI Whisper.
4. Feeds the transcript (plus recent conversation history) to an LLM —
   Anthropic Claude or OpenAI GPT, configurable per bot — using a system
   prompt that keeps it in character as one ATC position with real
   phraseology.
5. Synthesizes the reply with OpenAI TTS and plays it back into the channel.

## How the human handoff works today

The bot does **not** yet know how to detect a real human controller taking
a position — every server's existing ATC/roster system is different, and
that integration is intentionally left as a stub for you to wire up
(`src/bot/HumanHandoff.js`, see `isExternalHandoffActive()`).

Until you wire that in, each bot supports a manual override via chat
commands in any text channel it can see (requires the "Manage Server"
permission):

```
!tower pause    # silence the AI, a human is taking over
!tower resume   # give the position back to the AI
```

(`!tower` is whatever `commandPrefix` you set for that bot in
`config/bots.json`.)

## Setup

### 1. Install dependencies

```
npm install
```

Requires Node.js 18.17+ (Node 20+ recommended). `ffmpeg-static` bundles the
ffmpeg binary needed to transcode synthesized speech into Discord's audio
format, so no separate ffmpeg install is required.

### 2. Create Discord bot applications

For each ATC position you want, create a separate application/bot at
https://discord.com/developers/applications, then:

- Under **Bot**, enable the **Message Content Intent**.
- Invite the bot to your server with the `bot` scope and these permissions:
  `View Channels`, `Send Messages`, `Connect`, `Speak`, `Use Voice Activity`.
- Copy its token.

### 3. Configure environment variables

```
cp .env.example .env
```

Fill in:

- `ANTHROPIC_API_KEY` — needed for any bot using `"provider": "anthropic"`.
- `OPENAI_API_KEY` — always required (Whisper STT + TTS use it regardless
  of which provider writes the response text), and needed for any bot
  using `"provider": "openai"`.
- One token variable per bot (name them whatever you like, e.g.
  `BOT_TOWER_TOKEN`), matching the `tokenEnv` field you use in step 4.

### 4. Configure the bot fleet

```
cp config/bots.example.json config/bots.json
```

Edit `config/bots.json` — an array with one entry per bot:

```jsonc
{
  "name": "Springfield Tower",       // used for logging only
  "tokenEnv": "BOT_TOWER_TOKEN",     // env var holding this bot's Discord token
  "guildId": "...",                  // the Discord server ID
  "voiceChannelId": "...",           // voice channel this bot joins
  "logChannelId": "...",             // optional text channel for transcripts
  "commandPrefix": "!tower",         // optional, enables !tower pause/resume
  "persona": {
    "position": "Tower",             // shown to the LLM, shapes phraseology
    "callsign": "Springfield Tower", // what the bot calls itself on comms
    "airport": "KSGF",               // optional
    "ttsVoice": "onyx"               // any OpenAI TTS voice name
  },
  "ai": {
    "provider": "anthropic",         // "anthropic" or "openai"
    "model": "claude-sonnet-5"       // model id for that provider
  }
}
```

Add as many entries as you like — each spins up as an independent bot
connection, so you can run a Tower bot and a Ground bot (different tokens)
in the same server at the same time. A single bot token can only occupy one
voice channel per server at a time, which is a Discord platform limit, not
something this code can work around — that's why each position needs its
own bot application/token.

### 5. Run

```
npm start
```

All configured bots start concurrently. Logs are prefixed with each bot's
`name`.

## Known limitations

- **Not tested against live Discord voice in this environment** — this
  sandbox has no way to create a real bot token or join an actual voice
  channel, so the code has been reviewed and syntax/dependency-checked but
  not run end-to-end. Test it against a real server before relying on it.
- Costs money: every pilot transmission costs one Whisper call, one LLM
  call, and one TTS call.
- STT and TTS are hard-wired to OpenAI regardless of the `ai.provider`
  setting (Anthropic doesn't currently offer either).
- The human-controller handoff is a stub (see above) plus a manual chat
  command — there's no automatic detection of a human joining as ATC yet.
- One voice utterance is processed at a time per bot; if two pilots key up
  on the same frequency simultaneously, replies still go out in order but
  playback isn't real radio-style priority/blocking.
