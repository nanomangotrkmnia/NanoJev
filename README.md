# NanoJev

NanoJev is an autonomous Minecraft **PvP bot**. It connects to a Minecraft Java Edition server
with [Mineflayer](https://github.com/PrismarineJS/mineflayer), observes its own state, its target
and the surrounding world, generates a **finite set of legal combat actions**, and asks a
**System One decision model** (TypeSafe's **Jev**, or the open **OpenJev** server) to pick one.
NanoJev's code decides what is *possible*, validates the model's choice, and executes it through
Mineflayer.

> The model chooses the action. NanoJev decides what is legal, validates the choice, and executes it.

---

## Contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Choose a decision backend](#choose-a-decision-backend)
- [Configure](#configure)
- [Run](#run)
- [The local OpenJev server](#the-local-openjev-server)
- [Target selection](#target-selection)
- [The decision and action loop](#the-decision-and-action-loop)
- [Combat actions](#combat-actions)
- [Coordinates and rotation conventions](#coordinates-and-rotation-conventions)
- [Recovery and safety](#recovery-and-safety)
- [Logging and metrics](#logging-and-metrics)
- [Tests](#tests)
- [Supported Minecraft versions](#supported-minecraft-versions)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
Minecraft server
   │
   ▼
Mineflayer bot                     src/minecraft/connection.ts
   │                               (connect, reconnect, timeouts, respawn, shutdown)
   ▼
Game-state observation             src/observation.ts   (self, target, environment)
   │
   ▼
Target selection                   src/target.ts        (explicit username or nearest)
   │
   ▼
Legal combat action generation     src/actions.ts       (only actions valid right now)
   │
   ▼
Structured decision request        src/jev/decision.ts  (one typed Choice question)
   │
   ▼
Jev / OpenJev / Codiv              src/jev/typesafe-provider.ts + src/openjev/*
   │                               (probabilities + confidence)
   ▼
Selected action validation         src/combat/engine.ts (offered? still legal? still fresh?)
   │
   ▼
Mineflayer action execution        src/combat/executor.ts (movement, look, attack, shield)
   │
   ▼
Updated game state ───────────────► (loop, without blocking the event loop)
```

The decision model is a **structured choice model, not a text generator**. NanoJev sends it a
compact JSON `state` and exactly one `choice` question whose options are the currently legal
combat actions. It reads back `choice`, `probabilities`, and `confidence` — no free-form text, no
JSON to coax out of a chatbot.

## Prerequisites

- **Node.js 22 or newer** (the official TypeSafe SDK requires it).
- A Minecraft Java Edition server you are allowed to connect to.
- One of:
  - a **TypeSafe API key** (hosted Jev), or
  - a **Codiv API key** (hosted OpenJev), or
  - **Docker with an NVIDIA GPU** / **Python** to run a local **OpenJev** server.

## Install

```bash
npm install
npm run build
```

Or on Windows, just run **`start.bat`** — it installs, builds, runs first-time setup, and starts
the bot in one step.

## Choose a decision backend

NanoJev supports three backends. All three speak the TypeSafe **`POST /v1/systemone`** wire API
with the same request/response shapes, so the same official `@typesafe-ai/sdk` client serves all
of them (only the base URL, API key, and model differ).

| Backend | `NANOJEV_JEV_BACKEND` | Endpoint | Key | Hardware |
|---|---|---|---|---|
| TypeSafe Jev (cloud) | `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` from [console.typesafe.ai](https://console.typesafe.ai) | none |
| Local OpenJev | `openjev` | `http://127.0.0.1:8080/v1/systemone` | none (a local server usually ignores auth) | GPU / CPU per model |
| Codiv (hosted OpenJev) | `codiv` | `https://api.codiv.ai/v1/systemone` | `OPENJEV_API_KEY` (`sk-codiv-...`) from [codiv.ai](https://codiv.ai) | none |

`nanojev setup` asks which backend to use on first run. You can also set it manually in `.env`.

## Configure

Copy `.env.example` to `.env` and fill it in, or run:

```bash
nanojev setup        # npm run setup
```

`start.bat` runs setup automatically the first time (when `.env` does not exist).

Key settings (see `.env.example` for the full list):

| Variable | Meaning | Default |
|---|---|---|
| `NANOJEV_JEV_BACKEND` | `typesafe`, `openjev`, or `codiv` | `typesafe` |
| `TYPESAFE_API_KEY` | TypeSafe API key (hosted Jev) | — |
| `OPENJEV_BASE_URL` | OpenJev server root | `http://127.0.0.1:8080` |
| `OPENJEV_API_KEY` | OpenJev / Codiv key (`sk-codiv-...`) | — |
| `OPENJEV_MODEL` | OpenJev model id | `openjev-latest` |
| `MC_ADDRESS` | Full server address, `host` or `host:port` (e.g. `play.example.net:25617`); overrides `MC_HOST`/`MC_PORT` when it contains a port | — |
| `MC_HOST` / `MC_PORT` | Minecraft server | `localhost` / `25565` |
| `MC_USERNAME` | Bot username | `NanoJev` |
| `MC_AUTH` | `offline` or `microsoft` | `offline` |
| `MC_VERSION` | `auto` (detect from ping) or a pinned version | `auto` |
| `MC_TARGET` | Target username (blank = nearest player) | — |
| `MC_TARGET_MODE` | `explicit` or `nearest` (auto) | auto |
| `MC_TARGET_RANGE` | Acquisition range, blocks | `32` |
| `NANOJEV_LOOP_HZ` | Observation/execution tick rate | `20` |
| `NANOJEV_DECISION_MIN_INTERVAL_MS` | Minimum gap between decision requests | `250` |
| `NANOJEV_ATTACK_INTERVAL_MS` | Attack cooldown approximation (see limitations) | `625` |
| `NANOJEV_WTAP_ENABLED` | Offer a W-tap (sprint reset) as a selectable action | `true` |
| `NANOJEV_WTAP_RELEASE_TICKS` | Ticks to hold the W-tap release phase (1 tick = 50 ms) | `2` |
| `NANOJEV_ON_JEV_FAILURE` | `halt` (default) or `hold` | `halt` |
| `NANOJEV_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |

Secrets are never logged; the logger redacts API-key-shaped fields.

## Run

```bash
npm start            # node dist/index.js run   (after npm run build)
npm run dev          # tsx src/index.ts run     (no build step)
```

CLI commands:

```bash
nanojev                 # connect the bot and start the combat loop
nanojev run             # same as the default
nanojev setup           # interactive first-run configuration (writes .env)
nanojev models          # list OpenJev models with hardware and ease-of-run
nanojev openjev         # start the local OpenJev server (add --execute to run)
nanojev codiv           # show how to use Codiv's hosted OpenJev and check reachability
nanojev help
```

Startup prints a concise status report: server, bot username, auth, Minecraft version support,
target mode, loop tuning, and the decision provider (model + endpoint, never the key).

## The local OpenJev server

[OpenJev](https://github.com/razorback16/openjev) is an independent, open, Jev-compatible System
One decision server. It runs DiffusionGemma, Laya, Verdict, CLM, JevK5, or Cloudflare's Clef
models and exposes the same API as Jev.

**`run-openjev.bat`** (Windows) or **`nanojev openjev`**:

1. detects your hardware,
2. lists the available models as `id (Supports: <hardware>, <ease-of-run 1-10>)`,
3. lets you pick one (you can change it later),
4. writes the choice to `.env` (`NANOJEV_JEV_BACKEND=openjev`, `OPENJEV_MODEL=...`),
5. checks whether a server is already running.

Example menu line (this is the exact format the launcher prints):

```
clef-flash-1.0 (Supports: NVIDIA Blackwell GPU (RTX 50 / Pro), ~12 GB VRAM, 6/10)
    Clef-flash - Clef-flash by Cloudflare: Clef on Qwen3.5-9B, NVFP4
```

Available models:

| Model id | Model | Size | Runs on | Ease |
|---|---|---|---|---|
| `openjev-latest` | DiffusionGemma 26B-A4B (NVIDIA / Google) | 26B / 4B active | NVIDIA 24 GB+ or Apple silicon 16 GB | 5/10 |
| `laya-1.0` | Laya (Nandakishor M / Convai) | 421M | GPU or CPU | 10/10 |
| `verdict-1.4` | Verdict (Heman10x) | 151M | GPU or CPU | 10/10 |
| `clm-v0.1` | CLM (Contrastive-LM) | 8B + heads | NVIDIA (vLLM) | 4/10 |
| `jevk5-0.3` | JevK5 (Alibi Serikbay) | 4B | NVIDIA (vLLM) | 6/10 |
| `clef-1.0` | Clef (Cloudflare) | 27B NVFP4 | NVIDIA Blackwell | 3/10 |
| `clef-flash-1.0` | Clef-flash (Cloudflare) | 9B NVFP4 | NVIDIA Blackwell | 6/10 |

To actually launch the server, `run-openjev.bat` (or `nanojev openjev --execute`) clones the
OpenJev repo into `tools/openjev`, chooses the right backend (`docker compose up -d` on an NVIDIA
GPU, otherwise `pip install -e '.[backend]' && python -m openjev`), and starts it on
`127.0.0.1:8080`. See the OpenJev README for GPU/Docker/Apple-silicon setup details.

If you do not want to run anything locally, use **Codiv**: `nanojev codiv` prints the exact `.env`
values, or choose "Codiv" in `nanojev setup`.

## Target selection

- Set `MC_TARGET=<username>` to lock onto a specific player. Other nearby players are **not**
  treated as hostile.
- Leave `MC_TARGET` blank (or set `MC_TARGET_MODE=nearest`) to auto-target the **nearest eligible
  player**.
- A target is eligible only if it is a live player entity, is not the bot, is present, has
  positive health when known, and is within `MC_TARGET_RANGE`.
- The current target is kept stable while it remains valid, and reacquired only when it is lost.

## The decision and action loop

Five concerns run on **separate schedules** so a slow network model never blocks the game:

- **Observation sampling** and **action execution** run on the tick loop (`NANOJEV_LOOP_HZ`,
  default 20 Hz).
- **Target tracking** (aim) runs every tick, independent of the decision.
- **Decision requests** are dispatched asynchronously, at most **one in flight**, gated by
  `NANOJEV_DECISION_MIN_INTERVAL_MS` and an exponential backoff after failures.
- **Logging/metrics** are sampled periodically.

At most one decision is in flight. A response is **discarded as stale** if the target changed, if
the observation changed materially (distance bucket, health bucket, range state, attack readiness,
open directions), or if the selected action is no longer legal. The current valid action is reused
across ticks while the next decision is pending. If only one action is possible, no decision is
requested at all.

> A 24 ms decision interval implies ~41.7 decisions/s. That is **not** a performance claim:
> network inference may take longer. NanoJev measures and reports actual latency (median, p95),
> timeouts, and decision throughput rather than assuming a number.

## Combat actions

The model chooses from only the actions valid in the current state:

`approach`, `close_distance_sprinting`, `strafe_left`, `strafe_right`, `retreat`, `hold_position`,
`track_target`, `attack_target`, `jump_attack`, `sprint_reset_attack`, `raise_shield`, `reposition`.

Rules enforced in code:

- `attack_target`, `jump_attack`, and `sprint_reset_attack` are offered only with a valid in-range
  target **and** when the attack is off cooldown; `jump_attack` only when grounded; the W-tap only
  when there is room to move.
- `sprint_reset_attack` (W-tap) is offered **alongside** the normal attack, so the model chooses
  whether to W-tap or just hit. Disable it entirely with `NANOJEV_WTAP_ENABLED=false`.
- Movement actions are withheld when the adjacent space is blocked (no open directions).
- `raise_shield` is offered only when a shield is actually available.
- Each option carries a description of its tactical effect, constraints, and trade-offs.

### W-tap (sprint reset)

A W-tap releases `forward`+`sprint` for a short beat, lands one hit while not sprinting, then
re-engages a fresh sprint. NanoJev executes it as a **timeline** (release phase → hit → re-sprint)
rather than a constant input. Because Minecraft runs at 20 ticks/second, timing is quantised to
50 ms; the release is held for `NANOJEV_WTAP_RELEASE_TICKS` (default `2` = ~100 ms, which is more
reliable than a single tick, where the server may not observe the released state). The knockback
benefit is **server/version dependent and not guaranteed** — it is treated as an approximation,
like the attack cooldown.

Movement controls are released when an action ends, the target disappears, the bot disconnects,
or NanoJev shuts down. Conflicting action routines cannot drive the bot at the same time.

## Coordinates and rotation conventions

Mineflayer's entity rotation is stored in **radians** in a convention offset from vanilla
("notchian") yaw. NanoJev documents and uses it exactly:

- Coordinates: `+X` = east, `+Y` = up, `+Z` = south.
- `entity.yaw`: `0` faces **north** (`-Z`), `+π/2` faces **west** (`-X`), `-π/2` faces **east**
  (`+X`), `π` faces **south** (`+Z`).
- `entity.pitch`: `0` is horizontal, positive looks **up**, range `[-π/2, π/2]`.
- Looking at a point: `yaw = atan2(-dx, -dz)`, `pitch = atan2(dy, hypot(dx, dz))` — identical to
  Mineflayer's own `bot.lookAt`.
- Relative yaw in the observation is reported in degrees, positive meaning the target is to the
  bot's **left**.

Information that is not directly available is labelled: target **health** is `measured` when the
entity exposes it and `unavailable` otherwise; **line of sight** is `estimated` from a world
raycast or `unavailable`; **attack readiness** is `estimated` from a configurable interval.

## Recovery and safety

| Failure | Behaviour |
|---|---|
| Jev/OpenJev auth error | New combat actions halt; the bot does not act on model output. |
| Request timeout | Decision discarded, controls released, bounded exponential backoff. |
| Service outage / 5xx | Same as timeout; with `NANOJEV_ON_JEV_FAILURE=hold` the previous action is kept instead. |
| Malformed / off-schema answer | Rejected; the failure is logged and counted. |
| Action not in the offered set | Rejected; never executed. |
| Target disappears | Target reacquired or cleared; controls released. |
| Minecraft disconnect | Bounded reconnect with exponential backoff; **never** on auth failures. |
| Kick: whitelist / ban / no permission | Treated as fatal (retrying cannot help); NanoJev exits with an error and a clear message. |
| Kick: server full / restarting | Treated as a normal disconnect and retried with backoff. |
| Respawn / world change | Observations and decisions are rebuilt from the new state. |
| Unhandled exception / SIGINT / SIGTERM | Graceful shutdown: stop the loop, release controls, disconnect. |

NanoJev **never** silently substitutes a rule-based decision while claiming Jev made it. The
fallback is explicit and configurable. Tests use a fake provider; the production app never does.

## Logging and metrics

Routine logs are concise; `NANOJEV_LOG_LEVEL=debug` adds detailed observation and decision traces.
Logged: connection lifecycle, provider status, current target, compact observations, the offered
action ids, the selected action, latency, probabilities/confidence, execution results, and every
recovery event. Secrets are redacted.

Metrics include decision count, failures, timeouts, stale responses, median and p95 latency, and
throughput, printed every 30 seconds.

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Tests cover configuration validation, observation construction, angle normalization, target
acquisition/loss, legal action generation, Jev request construction, typed response parsing,
rejection of un-offered actions, mocked Mineflayer execution, stale-response rejection, timeouts
and outages, and disconnect/shutdown cleanup. They use a fake bot and a scripted provider and
require **neither** a paid API call nor a live server. The live provider is exercised against a
mocked `fetch` so the real SDK wire format and error classes are tested.

## Supported Minecraft versions

Mineflayer `4.39.0` supports Minecraft **1.8.8 through the latest tested version** (currently
1.21.x / the newest release). `MC_VERSION=auto` detects the version from the server ping; pin a
specific version only if you need to. NanoJev reports the server version in its startup log.

## Limitations

- **Attack cooldown is approximate.** Mineflayer does not expose the protocol attack cooldown, so
  NanoJev uses a configurable interval (`NANOJEV_ATTACK_INTERVAL_MS`, default 625 ms). It is
  documented as an estimate, never as an exact game mechanic.
- **Line of sight is a raycast estimate**, not a server-authoritative check.
- **Technique timing is tick-quantised (50 ms).** W-taps and similar techniques cannot be timed
  below one server tick, and the server decides whether they actually register.
- **Damage is never predicted.** Descriptions avoid inventing damage or hit probabilities.
- Whole-model quality is the quality of the chosen backend/model; evaluate on your own server.
- Running a large OpenJev model locally needs the GPU/Docker setup described in the OpenJev README;
  otherwise use Codiv or TypeSafe's hosted Jev.

## Troubleshooting

**The bot will not start: "TYPESAFE_API_KEY is required" / "OPENJEV_API_KEY is required"**
Run `nanojev setup`, or set the matching key in `.env`, or switch to the local OpenJev backend.

**"OpenJev not reachable at http://127.0.0.1:8080"**
Start it with `run-openjev.bat` (or `nanojev openjev --execute`) and wait for the model to load
(`curl http://127.0.0.1:8080/v1/models`). Or switch to `codiv` / `typesafe`.

**Connection times out or the bot is kicked**
Set the address as `MC_ADDRESS=play.example.net:25617` (or `MC_HOST`/`MC_PORT` separately). For premium
accounts use `MC_AUTH=microsoft` and complete the device-code sign-in. NanoJev retries normal
disconnects with backoff and stops retrying on authentication failures or a whitelist/ban kick.

**"Server version ... is not supported"**
Pin a tested version with `MC_VERSION`, or update Mineflayer.

**Decisions are slow / timeout**
The model may be under-provisioned or the network slow. Watch the logged latency; raise
`NANOJEV_DECISION_TIMEOUT_MS`, or run a smaller OpenJev model (Laya/Verdict run on CPU).

**Bot acts for a moment after the model fails**
The default `NANOJEV_ON_JEV_FAILURE=halt` releases controls and waits; `hold` intentionally keeps
the previous action. Use `halt` unless you have a reason not to.
