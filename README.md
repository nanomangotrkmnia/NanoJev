# NanoJev

NanoJev is a Minecraft Java Edition PvP bot. It joins a server through
[Mineflayer](https://github.com/PrismarineJS/mineflayer), keeps track of itself, its target, and
the nearby world, chooses combat moves are actually possible right now, and sends the info to
a System One decision model: TypeSafe's Jev, or the open-source OpenJev in order to make the decision. 

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
- [Vanilla-only behaviour](#vanilla-only-behaviour)
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

The model is a classifier, not a writer. NanoJev sends it a small JSON snapshot of the fight plus
one `choice` question whose answers are the legal moves, then reads back the chosen label, the
probability of each label, and a confidence. There is no generated text to parse and no prompt
tricks, because the model's job is only to choose.

## Prerequisites

- Node.js 22 or newer (the official TypeSafe SDK needs it).
- A Minecraft Java Edition server you are allowed to connect to.
- At least one way to reach a model:
  - a TypeSafe API key (hosted Jev), or
  - a Codiv API key (hosted OpenJev), or
  - Docker with an NVIDIA GPU, or Python, to run OpenJev yourself.

## Install

```bash
npm install
npm run build
```

On Windows you can skip both and run `start.bat`, which installs, builds, runs first-time setup,
and starts the bot.

## Choose a decision backend

There are three backends. They all speak the same `POST /v1/systemone` API as TypeSafe Jev, so a
single client (`@typesafe-ai/sdk`) talks to any of them. Only the URL, the key, and the model name
change.

| Backend | `NANOJEV_JEV_BACKEND` | Endpoint | Key | Hardware |
|---|---|---|---|---|
| TypeSafe Jev (cloud) | `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` from [console.typesafe.ai](https://console.typesafe.ai) | none |
| Local OpenJev | `openjev` | `http://127.0.0.1:8080/v1/systemone` | none (a local server usually ignores auth) | GPU / CPU per model |
| Codiv (hosted OpenJev) | `codiv` | `https://api.codiv.ai/v1/systemone` | `OPENJEV_API_KEY` (`sk-codiv-...`) from [codiv.ai](https://codiv.ai) | none |

`nanojev setup` asks which one to use on the first run, and you can edit `.env` by hand at any
time.

## Configure

Copy `.env.example` to `.env` and fill it in, or run:

```bash
nanojev setup        # npm run setup
```

`start.bat` runs setup by itself the first time, when there is no `.env`.

Common settings:

| Variable | Meaning | Default |
|---|---|---|
| `NANOJEV_MODE` | `production` or `development` (dev unlocks the console and extra diagnostics) | `production` |
| `NANOJEV_JEV_BACKEND` | `typesafe`, `openjev`, or `codiv` | `typesafe` |
| `TYPESAFE_API_KEY` | TypeSafe API key (hosted Jev) | — |
| `OPENJEV_BASE_URL` | OpenJev server root | `http://127.0.0.1:8080` |
| `OPENJEV_API_KEY` | OpenJev / Codiv key (`sk-codiv-...`) | — |
| `OPENJEV_MODEL` | OpenJev model id | `openjev-latest` |
| `MC_ADDRESS` | Full server address, `host` or `host:port` (for example `play.example.net:25617`); when it has a port it overrides `MC_HOST`/`MC_PORT` | — |
| `MC_HOST` / `MC_PORT` | Minecraft server | `localhost` / `25565` |
| `MC_USERNAME` | Bot username | `NanoJev` |
| `MC_AUTH` | `offline` or `microsoft` | `offline` |
| `MC_VERSION` | `auto` (read from the server ping) or a pinned version | `auto` |
| `MC_TARGET` | Target username; blank means nearest player | — |
| `MC_TARGET_MODE` | `explicit` or `nearest` (chosen automatically) | auto |
| `MC_TARGET_RANGE` | Acquisition range, in blocks | `32` |
| `NANOJEV_LOOP_HZ` | Observation and execution tick rate | `20` |
| `NANOJEV_DECISION_MIN_INTERVAL_MS` | Minimum gap between decision requests | `250` |
| `NANOJEV_ATTACK_INTERVAL_MS` | Attack cooldown estimate, floored at one tick (50 ms) | `625` |
| `NANOJEV_ATTACK_RANGE` | Melee reach in blocks, capped at vanilla (3) | `3` |
| `NANOJEV_WTAP_ENABLED` | Offer the W-tap as a selectable action | `true` |
| `NANOJEV_WTAP_RELEASE_TICKS` | Ticks to hold the W-tap release (1 tick = 50 ms) | `2` |
| `NANOJEV_HITSELECT_ENABLED` | Offer hitselect (hold the hit, then jump-crit) | `true` |
| `NANOJEV_HITSELECT_TICKS` | Ticks to hold the hit before the crit (1–3) | `2` |
| `NANOJEV_JUMP_RESET_ENABLED` | Offer jump reset (jump on the hit's tick to cut knockback) | `true` |
| `NANOJEV_REFLEX_ATTACK` | Swing the moment the attack is off cooldown, whatever the LLM chose | `true` |
| `NANOJEV_FALLBACK_ACTION` | Act on the obvious move until the first decision lands | `true` |
| `NANOJEV_KNOCKBACK_WINDOW_MS` | Keep momentum/aim across the server's rubber-band for this long after a hit (`0` disables) | `350` |
| `NANOJEV_ON_JEV_FAILURE` | `halt` or `hold` | `halt` |
| `NANOJEV_LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |

`.env.example` has the complete list. 

## Run

```bash
npm start            # node dist/index.js run   (after npm run build)
npm run dev          # tsx src/index.ts run     (no build step)
```

Commands:

```bash
nanojev                 # connect the bot and start the combat loop
nanojev run             # same as the default
nanojev setup           # interactive configuration, writes .env
nanojev settings        # edit .env interactively (basic and advanced menus)
nanojev models          # list OpenJev models with hardware and ease-of-run
nanojev openjev         # start the local OpenJev server (add --execute to actually run it)
nanojev codiv           # how to use Codiv's hosted OpenJev, plus a reachability check
nanojev help
```

On Windows, `settings.bat` opens the same editor, so you can change the backend, keys, server
address, username, target, timing, and techniques without running full setup again. On any platform
`npm run settings` does the same thing. It splits the options into a basic menu (backend, API key,
model, server, username, auth, target) and an advanced menu (OpenJev endpoint, targeting,
connection and reconnect, decision timing, loop and attack tuning, techniques, log level), and
writes whatever you change back to `.env`.

## Development mode

`nanojev setup` asks how you want to run NanoJev on the first run (and `NANOJEV_MODE` sets it
afterwards):

- `production` (default) — normal play; the dev tooling is not wired up.
- `development` — unlocks the test tooling used to develop and tune the bot. From a terminal you get
  an interactive **dev console** on stdin: type a command and press Enter.

  | Command | Effect |
  |---|---|
  | `help` | list the commands |
  | `status` | current action, forced action, target, distance, decision state |
  | `metrics` | decision count, ok/failures/timeouts/stale, latency |
  | `force <action>` | run one action every tick, bypassing the model (for example `force strafe_left`) |
  | `auto` | clear the forced action and hand control back to the model |
  | `stop` / `start` | pause and resume the combat loop |
  | `quit` | shut the bot down |

  Forcing an action is the quickest way to exercise a single move — a W-tap, a strafe, a hitselect —
  without waiting on the model. More dev/test features belong behind this mode.

Switch modes any time by setting `NANOJEV_MODE=development` in `.env` or through `nanojev settings`.

On startup NanoJev prints one line with the server, bot username, auth mode, Minecraft version
support, target mode, loop settings, and the decision provider (model and endpoint, never the key).

## The local OpenJev server

[OpenJev](https://github.com/razorback16/openjev) is an independent, open, Jev-compatible System
One server. It runs DiffusionGemma, Laya, Verdict, CLM, JevK5, or Cloudflare's Clef models and
exposes the same API as Jev.

`run-openjev.bat` (Windows) and `nanojev openjev` both detect your hardware, list the models as
`id (Supports: <hardware>, <ease-of-run 1-10>)`, let you choose one, write the choice to `.env`
(`NANOJEV_JEV_BACKEND=openjev`, `OPENJEV_MODEL=...`), and check whether a server is already
running. You can change the model later. A menu line looks like this:

```
clef-flash-1.0 (Supports: NVIDIA Blackwell GPU (RTX 50 / Pro), ~12 GB VRAM, 6/10)
    Clef-flash - Clef-flash by Cloudflare: Clef on Qwen3.5-9B, NVFP4
```

The models:

| Model id | Model | Size | Runs on | Ease |
|---|---|---|---|---|
| `openjev-latest` | DiffusionGemma 26B-A4B (NVIDIA / Google) | 26B / 4B active | NVIDIA 24 GB+ or Apple silicon 16 GB | 5/10 |
| `laya-1.0` | Laya (Nandakishor M / Convai) | 421M | GPU or CPU | 10/10 |
| `verdict-1.4` | Verdict (Heman10x) | 151M | GPU or CPU | 10/10 |
| `clm-v0.1` | CLM (Contrastive-LM) | 8B + heads | NVIDIA (vLLM) | 4/10 |
| `jevk5-0.3` | JevK5 (Alibi Serikbay) | 4B | NVIDIA (vLLM) | 6/10 |
| `clef-1.0` | Clef (Cloudflare) | 27B NVFP4 | NVIDIA Blackwell | 3/10 |
| `clef-flash-1.0` | Clef-flash (Cloudflare) | 9B NVFP4 | NVIDIA Blackwell | 6/10 |

To launch it, `run-openjev.bat` (or `nanojev openjev --execute`) clones the OpenJev repo into
`tools/openjev`, picks the right backend (`docker compose up -d` on an NVIDIA GPU, otherwise
`pip install -e '.[backend]' && python -m openjev`), and starts it on `127.0.0.1:8080`. The
OpenJev README covers the GPU, Docker, and Apple-silicon details.

If you would rather not run anything locally, use Codiv: `nanojev codiv` prints the exact `.env`
values, or choose Codiv in `nanojev setup`.

## Target selection

- Setting `MC_TARGET=<username>` locks onto that player. Other players nearby are not treated as
  hostile.
- Leaving `MC_TARGET` blank (or setting `MC_TARGET_MODE=nearest`) targets the nearest eligible
  player instead.
- A player is eligible only if it is a live player entity, is not the bot, is still present, has
  positive health where health is known, and is within `MC_TARGET_RANGE`.
- The current target is kept while it stays valid and only reacquired once it is lost.

## The decision and action loop

The bot does not run everything on one timer. Observation sampling and action execution share the
tick loop (`NANOJEV_LOOP_HZ`, 20 Hz by default). Aiming at the target happens every tick as well.
Decision requests go out on their own asynchronous path, one at a time, spaced by
`NANOJEV_DECISION_MIN_INTERVAL_MS` and backed off exponentially after failures. Logging and metrics
run on a slow timer. A slow model therefore cannot stall movement or attacks.

The design follows the per-tick controllers used by dedicated combat bots: the bot acts on **every**
tick and never blocks on the model. Two things make that work when the model is an LLM that answers
in seconds rather than in one tick:

- **Reflex attack.** A stock client swings the instant its attack is off cooldown. NanoJev does the
  same (`NANOJEV_REFLEX_ATTACK`): if the target is in reach and the cooldown is up, it swings,
  whatever action the model last selected. The model therefore chooses *positioning, spacing, and
  technique*, not whether to hit — so attacks land at the cooldown rate instead of the decision
  rate. The only exception is a technique that deliberately times the swing (hitselect).
- **Movement reflex.** The bot never stands still: every tick it closes the gap when the target is
  out of reach, circles (strafes) when in range, and backs off when it is hurt — independently of
  the model (`NANOJEV_FALLBACK_ACTION`). It also jumps to climb to a target on a block above or to
  get over a step blocking the approach. When the model picks its own movement action (approach,
  strafe, retreat, reposition) that takes precedence; the reflex only fills the movement in when the
  model chose something stationary (attack, hold, track) or has not answered yet.

Only one decision is ever in flight. A reply is thrown away as stale if the target changed, if the
observation changed in a way that matters (distance, health, range state, attack readiness, open
directions), or if the chosen action is no longer legal. While the next decision is pending, the
bot keeps using its current valid action. If only one action is possible, no decision is requested
at all.

A 24 ms decision interval would work out to about 42 requests a second. That number is not a claim
NanoJev makes: network inference can take much longer. The reflex and fallback layers mean the
request rate does not bound the attack rate; NanoJev still measures and reports the real decision
latency (median and p95), the timeout count, and the decision throughput instead of assuming one.

## Combat actions

The model chooses from the actions that are valid at that moment:

`approach`, `close_distance_sprinting`, `strafe_left`, `strafe_right`, `retreat`, `hold_position`,
`track_target`, `attack_target`, `jump_attack`, `sprint_reset_attack`, `hitselect`, `jump_reset`,
`raise_shield`, `reposition`.

The rules that decide what gets offered live in code:

- `attack_target`, `jump_attack`, `sprint_reset_attack`, `hitselect`, and `jump_reset` need a valid
  in-range target and an attack that is off cooldown. The jump-based ones (`jump_attack`,
  `hitselect`, `jump_reset`) and the W-tap also need the bot on the ground with room to move.
- The techniques are offered next to the plain attack, so the model decides whether to just hit or
  to set up a W-tap, a hitselect, or a jump reset. Turn each off with `NANOJEV_WTAP_ENABLED`,
  `NANOJEV_HITSELECT_ENABLED`, or `NANOJEV_JUMP_RESET_ENABLED`.
- Movement actions are left out when the space next to the bot is blocked.
- `raise_shield` only appears when the bot actually has a shield.
- Movement and technique actions do not hold back the swing: while the attack is off cooldown the bot
  swings on its own (`NANOJEV_REFLEX_ATTACK`). `hitselect` is the exception, since holding the swing
  is its entire point.
- Every option carries a description of what it does, when it is valid, and what it costs.

### W-tap (sprint reset)

A W-tap releases `forward` and `sprint` for a beat, lands one hit while not sprinting, then sprints
again. NanoJev plays it as a short timeline (release, hit, re-sprint) rather than a fixed input.
Minecraft runs at 20 ticks a second, so timing is quantised to 50 ms, and the release is held for
`NANOJEV_WTAP_RELEASE_TICKS` (default `2`, about 100 ms). Two ticks is more reliable than one,
because a single tick can slip past the server without it ever seeing the released state. The
knockback benefit depends on the server and version and is not guaranteed, so it is documented as
an estimate in the same way as the attack cooldown.

### Hitselect (delayed crit)

`hitselect` holds the hit for `NANOJEV_HITSELECT_TICKS` (1 to 3 ticks), then jumps and attacks
while airborne and falling, which is the condition for a critical hit. The bot checks its real
`onGround` and vertical velocity (`entity.velocity.y < 0`), so the swing only goes out when the
crit is actually possible; if it never becomes possible inside the window, the bot does not attack
and moves on. Crits do much more damage in versions that have them, and the timing and values vary
by version, so this is an approximation too. The cost is that waiting can mean eating the
opponent's hit first.

### Jump reset

`jump_reset` jumps on the same tick as the hit. Jumping at that moment can cancel or reduce the
knockback the bot takes, and it keeps the attack on schedule. As with the other techniques, the
knockback reduction depends on the server and version and is not guaranteed.

### Techniques are committed once started

All three techniques are timelines advanced one phase per tick. A decision that arrives while a
technique is still running is ignored for that action, so the sequence keeps going. It only starts
over when a different action is chosen, or when the same action is chosen again after the previous
sequence has finished. Without this, a "hold for a few ticks, then crit" would be restarted every
decision interval and would never land.

Movement controls are released when an action ends, the target disappears, the bot disconnects, or
NanoJev shuts down, and two action routines can never drive the bot at once.

## Vanilla-only behaviour

Everything NanoJev does is something a stock Minecraft client can do. There are no client-side
cheats or modifications:

- It drives Mineflayer only through normal inputs: the movement control states
  (`forward`/`back`/`left`/`right`/`jump`/`sprint`/`sneak`), look, attack, and use-item. It never
  writes packets, never sets position, never teleports, and never changes client physics.
- The one velocity it applies is the knockback the server already sent. On Minecraft 1.21.9+ the
  `entity_velocity` packet carries blocks per tick, but Mineflayer still scales it by the older
  1/8000 fixed-point factor, shrinking real knockback to nothing. `src/minecraft/knockback.ts`
  copies the packet's value onto the entity so the bot is knocked back exactly as a stock client
  would be.
- The same helper keeps that momentum and the bot's aim across the server's position re-syncs. Some
  servers and anti-cheats re-send the player's position every tick (and, mid-knockback, rubber-band
  the bot back toward where it was); Mineflayer treats each as a teleport and zeroes the velocity
  and overwrites the rotation, which cancels the knockback and drags the aim off the target. For a
  short window after a hit (`NANOJEV_KNOCKBACK_WINDOW_MS`, and always for a packet that does not
  actually move the bot) it keeps the momentum and aim, matching what a stock client sees because
  those corrections are never sent to one. A genuinely larger correction is still a teleport and is
  obeyed. It reads the packets, sends nothing, and never invents motion. Set the window to `0` to
  turn this off and let the server's corrections win.
- Attack range is capped at the vanilla melee reach of 3.0 blocks (`VANILLA_ATTACK_REACH`). The
  executor clamps it again as a second guard, and `NANOJEV_ATTACK_RANGE` cannot be set higher.
- Movement is ordinary sprinting. The attack interval cannot go below one server tick (50 ms), and
  the bot sends at most one attack per tick.
- Techniques cannot be timed below a single server tick.
- Apart from the knockback window above, the server is authoritative throughout. Mineflayer only
  proposes movement, and the server accepts or corrects it exactly as it would for any other client.

A regression test (`test/vanilla.test.ts`) checks the reach and interval caps and scans the
bot-behaviour modules for cheat-only APIs (`physicsEnabled`, raw packet sends, teleport or position
writes), and asserts the only packet NanoJev ever hand-writes is the required resource-pack
response.

## Coordinates and rotation conventions

Mineflayer stores entity rotation in radians, in a convention offset from vanilla ("notchian") yaw.
NanoJev uses it as-is and documents it:

- Coordinates: `+X` is east, `+Y` is up, `+Z` is south.
- `entity.yaw`: `0` faces north (`-Z`), `+π/2` faces west (`-X`), `-π/2` faces east (`+X`), and `π`
  faces south (`+Z`).
- `entity.pitch`: `0` is level, positive looks up, range `[-π/2, π/2]`.
- To face a point: `yaw = atan2(-dx, -dz)` and `pitch = atan2(dy, hypot(dx, dz))`, the same as
  Mineflayer's own `bot.lookAt`.
- Relative yaw in the observation is in degrees, positive meaning the target is to the bot's left.

Values that cannot be read directly are labelled. Target health is `measured` when the entity
exposes it and `unavailable` otherwise. Line of sight is `estimated` from a world raycast, or
`unavailable`. Attack readiness is `estimated` from the configured interval.

## Recovery and safety

| Failure | Behaviour |
|---|---|
| Jev/OpenJev auth error | New combat actions stop; the bot does not act on model output. |
| Request timeout | Decision discarded, controls released, bounded exponential backoff. |
| Service outage or 5xx | Same as a timeout, except with `NANOJEV_ON_JEV_FAILURE=hold` the previous action is kept. |
| Malformed or off-schema answer | Rejected, logged, and counted; with the default `halt` the chosen action is dropped. |
| Action not in the offered set (for example an attack now on cooldown) | Dropped as stale, not fatal; the current action and the reflex continue. |
| Target disappears | Target reacquired or cleared, controls released. |
| Minecraft disconnect | Bounded reconnect with exponential backoff, never on auth failures. |
| Kick: whitelist, ban, or no permission | Treated as fatal, since retrying will not help; NanoJev exits with an error and a clear message. |
| Kick: server full or restarting | Treated as a normal disconnect and retried with backoff. |
| Respawn or world change | Observations and decisions are rebuilt from the new state. |
| Unhandled exception, SIGINT, or SIGTERM | Graceful shutdown: stop the loop, release controls, disconnect. |

NanoJev never quietly swaps in a rule-based decision and reports that Jev made it. The reflex swing
and the pre-decision fallback are local, explicit, and configurable (`NANOJEV_REFLEX_ATTACK`,
`NANOJEV_FALLBACK_ACTION`), and are logged as their own thing, distinct from a model decision. Tests
use a fake provider; the production path never does.

## Logging and metrics

Routine logs stay short, and `NANOJEV_LOG_LEVEL=debug` adds detailed observation and decision
traces. Logged: connection lifecycle, provider status, the current target, compact observations,
the offered action ids, the selected action, latency, probabilities and confidence, execution
results, and every recovery event. Secrets are redacted.

Metrics cover decision count, failures, timeouts, stale responses, median and p95 latency, and
throughput, printed every 30 seconds.

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run bench     # tick-loop micro-benchmark (dev tool)
```

The suite covers configuration validation, observation construction, angle normalization, target
acquisition and loss, legal action generation, Jev request construction, typed response parsing,
rejection of actions that were not offered, mocked Mineflayer execution, stale-response rejection,
timeouts and outages, and disconnect and shutdown cleanup. It uses a fake bot and a scripted
provider, so it needs neither a paid API call nor a live server. The live provider is tested against
a mocked `fetch`, which covers the real SDK wire format and error classes.

### Benchmarks

`npm run bench` measures the per-tick CPU cost of the hot-path pieces: observation sampling with
cold and warm caches, legal-action building, the state signatures, action execution, and aim math.
Each is printed as a share of the tick budget. It touches no network and no server, and exists to
catch regressions. In practice NanoJev's own code is well under one percent of the tick budget; the
rest is Mineflayer and network I/O.

## Supported Minecraft versions

Mineflayer `4.39.0` supports Minecraft `1.8.8` through the latest tested version, currently the
newest 1.21.x release. `MC_VERSION=auto` reads the version from the server ping, and you only need
to pin a version if auto-detection fails. The startup log reports the version that was detected.

## Limitations

- The attack cooldown is an estimate. Mineflayer does not expose the protocol cooldown, so NanoJev
  uses a configurable interval (`NANOJEV_ATTACK_INTERVAL_MS`, 625 ms by default). It is never
  treated as an exact game value.
- Line of sight is a raycast estimate, not a server-authoritative check.
- Technique timing is quantised to the 50 ms server tick. W-taps and the other techniques cannot be
  timed below that, and the server decides whether they register at all.
- Damage is never predicted. Descriptions avoid inventing damage numbers or hit probabilities.
- The quality of the decisions is the quality of the chosen backend and model. Test it on your own
  server before trusting it.
- Running a large OpenJev model locally needs the GPU or Docker setup from the OpenJev README. Codiv
  and TypeSafe's hosted Jev avoid that entirely.

## Troubleshooting

**The bot will not start: "TYPESAFE_API_KEY is required" or "OPENJEV_API_KEY is required"**
Run `nanojev setup`, or set the matching key in `.env`, or switch to the local OpenJev backend.

**"OpenJev not reachable at http://127.0.0.1:8080"**
Start it with `run-openjev.bat` (or `nanojev openjev --execute`) and wait for the model to load
(`curl http://127.0.0.1:8080/v1/models`). Or switch to `codiv` or `typesafe`.

**Connection times out, or the bot is kicked**
Set the address as `MC_ADDRESS=play.example.net:25617`, or set `MC_HOST` and `MC_PORT` separately.
For premium accounts use `MC_AUTH=microsoft` and complete the device-code sign-in. NanoJev retries
normal disconnects with backoff and stops retrying on authentication failures or a whitelist or ban
kick.

**"Server version ... is not supported"**
Pin a tested version with `MC_VERSION`, or update Mineflayer.

**Decisions are slow or timing out**
The model may be under-provisioned or the network slow. Check the logged latency, raise
`NANOJEV_DECISION_TIMEOUT_MS`, or run a smaller OpenJev model (Laya and Verdict run on CPU).

**The bot keeps acting for a moment after the model fails**
The default `NANOJEV_ON_JEV_FAILURE=halt` releases the controls and waits. `hold` deliberately keeps
the previous action, so switch to `halt` unless you want that.
