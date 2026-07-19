# Feature Upgrade Plan — Spatial DSA Visualizer

Delivery: **phased & verifiable**. Four independent subsystems, one at a time, each
fully written + `node --check` clean before moving on. You test each in the browser
before I start the next. Order below is by dependency/risk (lowest-risk foundations first).

Architecture constraint honored throughout: vanilla ES6+ IIFE modules, native
HTML5/CSS3, Three.js via existing CDN, **zero build tools**. New subsystems fold into
the existing `dsaEngine.js` / `render3d.js` / `app.js` / `index.html` / `style.css`.

Confirmed integration points from exploration:
- Engine model: `{nodes:[{uuid,value,position,state}], edges:[{uuid,from,to,directed,weight,state}]}`;
  observer via `onChange`/`_emit`; deep-clone trace history via `_record`.
- Renderer: `this.field` group holds nodes/edges/grid; `_frame` rAF loop with lerp;
  SHARED asset cache; `setModel` uuid-diff; existing `_linkLine` + `beginLink/updateLink/endLink`.
- app.js: IIFE, `els` DOM map, `engine.onChange`→rAF `flushUI`→`renderer.setModel`,
  gesture state machine, `#algoTabs` tab switching.
- Exports: `window.DSA`, `window.Render3D`.

---

## PHASE 1 — Mouse Fallback "Draw & Shoot" Laser (app.js + render3d.js)

Reuses the `_linkLine` infrastructure I already built for the vision linking pose, so
the mouse path and gesture path converge on the same renderer primitives.

**render3d.js**
- Add `screenToWorldRay(clientX, clientY)` helper → sets raycaster from pixel coords
  (canvas-relative NDC), returns `{ worldPoint (field-local), hovered }` reusing `_hoverTest`.
- Add `magnetTarget(fromUuid, tipLocalPoint)`: scan all other node meshes, return the
  uuid whose field-local center is within `MAGNET_RADIUS = 2.0` of the tip (nearest wins),
  else null. Rotation-safe (works in field-local space, consistent with the tip).
- Reuse `beginLink/updateLink/endLink`. Add `snapLinkTo(uuid)` that pins the free vertex
  exactly to a node center and swaps the line material to a "locked" green glow.

**app.js**
- New `wireMouse()` bound to `#scene`:
  - `mousedown`: raycast; if over a node, `beginLink(uuid)`, set `mouse.active`, `mouse.from`.
  - `mousemove` (only while `mouse.active`): raycast tip; call `magnetTarget`; if snapped,
    `snapLinkTo(B)` + remember `mouse.snapTo=B`; else `updateLink(freePoint)`, clear snap.
  - `mouseup`: if `mouse.snapTo` → `engine.addEdge(from, snapTo,{directed:true})`; else
    `endLink()` (destroy). Reset mouse state.
- Guard: mouse path is inert while a vision pinch/link/zoom gesture owns the frame
  (check `gesture.mode`), so the two input methods never fight.
- HUD: reflect `MODE · LASER` while dragging.

Verify: `node --check` all touched files; manual note on how to test (click-drag node→node).

---

## PHASE 2 — Text-Based Auto-Layout Engine (dsaEngine.js + index.html + app.js)

**index.html** — new left-panel card `structure-card` with:
- `<textarea id="structInput">`, a format select (`#structFormat`: Tree Array / Edge List),
  and `#btnParseStruct` "Build Layout".

**dsaEngine.js** — pure parsers + layout, all producing standard `{nodes,edges}` then
routed through existing `addNode`/`addEdge` (so trace/emit/render all just work):
- `parseTreeArray(str)`: parse `[3,9,20,null,null,15,7]` (LeetCode level-order). Skip
  nulls; child index = `2i+1 / 2i+2`; assign coords `x = (col - center)*X_SPACING`,
  `y = -depth*Y_SPACING`, `z=0`. Connect parent→child directed edges.
- `parseEdgeList(str)`: parse `[[0,1],[1,2],[2,0]]` (and simple adjacency). Dedup vertices,
  create nodes, then run `_forceLayout`.
- `_forceLayout(nodes, edges, iters=120)`: lightweight Fruchterman-Reingold — repulsion
  (inverse-square) + spring attraction along edges + mild centering; runs synchronously
  in a bounded loop (non-blocking: ≤120 iters on small graphs), writes final positions.
  For 3D symmetry, seed on a sphere and let forces spread on X/Y (Z kept shallow for readability).
- Public `loadFromText(format, text)` → clears model, builds, emits. Returns
  `{ok, error}` for UI feedback.

