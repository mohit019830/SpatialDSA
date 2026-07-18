# Spatial DSA Visualizer

> Air-gesture algorithm lab — spawn, connect, and step through classic data-structure
> algorithms in a 3D space using nothing but your hand and your voice.

Spatial DSA Visualizer turns your webcam into a spatial input device. You pinch in
mid-air to spawn nodes, drag them into place, connect them into linked lists / trees /
graphs, then watch a real C++ implementation execute line-by-line while the 3D scene
lights up to match. No build step, no framework — just static files and CDN scripts.

---

## Table of Contents

- [Demo Flow (TL;DR)](#demo-flow-tldr)
- [Requirements](#requirements)
- [Running the Project](#running-the-project)
- [The Interface](#the-interface)
- [Hand Gestures](#hand-gestures)
- [Voice Commands](#voice-commands)
- [Manual Controls](#manual-controls)
- [Algorithms & C++ Traces](#algorithms--c-traces)
- [Node & Edge Color States](#node--edge-color-states)
- [Architecture](#architecture)
- [Module & Function Reference](#module--function-reference)
- [Performance Design](#performance-design)
- [Configuration Knobs](#configuration-knobs)
- [Troubleshooting](#troubleshooting)
- [Browser Support](#browser-support)
- [Project Layout](#project-layout)

---

## Demo Flow (TL;DR)

1. Open the page and grant **camera** (and optionally **microphone**) permission.
2. Click **Enter Lab**. A demo structure is seeded automatically if the scene is empty.
3. **Pinch** your thumb and index finger together in empty space to spawn a node; keep
   pinching and move your hand to drag it.
4. Pinch **on** a node and release near **another** node to draw a directed edge.
5. Pick an algorithm tab (Linked List, BST, DFS, Dijkstra…).
6. Say **"execute"** or click **Execute ▶** to build and auto-play the trace.
7. **Swipe** left/right — or say **"next"/"back"** — to step through it manually.

---

## Requirements

- A modern Chromium-based browser (Chrome / Edge / Brave) or recent Firefox.
- A **webcam** for hand tracking (the lab still runs with manual controls if absent).
- A **microphone** for voice commands (optional — powered by the Web Speech API).
- **Internet access on first load** — Three.js, the MediaPipe Tasks-Vision WASM bundle,
  and the hand-landmark model are pulled from CDNs.
- Must be served over **`http://localhost` or `https://`**. `getUserMedia` (camera) and
  the Web Speech API refuse to run from a `file://` URL.

---

## Running the Project

There is no build system. Serve the folder with any static file server:

```bash
# Python 3
python3 -m http.server 8000

# Node (if you have it)
npx serve .

# PHP
php -S localhost:8000
```

Then open <http://localhost:8000>. Grant camera/mic permission when prompted.

> **Why not just double-click `index.html`?** Browsers block camera and speech access on
> the `file://` scheme. You must go through `localhost` or HTTPS.

---

## The Interface

The screen is split into a left **Control Hub** (~30%) and a right **3D Universe** (~70%).

**Left panel**

| Card | What it shows |
| --- | --- |
| **Vision Feed** | Live webcam with the MediaPipe hand skeleton overlay + a status pill (`offline` / `loading` / `ready` / `error`). |
| **Voice Command** | An orb that pulses while listening, plus the current transcript/intent. Toggle with the `enable`/`disable` button. |
| **C++ Trace** | The source listing for the active algorithm; the current execution line is highlighted and auto-scrolls into view. Tabs switch algorithms. |
| **Controls** | Manual buttons + a seed-value input for keyboard/mouse fallback. |

**Right panel (HUD overlays on the 3D canvas)**

- **Top-left chips** — `MODE · <state>` (IDLE / SPAWN / GRAB / LINK) and `PINCH · yes/no`.
- **Top-right legend** — the meaning of each node color.
- **Bottom** — a running description of what the algorithm is doing this step.
- **Top bar badges** — `FPS`, `STEP x/y`, and the active algorithm name.

---

## Hand Gestures

Hand tracking uses one hand (up to 21 landmarks). The view is **mirrored** (selfie-style),
so on-screen motion matches your real motion.

| Gesture | How to perform it | What it does | HUD mode |
| --- | --- | --- | --- |
| **Pinch** | Bring **thumb tip** and **index-finger tip** together. | The core "click/grab". Debounced with hysteresis so it doesn't flicker. | — |
| **Pinch in empty space** | Pinch where there's no node, then move your hand while holding. | **Spawns** a new node and drags it under your finger until you release. | `SPAWN` |
| **Pinch-hold on a node** | Pinch directly on an existing node and move. | **Grabs and drags** that node; any connected edges follow in real time. | `GRAB` |
| **Pinch A → release near B** | Pinch a node, drag toward a *different* node, release within the connect radius. | Draws a **directed edge** A → B. The source node snaps back to its origin. | `LINK` |
| **Swipe left** | Move your open hand quickly left. | **Step backward** through the algorithm trace. | — |
| **Swipe right** | Move your open hand quickly right. | **Step forward** through the algorithm trace. | — |

Detail on the tunables behind each gesture:

- **Pinch** uses a 3D Euclidean distance between thumb tip and index tip with
  **split-threshold hysteresis**: it *starts* only below `0.025` (a deliberate, tight
  pinch) but is *maintained* until the fingers drift past `0.055`. The wide "maintain"
  band is what keeps a node-drag or edge-draw alive through mid-gesture jitter.
- **Connect (target snapping)**: on release, the edge snaps to the raycast-hovered node,
  or failing that to the closest node within **2.0 world units**. Only if nothing is in
  range is the edge discarded.
- **Ghost-node guards**: a new node is *never* spawned within **1.5 world units** of an
  existing node, nor within **350 ms** of any pinch release — the two conditions that
  previously produced stray "ghost" nodes.
- **Swipe** uses an 8-frame **velocity ring buffer** on the index fingertip. It fires the
  instant horizontal velocity exceeds `0.0012` (norm-x per ms) over at least a `0.10`
  travel (~10 cm flick) while vertical variance stays under `0.10`, with a **450 ms
  cooldown**. A sharp short flick triggers immediately — no big sweep required.

The mid-air cursor is a glowing ring + core reticle. It turns **green** when hovering a
grabbable node and **cyan** otherwise.

---

## Voice Commands

Click **enable** on the Voice Command card, then speak. Matching is a strict
whole-word intent map (case-insensitive), so natural synonyms work:

| Say any of… | Intent | Action |
| --- | --- | --- |
| "execute", "run algorithm", "run", "go" | `EXECUTE` | Build the trace and auto-play it (~0.9 s/step). |
| "forward", "next", "step", "advance" | `FORWARD` | Advance one step (stops auto-play first). |
| "back", "previous", "undo", "reverse" | `BACK` | Go back one step (stops auto-play first). |
| "clear", "reset", "wipe" | `CLEAR` | Empty the universe and return to idle. |

Voice is entirely optional — if the browser lacks the Web Speech API, the lab logs a
warning and everything else keeps working.

---

## Manual Controls

Every gesture/voice action has a button fallback (also the accessible path):

| Control | Action |
| --- | --- |
| **Build Trace** | Precompute the step history for the active algorithm from the current scene. |
| **Execute ▶** | Build + auto-play the trace from the start. |
| **◀ Back** / **Next ▶** | Single-step through the trace. |
| **Reset** | Clear all nodes/edges and stop playback. |
| **value** (number input) | The value used for the next spawned node. Leave empty to auto-increment. |
| **+ Node** | Spawn a node on a loose spiral (so manual nodes don't stack). |
| **Demo Data** | Seed a structure appropriate to the active algorithm. |
| **Algorithm tabs** | Switch which C++ listing / trace builder is active. |

---

## Algorithms & C++ Traces

Each algorithm is expressed as an **explicit step generator**, not native recursion.
Every step stores a deep-cloned snapshot of the whole scene plus the highlighted source
line, so stepping backward is a lossless restore — you can scrub the timeline freely.

| Tab | Key | What it traces |
| --- | --- | --- |
| **Linked List** | `linkedListReversal` | Iterative in-place reversal (`prev`/`curr`/`next` pointer dance). |
| **BST Insert** | `bstInsert` | Inserts every scene value into a binary search tree, computing real tree layout coordinates. |
| **BST Delete** | `bstDelete` | Deletion with the three classic cases, including in-order successor replacement. |
| **DFS** | `dfs` | Iterative depth-first search over a weighted graph using an explicit stack. |
| **Dijkstra** | `dijkstra` | Shortest paths from a source using a priority-queue relaxation. |

The **Demo Data** button seeds an appropriate shape per algorithm: a 4-node chain with
`next` pointers for linked lists, a scatter of `[50,30,70,20,40,60,80]` for BSTs, and a
small 5-vertex weighted digraph for graph algorithms.

---

## Node & Edge Color States

The engine tags each node/edge with a semantic `state` string; `render3d.js` maps it to a
neon color. This keeps the logic layer presentation-agnostic.

| State | Meaning | Node color | Edge color |
| --- | --- | --- | --- |
| `default` | Resting element | muted cyan | teal |
| `added` | Just added to a structure | green | green |
| `active` | Current focus | neon cyan | neon cyan |
| `compare` | Being compared | amber | amber |
| `visited` | Visited / on path build | neon purple | neon purple |
| `path` | On the final path | neon purple | neon purple |
| `removed` | About to be removed | red (shrinks out) | red |

---

## Architecture

Five independent layers, wired together by `app.js` (the conductor). Each layer knows
nothing about the others' internals — they communicate through normalized event objects.

```
  vision.js  ──(normalized hand events)──►  interaction state machine (app.js)
  speech.js  ──(macro intents)──────────►  step / execute / clear
  dsaEngine  ──(onChange model)─────────►  render3d.setModel + code panel
  render3d   ──(raycast hover/worldPt)──►  spawn / drag / connect decisions
```

Load order matters and is fixed in `index.html`: **Three.js → dsaEngine → render3d →
vision → speech → app**.

**The shared model contract** (single source of truth, produced by `dsaEngine`):

```js
model = {
  nodes: [{ uuid, value, position: { x, y, z }, state }],
  edges: [{ uuid, from, to, directed, state }],
}
```

**The normalized vision event** (produced by `vision.js`, consumed by `app.js`):

```js
{
  present,                       // is a hand visible this frame
  cursor: { x, y } | null,       // index tip, 0..1, already mirrored
  pinch,                         // debounced pinch state
  pinchStart, pinchEnd,          // one-frame edge events (real frames only)
  swipe: 'SWIPE_LEFT' | 'SWIPE_RIGHT' | null,
  landmarks: Array | null,       // raw 21 landmarks (mirrored x)
  fps,
  interpolated,                  // true on extrapolated (non-detection) frames
}
```

---

## Module & Function Reference

### `dsaEngine.js` — algorithmic logic & memory state machine

Exposed as `window.DSA = { DSAEngine, LinkedListNode, BSTNode, Graph, CPP_SOURCES,
generateUUID, deepClone }`.

**Utilities**
- `generateUUID()` — RFC4122-ish v4 UUID (uses `crypto.randomUUID` when available).
- `deepClone(obj)` — structured clone with a JSON round-trip fallback.

**Data-structure classes**
- `LinkedListNode(value)` — `{ value, next, uuid }`.
- `BSTNode(value)` — `{ value, left, right, parent, uuid, x, y, z }`.
- `Graph()` — adjacency-list graph: `addVertex(id)`, `addEdge(from, to, weight, edgeId)`,
  `neighbors(id)`.

**`DSAEngine`** — the heart of the logic layer:

| Method | Purpose |
| --- | --- |
| `onChange(fn)` | Subscribe to model changes; returns an unsubscribe function. |
| `getPresentedState()` | The state the UI should render right now (live model or the current trace step). |
| `addNode(value, position)` | Insert a free-standing node; returns it. |
| `moveNode(uuid, position)` | Move a node (live drag) — does **not** reset the trace. |
| `addEdge(from, to, {directed, weight})` | Connect two nodes; rejects self-loops and duplicates. |
| `removeNode(uuid)` | Remove a node and any edges touching it. |
| `clear()` | Reset to an empty universe. |
| `setActiveAlgorithm(key)` | Switch the active algorithm listing. |
| `getSource(key?)` | Get the C++ source lines for an algorithm. |
| `buildTrace()` | Build the step history for the active algorithm; returns step count. |
| `stepForward()` / `stepBackward()` | Move through the trace (lossless). |
| `jumpToStart()` / `jumpToEnd()` | Jump within the trace. |

`CPP_SOURCES` holds the C++ listing (array of lines) for each algorithm; trace steps
reference lines by index so exactly one line highlights at a time.

### `render3d.js` — Three.js spatial graphics layer

Exposed as `window.Render3D = { Renderer3D, STATE_COLORS }`. Knows nothing about hands,
speech, or algorithms — it receives a model + a cursor position and draws them.

**`Renderer3D(canvas)`**

| Method | Purpose |
| --- | --- |
| `start()` / `stop()` | Run/halt the animation loop. |
| `setModel(model)` | Reconcile the flat engine model into the 3D scene (uuid-diffed, not rebuilt). |
| `updateCursor(nx, ny, visible, pinch)` | Move the mid-air reticle and (gated) raycast for hover. Returns `{ hovered, worldPoint }`. |
| `worldToScreen(vec3)` | Project a world position back to normalized 0..1 screen coords. |
| `resize()` | Match renderer + camera to the canvas size. |
| `dispose()` | Tear down and free GPU resources. |

Nodes render as low-poly emissive spheres with a value label sprite and an additive glow
shell; edges are glowing cylinders with cone arrowheads for directed pointers.

### `vision.js` — MediaPipe computer-vision layer

Exposed as `window.Vision = { VisionEngine }`. Owns the webcam + the MediaPipe
HandLandmarker and emits the normalized event described above.

**`VisionEngine({ video, overlay, onFrame, onStatus })`**
- `init()` — load the WASM bundle + hand model, then open the camera.
- `start()` / `stop()` — begin/end the detection loop (and stop camera tracks).

Internally it debounces pinch, recognizes swipes over a ring buffer, draws the skeleton
overlay, and — for performance — runs the model on a throttled cadence while
extrapolating the fingertip on the frames in between (see [Performance Design](#performance-design)).

### `speech.js` — voice command layer

Exposed as `window.Speech = { SpeechEngine, INTENT_RULES }`. Wraps the Web Speech API and
matches transcripts against a strict, ordered intent map.

**`SpeechEngine({ onCommand, onStatus })`**
- `start()` / `stop()` / `toggle()` — control recognition; `toggle()` returns the new
  on/off state.
- Emits `{ intent, transcript, confidence }` through `onCommand`.

### `app.js` — system orchestration & interaction mapping

The conductor. Owns no algorithms and draws no triangles. It:
- builds the interaction **state machine** (`onPinchStart` / `onPinchMove` / `onPinchEnd`,
  `nearestOtherNode`),
- maps vision events (`handleVisionFrame`) and voice intents (`handleVoiceCommand`) onto
  engine calls,
- renders the C++ trace panel with a lightweight tokenizer (`highlightCpp`, `renderCode`),
- wires the manual controls and algorithm tabs (`wireControls`), seeds demo data
  (`seedDemoData`), and runs the `boot()` sequence.

---

## Performance Design

The lab pushes a webcam, a neural hand model, a speech recognizer, and a WebGL scene at
once. Several deliberate choices keep it at interactive frame rates:

- **Throttled inference.** The MediaPipe model — by far the most expensive main-thread
  work — runs only once every **3** animation frames (~20 Hz on a 60 Hz display). On the
  skipped frames the fingertip is **extrapolated** from its last measured velocity
  (clamped), so the cursor keeps gliding smoothly instead of stalling. Pinch/swipe *edge*
  events fire only on real detection frames.
- **Capped camera.** The webcam is hard-limited to **640×480 @ 30 fps** so the browser
  never negotiates an expensive HD stream.
- **Shared GPU assets.** All node/edge geometry and materials are created **once** as
  singletons and reused; state changes swap a material *reference* rather than allocating.
  Spheres are low-poly and antialiasing is off — big cheap fill-rate wins.
- **Gated raycasting.** The expensive hover raycast only runs when the cursor actually
  moved past a small delta *and* the user is pinching (plus once on pinch-down), with an
  AABB broad-phase that rejects far-away nodes before any triangle test.
- **Decoupled UI.** Engine changes are coalesced into a single `requestAnimationFrame`
  flush; the costly C++ code-panel rebuild only happens when the highlighted line or
  algorithm changes — pure position updates during a drag skip it entirely.
- **Off-frame trace building.** `buildTrace()` (which deep-clones per step) is deferred to
  a macrotask so it never blocks a render frame.

---

## Configuration Knobs

Most tuning lives as named constants near the top of each file:

| Constant | File | Default | Effect |
| --- | --- | --- | --- |
| `PINCH_START` / `PINCH_RELEASE` | `vision.js` | `0.025` / `0.055` | Split-threshold pinch hysteresis (start tight, maintain/release wide). |
| `SWIPE_BUFFER` | `vision.js` | `8` | Fingertip X/Y samples in the velocity ring buffer. |
| `SWIPE_VELOCITY` | `vision.js` | `0.0012` | Horizontal flick velocity (norm-x per ms) that triggers a swipe. |
| `SWIPE_MIN_DX` / `SWIPE_MAX_DY` | `vision.js` | `0.10` / `0.10` | Min horizontal travel / max vertical variance. |
| `SWIPE_COOLDOWN_MS` | `vision.js` | `450` | Minimum gap between swipes. |
| `DETECT_EVERY` | `vision.js` | `3` | Run inference every N frames. |
| `NODE_RADIUS` | `render3d.js` | `1.15` | Node sphere size (world units). |
| `LERP` | `render3d.js` | `0.18` | Position/scale easing per frame. |
| `RAYCAST_DELTA` | `render3d.js` | `0.01` | Cursor-move gate before re-raycasting. |
| `CONNECT_RADIUS` | `app.js` | `2.0` | Edge-target snap radius on release. |
| `SPAWN_MIN_GAP` | `app.js` | `1.5` | No new node spawns within this of an existing node. |
| `SPAWN_COOLDOWN_MS` | `app.js` | `350` | Post-release window during which spawns are banned. |

---

## Troubleshooting

- **"Camera unavailable" / no hand tracking** — you're likely on `file://`. Serve over
  `localhost`. Also check the browser's camera permission for the site.
- **Vision status stuck on `loading` / `error`** — the MediaPipe WASM bundle or model
  couldn't be fetched. Confirm internet access and that CDN domains aren't blocked.
- **"3D engine failed to load" / "WebGL unavailable"** — Three.js didn't load or WebGL is
  disabled. Check network access and enable hardware acceleration.
- **Voice does nothing** — the Web Speech API isn't available (common in Firefox) or the
  mic permission was denied. Everything else still works.
- **Choppy frame rate on a low-end machine** — raise `DETECT_EVERY` in `vision.js`
  (e.g. `4`) to run the hand model less often.

---

## Browser Support

- **Best:** latest Chrome / Edge / Brave (full camera + Web Speech support).
- **Good:** recent Firefox (camera works; voice may be unavailable).
- Requires **WebGL** and **`getUserMedia`**; voice additionally requires the
  **Web Speech API**.

---

## Project Layout

```
spatial-dsa-visualizer/
├── index.html      # Layout, CDN <script> tags, load order
├── style.css       # Neon/glass UI styling
├── dsaEngine.js    # Algorithms, model, step-history state machine
├── render3d.js     # Three.js scene, meshes, cursor, raycasting
├── vision.js       # Webcam + MediaPipe hand tracking, gesture recognition
├── speech.js       # Web Speech API voice-command layer
└── app.js          # Orchestrator: wires vision/speech/engine/renderer together
```

External dependencies are loaded from CDNs at runtime (no `node_modules`):
- **Three.js** `0.160.0`
- **@mediapipe/tasks-vision** `0.10.14` (WASM bundle + hand-landmark model)
