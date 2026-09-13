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

A human controlling a position - whether or not they've paused the AI -
can also send the same CPDLC/PDC datalink messages the LLM can (see the
Monitor section's "Datalink messages" below), by hand, via chat command:

```
!tower cpdlc contact N42Y Barths Center 132.550
!tower cpdlc pdc N42Y Cessna 42Yankee is cleared to Rockford as filed...
!tower cpdlc text N42Y Traffic alert, expect vectors shortly
```

Always sent as that bot's own ATC position - never something the human has
to type themselves. `facility` can contain spaces (frequency is always the
last word); `pdc`'s clearance and `text`'s message are everything after the
callsign.

A moderator can also send a fleet-wide announcement - server news or an
update, not an instruction to one aircraft - which every pilot currently
polling for datalink messages receives, regardless of which bot's channel
it's sent from or which frequency they're on:

```
!tower broadcast Runway 9/27 closed for maintenance until further notice.
```

This requires the **Administrator** permission specifically, not just
"Manage Server" like every other command here - it reaches every pilot on
the server at once, so it's scoped to moderators rather than every regular
controller.

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
[Lovable](https://lovable.dev)) that exposes a bot API for it, set
`FLIGHTRADAR365_BOT_KEY` in `.env` and every bot will pull the currently
filed flight plans before generating each reply, and pass them to the LLM
so it can match the pilot's spoken callsign to a plan and use its
route/altitude/aircraft type where relevant.

This is entirely optional — leave it blank and the bot behaves exactly
as before, working from the radio transcript alone. There's no separate
"is this callsign in the database" step in code: the whole flight plan
list gets included as context and the LLM itself matches the pilot's
spoken callsign against it (LLMs handle the fuzzy phonetic matching -
e.g. "four two yankee" → `N42Y` - better than a hand-written parser would).

`src/flightradar365/client.js` talks to the bot API
(`GET .../data?resource=flight_plans`, authenticated via the
`x-bot-key` header); `src/flightplans/store.js` formats the response for
the LLM, expecting fields matching this project's actual `flight_plans`
schema: `callsign` (required to appear in the context at all),
`aircraft`/`aircraft_icao`, `registration`, `dep_icao`/`arr_icao`,
`route`, `waypoints`, `cruise_alt`, `cruise_speed`, `squawk`,
`flight_rules`, `remarks`, `atc_note`. Results are cached for 30 seconds
per process so a burst of radio calls doesn't hammer the API.

The client also exposes `getAirports()`/`getAtis()` reads and
`publishAtis()`/`updateFlightPlan()`/`deleteFlightPlan()` write actions -
none of these are wired into bot behavior yet, they're just available
functions for whenever there's a concrete trigger in mind for them.

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

#### ATIS bots

Set `"type": "atis"` on an entry to get a dedicated ATIS bot instead of a
regular ATC position — it joins its own voice channel (its own frequency,
same as every other position) and continuously loops the current ATIS
report, re-synthesizing only when the content actually changes (polled
from the flightradar365 bot API every 60 seconds). It never listens —
no STT, no LLM, no `"ai"` field needed at all:

```jsonc
{
  "name": "Izolirani ATIS",
  "type": "atis",
  "tokenEnv": "BOT_ATIS_TOKEN",
  "guildId": "...",
  "voiceChannelId": "...",           // its own dedicated ATIS channel
  "persona": {
    "airport": "IZOL",               // required - matches the right ATIS entry from the API
    "callsign": "Izolirani ATIS",    // optional, defaults to "<airport> ATIS"
    "ttsVoice": "alloy"
  }
}
```

Requires `FLIGHTRADAR365_BOT_KEY` to be set (see [Flight plan
awareness](#flight-plan-awareness-optional) above for the same API). The
exact ATIS response field names aren't confirmed against real API docs
yet — `src/bot/AtisBot.js`'s `formatAtisBroadcast()` handles a few
reasonable shapes and logs the raw field names if nothing matches, same
pattern as the flight plan integration.

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

### Position tracking (companion app)

The monitor also relays live aircraft position estimates from pilots
running the [companion app](companion/README.md), a local Electron app
that reads a pilot's own game HUD and minimap. This lets Approach,
Departure, and Center bots vector traffic using an actual estimated
position instead of only what the pilot says over the radio.

Two authenticated endpoints, gated by the same `INGEST_API_KEY` as the log
endpoints:

```
POST /api/position    — companion app reports one aircraft's estimated fix
GET  /api/positions    — bots poll this for all currently-fresh fixes
```

`POST /api/position` body:

```json
{
  "callsign": "N42Y",
  "aircraftType": "A220",
  "speed": 241,
  "position": {
    "distanceNm": 12.4,
    "bearingDeg": 230.5,
    "referenceAirport": "IZOL",
    "altitudeFt": 4400,
    "headingDeg": 270,
    "fixAgeSec": 38
  }
}
```

Positions are kept in memory only and expire after 30 seconds without a
fresh report, so `GET /api/positions` never returns stale traffic — a
pilot who closes the companion app or loses connectivity simply drops off
the list. Bots fetch this via `src/atc/positions.js`, which caches the
poll for 5 seconds and formats each row (distance/bearing from a named
airport, altitude, heading, and a staleness note once a fix is more than
a minute past its last minimap correction) into the LLM's context.

### Datalink messages (CPDLC/PDC)

The monitor also relays one-directional text messages from an ATC bot to a
specific pilot's companion app — comparable to real-world CPDLC/PDC. Two
motivating cases: reaching an aircraft that isn't on that bot's frequency
at all (e.g. "contact me" after an uncontrolled-field departure), and
delivering a routine IFR clearance as text (a PDC) instead of reading the
whole thing aloud when voice traffic is heavy. See `src/atc/datalink.js`
for how a bot's reply triggers this, and the `CPDLC:` output contract in
`src/ai/systemPrompt.js`.

```
POST /api/cpdlc             — an ATC bot sends one message to a callsign
POST /api/cpdlc/broadcast   — a moderator sends one message to every pilot
GET  /api/cpdlc             — companion app polls for its callsign's new messages (direct + broadcast)
```

`POST /api/cpdlc` body (`kind` is `"contact"`, `"pdc"`, or `"text"`; only
the fields that kind uses are required):

```json
{
  "callsign": "N42Y",
  "kind": "contact",
  "fromPosition": "Barths Center",
  "facility": "Barths Center",
  "frequency": "132.550"
}
```

`POST /api/cpdlc/broadcast` body is just `{"fromPosition": "...", "text":
"..."}` - always `kind: "text"`, since a "contact"/"pdc" message only makes
sense addressed to one aircraft. See the `!tower broadcast` chat command
above.

`GET /api/cpdlc?callsign=N42Y&since=<last id seen>` returns that callsign's
direct messages merged with any broadcasts, sorted together (both share one
id sequence), and only ones newer than `since` - so the companion app never
re-shows something it already displayed. Direct messages are capped at 20
per callsign; broadcasts share a separate 20-message cap. Both expire after
10 minutes unpolled, mirroring the position-staleness pattern above.

This is ATC-to-pilot only for now — there's no way for a pilot to type a
reply back into the bot's conversation yet. The LLM itself still has no
scheduled/proactive trigger (it only emits a `CPDLC:` directive as part of
a reply to some transmission that already triggered its turn), but a human
controlling that position isn't limited by that — see "How the human
handoff works today" above for the `!tower cpdlc` chat command, which
sends one on demand regardless of whether anything just triggered a turn.

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
