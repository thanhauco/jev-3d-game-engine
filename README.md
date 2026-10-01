# Jev3D

A small 3D game engine (Three.js) whose NPCs think with **Jev**, the "System One"
decision model TypeSafe AI released in September 2026. Jev takes a `state` and a
set of typed questions and returns typed answers with calibrated probabilities:

| Type     | You send                           | You get back                                  |
|----------|------------------------------------|-----------------------------------------------|
| `choice` | `criteria: {id: description, ...}` | `choice`, `probabilities`, `confidence`       |
| `score`  | `criteria: [level0, level1, ...]`  | `score`, `legend`, `probabilities`, `confidence` |
| `noul`   | a yes/no statement                 | `noul` (probability it's true)                |

The demo game, **Sentinels**, is a stealth shooter: steal 5 data cores while four
Jev-driven guards patrol, investigate, chase, take cover, flank, retreat and raise alarms.

## Run

```bash
npm start                                   # mock brain, no key needed
TYPESAFE_API_KEY=... npm start              # real Jev (early access / waitlist)
```

Open http://localhost:5173. Controls: WASD, Shift sprint, Space jump, mouse aim, click fire, R restart.

## Architecture

```
server.js                 zero-dep static server + /api/jev proxy (key stays server-side,
                          429/529 retried with backoff) → POST api.typesafe.ai/v1/systemone
public/engine/
  Engine.js               scene/renderer, fixed 60 Hz step, entities + systems
  Physics.js              gravity, cylinder bodies vs AABBs, line-of-sight
  Input.js                keyboard + pointer-lock mouse
  Jev.js                  Choice/Score/Noul builders, JevClient, JevBrainSystem
public/game/              Sentinels demo: world, Player, Guard (Jev brain), HUD
```

**How the brain loop works (`JevBrainSystem`)**

1. Each decision tick, build one shared `state` snapshot of the world.
2. Collect every live agent's questions, prefix ids (`g1__action`, `g2__threat`…),
   and send **one** request. Jev answers them all in a single pass.
3. Route answers back to each agent's `apply()`.
4. Tick rate adapts to about 3× the rolling p95 latency (clamped to 0.5–3 s). Only one
   request is in flight at a time, so stale state never piles up.

**The model chooses; the engine executes.** Jev picks *what* to do. Steering,
line-of-sight, hit rolls, and a close-range "reflex" shot run locally every frame.
Calibrated confidence adds hysteresis: a guard won't switch actions on a <30% coin flip.

**Mock mode.** Each question builder takes an optional heuristic stored under a
Symbol, so it never gets serialized. With no key, or when a live call fails, the client
produces answers in the exact same shape. The game always runs, and it switches to
real Jev without code changes.

## Adding a Jev brain to your own entity

```js
import { Choice, Score, Noul } from "./engine/Jev.js";

entity.brain = {
  id: "shopkeeper",
  questions: (state) => ({
    mood:  Choice("How should the shopkeeper greet the player?",
                  { friendly: "...", wary: "...", hostile: "..." }),
    price: Score("How much should they mark up prices?", ["none", "small", "large"]),
    call_guards: Noul("The shopkeeper should call the guards now."),
  }),
  apply: (a) => { entity.mood = a.mood.choice; entity.markup = a.price.score; },
};
engine.add(entity); // JevBrainSystem picks it up automatically
```