**app.js** — `wireStructureInput()`: on click, call `engine.loadFromText(...)`, show
parse errors inline, auto-`setActiveAlgorithm` heuristically (tree→bst, edges→dfs).

Verify: `node --check`; parser unit sanity via a tiny Node harness (I can run parsers
headless since they're pure — no THREE dependency).

---

## PHASE 3 — 3B1B Linear Algebra Grid Transformer (render3d.js + index.html + app.js)

Biggest renderer addition. Isolated in its own scene subgraph so it never interferes
with DSA mode.

**render3d.js**
- New `this.laGroup` (hidden by default) containing:
  - Coordinate grid: `LineSegments` with a BufferGeometry of unit-interval lines across
    a bounded 3D lattice (e.g. −5..5 on X/Y, lighter Z planes). Keep the **base (identity)
    vertex positions** in a `Float32Array` so every frame we recompute displayed = M·base.
  - Three basis-vector arrows via `THREE.ArrowHelper`: î cyan (1,0,0), ĵ magenta (0,1,0),
    k̂ lime (0,0,1).
- `enterLinearMode()` / `exitLinearMode()`: toggle `field.visible` vs `laGroup.visible`,
  reset camera to a clean ¾ view.
- `applyMatrix(m3)`: store `targetMatrix`, capture `startMatrix = currentMatrix`, set
  `animT=0`. The `_frame` loop lerps `animT` 0→1 over `LA_DURATION=2000ms`, computes an
  interpolated matrix `M(t)` (component-wise lerp from identity/current → target, smoothstep
  eased), then rewrites grid vertices (displayed = M(t)·base) and re-orients/scales the
  three arrows. This shows continuous shear/stretch/rotation — the 3B1B warp.
- Performance: single BufferGeometry, `position.needsUpdate=true` once per frame, no
  per-line objects; reuse a scratch `THREE.Vector3`/`Matrix3`.

**index.html** — top-level mode tabs (DSA | Linear Transformations) and a 3×3 matrix
form (`#laMatrix` with 9 number inputs), `#btnApplyMatrix`, plus preset buttons
(Rotate 90°, Shear, Scale, Identity/Reset).

**app.js** — `wireLinearAlgebra()`: mode-tab switch calls enter/exit; read the 9 inputs
into a column-major array; `renderer.applyMatrix(...)`; presets fill the form + apply.
While in LA mode, DSA gestures/mouse laser are suspended.

Verify: `node --check`; matrix math (identity, known rotation) checkable headless.

---

## PHASE 4 — Recursion Visualizer: Call Graph vs 3D Stack Tower (dsaEngine.js + render3d.js + app.js)

Goal: handle standard mathematical + array recursion flawlessly (not just graph DFS).
Tree View mimics recursionvisualizer.com UX; Stack View is a faithful 3D model of a
call stack. Two coordinated views of the SAME call state, driven step-by-step and fully
reversible.

### 4.0 Reconciliation (a first-pass implementation already exists)
Earlier this session Phase 4 was implemented at a basic level (fib/mergeSort/dfsRecursive,
snapshot-driven tree + flat-slab stack, wired, `node --check` clean). This revised spec
supersedes it. Carried over: snapshot-per-step model, pooled meshes, camera-anchored
tower, mode toggle. Reworked: `emit*` authoring API, `locals`+`returnValue` in the frame,
directed edges, return-bubble animation, glass-morphic multi-line blocks, push/pop slide
+ flash animations, depth-aware camera fit. `dfsRecursive` demoted to a bonus example;
`fibonacci` + `mergeSort` are the first-class, fully-instrumented algorithms.

### 4.1 Engine — instrumented algorithms + emit* API (dsaEngine.js)
Three genuinely recursive algorithms as instrumented state machines:
- `fibonacci(n)` — exponential call tree (primary tree-view demo).
- `mergeSort(arr)` — divide & conquer; args + array-slice locals (primary stack demo).
- `dfsRecursive(start)` — kept as a bonus graph example.

**Authoring API (the algorithm calls these; they are thin wrappers):**
- `emitCallEnter(label, args, locals)` — allocate a frame id, parent = current stack top,
  push onto the live call-node list + live stack, then snapshot.
- `emitLineHighlight(line, localsPatch?)` — patch the current frame's locals if given,
  then snapshot at that source line.
- `emitCallReturn(returnValue)` — set current frame `result`+`status:'returned'`, pop the
  live stack, then snapshot carrying `returnValue`.

**Recorded artifact = full snapshot, NOT an event delta.** Each emit* deep-copies the
whole call-node list + live stack into `frame` and calls `_record`. Rationale: reverse
stepping is a jump to snapshot N−1 (instant, lossless) — no inverse-event replay, which
would be fragile given MergeSort's in-place mutation. This is what makes "perfect reverse
order" cheap and correct. `emit*` naming gives clean instrumentation; snapshots give
reversibility. (Additive: non-recursive algorithms emit no frame; `frame` stays null.)

New CPP_SOURCES listings + algorithm tabs for the three.

### 4.2 Frame schema (per recorded step)
```
frame = {
  event:       'callEnter' | 'line' | 'return',
  activeId,                       // frame this step acts on
  returnValue,                    // meaningful only on 'return'
  nodes: [ { id, parentId, depth, label, args, locals[], status, result } ],
  stack: [ { id, label, args, locals[], depth } ],   // bottom -> top
}
```
`locals` is an ordered `[{name, value}]` list so the stack block face renders faithfully.

### 4.3 Tree "Call Graph" View (recursionvisualizer.com style) (render3d.js)
- `_callGraphGroup` inside `field` (inherits pinch-rotate / zoom).
- Node = one function execution instance; face text shows fn + params, e.g. `fib(4)`.
- Stepping forward spawns child nodes downward (`x` by sibling order, `y=-depth*spacing`)
  connected by **directed edges** (add an arrowhead — parent→child).
- **Return Bubble:** on `emitCallReturn`, flip the returning node to a resolved neon-green
  state, then animate the `returnValue` as a text sprite traveling *up* the edge to the
  parent. Reverse step plays it traveling back *down* and reverts the node color.
- Depth-aware fit: each render, measure the tree extents and lerp camera distance / group
  scale so the whole graph stays framed.

### 4.4 3D Stack Frame Tower (render3d.js)
- Physical tower of `BoxGeometry` blocks with a **glass-morphic** material (high
  transmission / low opacity, subtle emissive rim). Screen-anchored (child of camera).
- `emitCallEnter` → push a block on top; multi-line canvas-texture face shows function
  name, arguments passed in, and local variables (the "OS stack frame" — a faithful
  teaching abstraction: signature + args + locals + return slot; NOT literal ABI layout,
  registers, or padding).
- `emitCallReturn` → flash the top block (return value generated), then slide it off the
  tower and recycle it (pop). "Destroy" = animate-off + return to pool, never dispose
  (keeps the frame loop allocation-free and undo cheap).
- Deep recursion: seamlessly lerp tower scale down and/or translate the camera so the top
  of the stack stays in view.

### 4.5 Reversibility & animation policy
- Authoritative state per step = the snapshot; applied instantly on any nav.
- Animations are **transient flourishes** derived from the diff between adjacent snapshots
  + step direction (`sign(newIndex-oldIndex)`): forward-over-return = bubble-up +
  slide-off; backward-over-return = bubble-down + slide-on; forward-over-callEnter =
  child spawn + block push; backward = child un-spawn + block un-push.
- Interrupt policy: a new step arriving mid-flourish snaps the previous to its end state.
- Swiping backward pops nodes off the call graph and pushes recycled blocks back onto the
  tower in exact reverse order — a direct consequence of replaying snapshot N−1.

### 4.6 app.js wiring
- Recursion-mode toggle (Call Graph / Stack Tower); auto-enter when a recursive algo tab
  is selected, exit otherwise; linear-algebra mode takes precedence.
- Feed `state.frame` to the renderer each flush; renderer diffs against its stored last
  frame to derive event + direction for the right flourish.

### 4.7 Verify
`node --check` on all touched files. Headless: step through Fibonacci(5) and assert
call/return counts (15 activation nodes, 15 returns, root result 5), MergeSort produces a
sorted root result, and every recorded `frame` is a self-contained snapshot whose
`activeId` resolves within `nodes`. Browser review for the animations (bubble travel,
glass blocks, slide/flash, depth fit) — I cannot run WebGL headless.

---

## Cross-cutting notes
- Each phase ends with: all touched files `node --check` clean, a short "how to test in
  browser" note, and I pause for your review before the next phase.
- No secrets, no network calls, no new dependencies. Pure CDN + local files.
- I cannot run the WebGL/MediaPipe pipeline headless, so visual correctness (the actual
  warp, the laser glow, tower animation) needs your eyes in the browser — I'll call out
  exactly what to look for each phase.

Starting point on approval: **Phase 1 (Mouse Laser)**.
