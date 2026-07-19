# Custom C++ Sandbox — Implementation Plan

## Goal
A "Custom C++" card with a CodeMirror 6 editor + "Run C++" button + terminal. Runs the
user's C++ through JSCPP **in a Web Worker**, intercepts `cout` output, routes `@VIS:` lines
into the engine as trace snapshots, and reuses the existing playback machine so the user can
swipe forward/backward through their own program's execution. Graph nodes and the call stack
can appear together in one run.

## Key findings from exploration
- `dsaEngine._record()` already deep-clones BOTH `model` (nodes/edges) and the call `frame` per
  step — so DS + stack coexist in each snapshot with no new format needed.
- The renderer hides the DS layer in recursion mode (`render3d.js:1489-1491`). The stack tower is
  camera-parented HUD (`render3d.js:1253`), so it can overlay the graph. Need a sandbox mode that
  shows the stack overlay WITHOUT hiding nodes/edges/grid.
- Playback (`execute`/`stepForward`/`stepBackward`/`jumpToStart`) scrubs `algorithmHistory`
  generically → reused as-is once the sandbox fills that array.
- App modules are classic-script IIFEs exposing `window.X`; optional engines (Speech, Vision) are
  constructed in `boot()` with callbacks. Sandbox follows that exact pattern.

## CDN dependencies (confirmed API surface)
- **JSCPP** (UMD global `JSCPP`): `https://cdn.jsdelivr.net/npm/JSCPP/dist/JSCPP.es5.min.js`
  - `JSCPP.run(code, input, config)`; `config.stdio.write=(s)=>...`; `config.maxTimeout=<ms>`.
  - Loaded via `importScripts()` INSIDE the worker (not the main page).
- **CodeMirror 6** (ESM-only, no UMD): loaded via `<script type="importmap">` + a
  `<script type="module">` bootstrap that builds the editor and assigns `window.__cmEditor`.
  Packages: `codemirror` (basicSetup, EditorView), `@codemirror/lang-cpp`, `@codemirror/state`.
  - **Resilience:** if the module import fails (CDN/network), fall back to a styled `<textarea>`
    so "Run C++" still works. sandbox.js reads text via a `getCode()` shim that works with either.

## Safety
- JSCPP runs in an **inline Blob Worker** (no extra file — keeps CDN-only architecture). A hung
  loop can never freeze the UI. Main thread also arms a hard `terminate()` timeout as a backstop
  to `maxTimeout` (which only fires between operations).
- New network endpoint? No — worker only fetches the pinned JSCPP CDN script. Noted for the user.

## The `@VIS:` protocol (parsed on the main thread from captured stdout)
```
@VIS:NODE:<id>:<value>     -> engine.sandboxNode(value)  ; sandbox maps <id> -> returned uuid
@VIS:EDGE:<idA>:<idB>      -> engine.sandboxEdge(uuidA, uuidB)   (ids resolved via the map)
@VIS:CALL:<funcName>:<args>-> engine.sandboxCall(funcName, args) (stack/tree push)
@VIS:RET:<value>           -> engine.sandboxReturn(value)        (stack/tree pop)
@VIS:LINE:<lineNumber>     -> engine.sandboxLine(lineNumber-1)   (highlight active line)
```
Lines NOT starting with `@VIS:` are printed verbatim to the terminal. Malformed `@VIS` lines are
shown as a dim warning in the terminal and skipped (never throw).

## Files & changes

### 1. index.html
- Add `<script type="importmap">` mapping `codemirror`, `@codemirror/lang-cpp`,
  `@codemirror/state`, `@codemirror/view` to jsdelivr `/+esm`.
- Add JSCPP `<script>` tag (classic; also imported inside the worker).
- New **Custom C++ card** in the left panel (after the recursion card): editor mount
  `#cmEditor`, `#btnRunCpp`, `#btnStopCpp`, status badge `#cppStatus`, terminal `#cppTerminal`,
  a "Load Example" button seeding a `@VIS`-instrumented recursive demo, and a hint listing the
  `@VIS` commands + JSCPP's STL limits.
- Add `sandbox.js` classic `<script>` (before app.js).
- Add a `<script type="module">` CodeMirror bootstrap (assigns `window.__cmEditor`, falls back to
  textarea on failure, then flips a ready flag sandbox.js polls).

### 2. style.css
- `.sandbox-card`, `.cm-mount` (bordered editor box, ~200px, monospace), `.cpp-terminal`
  (black scrollable output, `--green` for stdout, `--red` for errors, `--text-dim` for warnings),
  run/stop button row. Reuse existing `--` color tokens and `.btn`/`.tab` patterns.

