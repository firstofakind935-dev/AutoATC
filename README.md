# AutoATC

A fleet of Discord bots that join voice channels and act as AI air traffic
control for a flight-sim community — until a human controller takes over.

Each bot in the fleet is its own Discord application/token with its own name
and persona (e.g. "Springfield Tower", "Springfield Ground"). A bot:

1. Joins its configured voice channel on startup.
2. Listens for a pilot to key up, using Discord's per-user voice receive.
3. Transcribes the transmission via a Whisper-compatible speech-to-text
   endpoint (OpenAI's hosted API by default, or your own self-hosted server).
4. Feeds the transcript (plus recent conversation history, and any
   currently filed flight plans — see below) to an LLM — Anthropic Claude
   or OpenAI GPT, configurable per bot — using a system prompt that keeps
   it in character as one ATC position with real phraseology.
5. Synthesizes the reply via an OpenAI-speech-API-compatible endpoint
   (again, OpenAI's hosted API by default, or self-hosted) and plays it
   back into the channel.

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
- `OPENAI_API_KEY` — needed for any bot using `"provider": "openai"`, and
  also needed for STT/TTS unless you self-host those (see below).
- One token variable per bot (name them whatever you like, e.g.
  `BOT_TOWER_TOKEN`), matching the `tokenEnv` field you use in step 4.

#### Self-hosting speech-to-text / text-to-speech instead of OpenAI

By default, transcription and speech synthesis call OpenAI's hosted APIs.
If you'd rather run your own — e.g. deployed as a service on
[Railway](https://railway.app) — set `STT_BASE_URL` and/or `TTS_BASE_URL`
in `.env` to your server's public URL. The client code calls the same
`/v1/audio/transcriptions` and `/v1/audio/speech` request shapes OpenAI
uses, so this only works out of the box if your self-hosted server
implements that same contract. Several self-hostable projects are built
specifically to be drop-in compatible with those endpoints (for example
`speaches` for STT, and `openedai-speech` for TTS) — deploy one as a
Railway service from its GitHub repo, grab the public URL Railway gives
it, and point `STT_BASE_URL`/`TTS_BASE_URL` at it. If your server expects
a different model name than OpenAI's `whisper-1`/`tts-1`, set
`STT_MODEL`/`TTS_MODEL`; if it needs its own API key, set
`STT_API_KEY`/`TTS_API_KEY` (otherwise no `Authorization` header is sent).
`persona.ttsVoice` in `config/bots.json` is passed straight through as the
`voice` parameter, so use whatever voice name your TTS server expects.

If a self-hosted project you want to use does **not** implement this exact
API shape (e.g. the raw `whisper.cpp` `server` example has a different
response format), `src/speech/providers/openaiWhisper.js` and
`openaiTts.js` are the two files to adapt — swap the request/response
parsing for that server's actual contract.

With both `STT_BASE_URL` and `TTS_BASE_URL` set (and no bot using
`"provider": "openai"`), `OPENAI_API_KEY` isn't needed at all.

#### Using a self-hosted / local LLM for the brain

Set `"provider": "openai"` on a bot and point `OPENAI_BASE_URL` (in `.env`)
at a local or self-hosted LLM server instead of OpenAI's hosted API. This
works with Ollama, llama.cpp's `server`, vLLM, text-generation-webui, or
anything else that implements an OpenAI-compatible `/v1/chat/completions`
endpoint — no code changes needed. `OPENAI_API_KEY` becomes optional in
that case (only send one if your server requires it).

**If you're using a Qwen3 (or other reasoning) model, set
`LLM_REASONING_EFFORT=none`** in `.env`. Reasoning models write a full
`<think>...</think>` block before the actual reply by default, which adds
real latency for a live voice bot. Note this needs to be set at the
request-body level (which this env var controls) - the `ollama run
--think=false` CLI flag does not reliably suppress it on every
Ollama/model version, confirmed by testing directly against both.

**Network reachability matters here.** If STT/TTS/the bots run on Railway
but the LLM runs on your own machine or a home server, Railway's servers
need to actually be able to reach it over the internet — a server sitting
behind home NAT with no port forwarding is invisible to Railway. Options:
expose it via a tunnel (Tailscale Funnel, Cloudflare Tunnel, ngrok) and
point `OPENAI_BASE_URL` at that public tunnel URL, or run the LLM on a
machine with a real public IP (a VPS, or a Railway service itself if it's
small enough to run without a GPU). Either way, put something in front of
it that requires an API key/token if it's reachable from the public
internet — an unauthenticated local LLM server exposed publicly is an open
door for anyone who finds the URL to burn your compute.

**If you're using DDNS on your own server instead of a tunnel service**,
DDNS alone isn't enough — you also need:

1. **Port forwarding** on your router (80 and 443) to that machine.
2. **A real public IP** — some ISPs put home connections behind carrier-grade
   NAT, which silently breaks port forwarding. Verify your router's WAN IP
   matches what an external site reports from a device on that network.
3. **HTTPS + an API key check in front of the model server.**

`deploy/llm-gateway/` has a ready-to-use reverse proxy for exactly this:
a [Caddy](https://caddyserver.com) config that gets you free automatic
HTTPS via your DDNS hostname and rejects any request that doesn't carry
the right `Authorization: Bearer <token>` header, before it ever reaches
your model server. To use it, on the machine running your LLM server:

```
cd deploy/llm-gateway
cp .env.example .env   # fill in LLM_PUBLIC_HOSTNAME, a generated LLM_API_KEY, and LLM_UPSTREAM
docker compose up -d
```

Then set, in the bot fleet's own `.env`:

```
OPENAI_BASE_URL=https://yourname.ddns.net
OPENAI_API_KEY=<the same LLM_API_KEY value>
```

Verify it's actually reachable from outside your network (not just your
own LAN, which can give a false positive) before wiring it into the bot:

```
curl -H "Authorization: Bearer <LLM_API_KEY>" https://yourname.ddns.net/v1/models   # expect a real response
curl https://yourname.ddns.net/v1/models                                            # expect 401
```

#### Flight plan awareness (optional)

If pilots file flight plans through a separate app (e.g. one built with
[Lovable](https://lovable.dev), which defaults to a Supabase backend), set
`SUPABASE_URL` and `SUPABASE_KEY` in `.env` and every bot will pull the
currently filed flight plans before generating each reply, and pass them
to the LLM so it can match the pilot's spoken callsign to a plan and use
its route/altitude/aircraft type where relevant.

This is entirely optional — leave both blank and the bot behaves exactly
as before, working from the radio transcript alone. There's no separate
"is this callsign in the database" step in code: the whole flight plan
list gets included as context and the LLM itself matches the pilot's
spoken callsign against it (LLMs handle the fuzzy phonetic matching -
e.g. "four two yankee" → `N42Y` - better than a hand-written parser would).

`src/flightplans/store.js` is already matched to this project's actual
`flight_plans` table: `callsign` (required to appear in the context at
all), `aircraft`/`aircraft_icao`, `registration`, `dep_icao`/`arr_icao`,
`route`, `waypoints`, `cruise_alt`, `cruise_speed`, `squawk`,
`flight_rules`, `remarks`, `atc_note` — table name overridable via
`SUPABASE_FLIGHT_PLANS_TABLE`. Results are cached for 30 seconds per
process so a burst of radio calls doesn't hammer Supabase.

The table also has `status` and `atc_status` columns that aren't filtered
on yet (there's a `delete_landed_flight_plans()` DB function, which
suggests landed flights are already cleaned up server-side, so this may
not matter in practice) — if plans that shouldn't be "live" yet (e.g.
pending ATC approval) start showing up in bot replies, add a `.eq()`
filter on one of those columns in `fetchAndFormat()`.

#### Chart data (real taxiways, runways, and frequencies)

`data/charts/<ICAO>.json` holds per-airport reference data — runway
designators/headings/lengths, ATC frequencies, and other chart labels
(taxiways, aprons, gates) — extracted from the community
[PTFS Charts](https://github.com/Treelon/ptfs-charts) repository
(CC BY-SA 4.0). Every bot automatically loads the file matching its
`persona.airport` (e.g. `"airport": "IZOL"` loads `data/charts/IZOL.json`)
once at startup and includes it in context on every reply, so the model
references real taxiway names and frequencies instead of inventing
plausible-sounding ones. Missing airport → the bot just skips this
context, same graceful fallback as flight plans.

26 airports are pre-extracted and checked into this repo already. To
re-extract (e.g. after the source charts repo updates, or to add more
airports from it):

```
git clone https://github.com/Treelon/ptfs-charts /tmp/ptfs-charts
node scripts/extract-charts.js /tmp/ptfs-charts
```

This is a heuristic extraction (see `scripts/extract-charts.js`'s header
comment for exactly how), not a validated schema — spot-check
`data/charts/<ICAO>.json` for an airport before trusting it, especially
for chart layouts the extractor hasn't been tested against. Known gap:
water/seaplane runways (e.g. Tavaro Seabase) use a notation the runway
parser doesn't recognize, so those come back with an empty runway list
even though the chart has one.

**Attribution:** these charts are licensed CC BY-SA 4.0 by their
contributors at https://github.com/Treelon/ptfs-charts. If you
redistribute `data/charts/` or anything derived from it outside this
project, carry that attribution and license forward.

#### Oceanic tracks

`data/oceanic-tracks.json` holds the named oceanic routes connecting
islands (e.g. `Track A: SAUTH_N <-> ORENJI_S`), sourced from the
server's own ATC365 Oceanic Tracks Chart. Unlike the per-airport chart
data above, this is fleet-wide — every bot includes the full track list
in context regardless of position, so any bot can reference a real track
letter and its actual entry/exit points if a pilot requests an oceanic
clearance, instead of inventing one.

To update it (a track added, a point renamed, etc.), just edit
`data/oceanic-tracks.json` directly — it's a plain array of
`{ "track", "point1", "point2" }` objects, no extraction script needed
since there's no image/chart to parse this data out of.

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
    "airport": "IZOL",                // optional; match a data/charts/<ICAO>.json filename to enable real chart data
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

### 6. Optional: deploy the monitoring dashboard

`monitor/` is a small, separate service — a live web dashboard showing
every bot's logs in one place, with an online/offline status card per bot.
Worth setting up once you're running more than a couple of bots at once
(e.g. the 40-airport fleet), since digging through 40 separate Discord log
channels or Railway log tabs to find one bot's error isn't practical.

It's a standalone app, deployed as its own Railway service, independent of
the bot fleet:

```
cd monitor
npm install
cp .env.example .env   # fill in INGEST_API_KEY and DASHBOARD_USERNAME/PASSWORD
npm start              # runs locally on :3000 by default
```

On Railway: **Deploy from GitHub repo**, set the service's root directory
to `monitor/`, and set `INGEST_API_KEY`, `DASHBOARD_USERNAME`, and
`DASHBOARD_PASSWORD` as environment variables (`PORT` is provided by
Railway automatically). Generate a public domain for it, same as any other
Railway service.

Both `INGEST_API_KEY` and the dashboard credentials are technically
optional — omit them and the service just logs a startup warning and runs
open — but skipping them means anyone who finds the URL can either post
fake bot logs or read live pilot transcripts, so set them.

Then, in the **bot fleet's** `.env` (not the monitor's):

```
MONITOR_URL=https://your-monitor-service.up.railway.app
MONITOR_API_KEY=<same value as the monitor's INGEST_API_KEY>
```

Every bot automatically starts pushing its logs there — no other config
needed, since `src/utils/logger.js` (used everywhere in this codebase)
forwards to the monitor whenever `MONITOR_URL` is set. A monitor outage
never affects the bots themselves: the forwarding call is fire-and-forget
and swallows its own errors.

Each bot also sends a quiet "heartbeat" log line every 60 seconds after
it's ready, so the dashboard's online/offline status stays accurate even
during long quiet stretches with no radio traffic — a bot is shown
offline once nothing's been heard from it for 90 seconds.

## Known limitations

- **Not tested against live Discord voice in this environment** — this
  sandbox has no way to create a real bot token or join an actual voice
  channel, so the code has been reviewed and syntax/dependency-checked but
  not run end-to-end. Test it against a real server before relying on it.
- Costs money unless you self-host STT/TTS: every pilot transmission costs
  one transcription call, one LLM call, and one speech synthesis call.
- STT/TTS default to OpenAI's hosted APIs; self-hosting requires a server
  that implements the same request/response contract (see above) — an
  incompatible server needs a small adapter change in
  `src/speech/providers/`.
- The human-controller handoff is a stub (see above) plus a manual chat
  command — there's no automatic detection of a human joining as ATC yet.
- One voice utterance is processed at a time per bot; if two pilots key up
  on the same frequency simultaneously, replies still go out in order but
  playback isn't real radio-style priority/blocking.
