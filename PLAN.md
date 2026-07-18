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

## PHASE 4 — Recursion Visualizer: Tree vs Stack (dsaEngine.js + render3d.js + app.js)

**dsaEngine.js** — add three genuinely recursive, instrumented algorithms that emit
**call-frame events** into a parallel `callTrace` recorded alongside the model snapshot:
- `fibonacci(n)`, `mergeSort(arr)`, and a recursive `dfsRecursive(start)`.
- Each `_record` step also carries `frame:{event:'call'|'return', id, parentId, label,
  locals, depth}`. This is additive — existing algorithms simply emit no `frame`.
- New CPP_SOURCES listings + tabs for the three.

**render3d.js** — two visual modes, switchable:
- **Tree Layout**: `_callGraphGroup`; each `call` spawns a temp activation node branching
  downward (`x` by sibling order, `y = -depth*spacing`), lights the parent→child line in
  a descend color; `return` dims/backtracks it.
- **Stack Frame Tower**: `_stackTowerGroup` fixed to the side (screen-anchored via a
  separate ortho-ish placement in world space); `call` pushes a translucent labeled block
  on top, `return` pops with a fade. Reuse a small pool of block meshes.
- Driven by replaying the current step's `frame` events as the trace steps forward/back.

**app.js** — recursion-mode toggle (Tree / Stack), wire the new algorithm tabs, feed
`state.frame` to the renderer each flush.

Verify: `node --check`; step through Fibonacci(5) and confirm call/return counts.

---

## Cross-cutting notes
- Each phase ends with: all touched files `node --check` clean, a short "how to test in
  browser" note, and I pause for your review before the next phase.
- No secrets, no network calls, no new dependencies. Pure CDN + local files.
- I cannot run the WebGL/MediaPipe pipeline headless, so visual correctness (the actual
  warp, the laser glow, tower animation) needs your eyes in the browser — I'll call out
  exactly what to look for each phase.

Starting point on approval: **Phase 1 (Mouse Laser)**.