### 3. sandbox.js  (NEW — `window.Sandbox.SandboxEngine`)
Constructed in `boot()` with `{ engine, getRenderer, els, hooks }` (mirrors SpeechEngine).
- `getCode()` — read from CodeMirror or textarea fallback.
- `run()` — `hooks.onRunStart()` (clearAll + enter sandbox mode + set source lines);
  `engine.sandboxBegin()`; spawn inline worker; stream stdout.
- `_makeWorker()` — Blob worker: `importScripts(JSCPP_CDN)`, `JSCPP.run` with
  `stdio.write` posting each chunk back; posts `done`/`error`.
- `_onStdout(chunk)` — line-buffer, split, route `@VIS:` vs terminal text. Each routed command
  pushes a snapshot into `algorithmHistory` via engine sandbox methods.
- `_onDone()` — `hooks.onRunEnd()` → `engine.jumpToStart()` then existing execute-style playback.
- `_onError(msg)` / timeout — print red, `terminate()`.
- `stop()` — terminate worker, stop playback.
- id→uuid `Map` lives here (per decision).

### 4. dsaEngine.js  (sandbox authoring API)
- `setSandboxSource(lines)` + `getSource('customCpp')` returns it (so the code panel shows the
  user's C++ and `@VIS:LINE` highlights the right row).
- `sandboxBegin()` — `_resetTrace()`, `activeAlgorithm='customCpp'`, init `_sandboxModel={nodes,edges}`
  and reuse `_recBegin` bookkeeping so the call-frame snapshot format is identical to recursion.
- `sandboxNode(value)` — push node (auto-layout on a spiral/grid), `_record` a snapshot, return uuid.
- `sandboxEdge(fromUuid,toUuid)` — push directed edge, `_record`.
- `sandboxCall(label,args)` / `sandboxReturn(value)` / `sandboxLine(idx,desc)` — thin wrappers over
  the existing `emitCallEnter`/`emitCallReturn`/`emitLineHighlight`, but recording the CURRENT
  `_sandboxModel` (so nodes AND stack ride in every snapshot).
- Export nothing new to remove; add `customCpp` awareness to `setActiveAlgorithm`'s known keys.

### 5. render3d.js  (sandbox overlay mode)
- `enterSandboxMode()` — `_recActive=true`, `_recMode='stack'`, show `_recStackGroup`, but do NOT
  hide `nodeMeshes`/`edgeMeshes`/`grid` (the stack HUD floats over the live graph). Park camera
  gently but keep orbit usable.
- `exitSandboxMode()` — hide stack group, clear `_recActive`, restore normal DS view.
- Guard the `_recActive` frame branch so it tolerates a visible DS layer.

### 6. app.js  (wiring + coordination)
- Add `els`: `cmEditor, btnRunCpp, btnStopCpp, cppStatus, cppTerminal, btnCppExample`.
- `let sandboxMode = false;` — OR it into the `flushUI` condition that calls `renderer.renderFrame`.
- `wireSandbox()` (called in `boot`): construct `window.Sandbox.SandboxEngine` with hooks:
  - `onRunStart`: `stopExecute()`, `engine.clear()`, `sandboxMode=true`,
    `renderer.enterSandboxMode()`, set badges/active algo.
  - `onRunEnd`: `engine.jumpToStart()` + reuse the `execute` auto-advance timer.
  - playback deferral via existing `deferHeavy`.
- Add "Custom C++" entry to `ALGO_LABELS`; when another algo tab / LA / recursion mode is chosen,
  `exitSandboxMode()` + `sandboxMode=false` (LA precedence unchanged).

## Verification (no headless WebGL/Worker/CodeMirror possible)
- `node --check` on dsaEngine.js, render3d.js, app.js, sandbox.js.
- Extract & unit-test the pure `@VIS` line parser + id→uuid mapping in Node (no DOM) to prove
  routing/edge-resolution/malformed-line handling.
- Everything else (CodeMirror editor, JSCPP-in-worker, 3D overlay, swipe playback) is a browser
  test the user runs — same as prior phases.

## Documented JSCPP limits (shown in the card hint + demo comments)
Unmaintained interpreter: reliable for basic types, arrays, pointers, recursion, `<iostream>`
`cout`/`endl`. Avoid `<vector>`/`<map>`/`<string>` methods and modern STL. The bundled demo uses
only supported features.
