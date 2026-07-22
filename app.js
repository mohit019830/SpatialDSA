/**
 * app.js
 * ---------------------------------------------------------------------------
 * System Orchestration & Interaction Mapping.
 *
 * This is the conductor. It owns no algorithms and draws no triangles — it
 * wires the four engines together:
 *
 *   vision.js  --(normalized hand events)-->  interaction state machine
 *   speech.js  --(macro intents)---------->  step / execute / clear
 *   dsaEngine  --(onChange model)--------->  render3d.setModel + code panel
 *   render3d   --(raycast hover/worldPt)-->  spawn / drag / connect decisions
 *
 * Gesture grammar (mid-air):
 *   • Pinch in EMPTY space  → spawn a node, then drag it while held.
 *   • Pinch-hold ON a node  → drag that node; edges follow in real time.
 *   • Pinch on A, release near B → create a directed pointer edge A → B.
 *   • Swipe left / right     → step the active trace back / forward.
 *
 * Voice grammar:
 *   • "execute" → build + auto-play the trace.
 *   • "next" / "back" → single step.
 *   • "clear" → flush the universe.
 * ---------------------------------------------------------------------------
 */

'use strict';

(function () {
  /* =========================================================================
   * DOM references
   * ====================================================================== */
  const $ = (sel) => document.querySelector(sel);

  const els = {
    scene: $('#scene'),
    webcam: $('#webcam'),
    overlay: $('#overlay'),
    // status
    fpsBadge: $('#fpsBadge'),
    stepBadge: $('#stepBadge'),
    algoBadge: $('#algoBadge'),
    visionStatus: $('#visionStatus'),
    descBadge: $('#descBadge'),
    // voice
    voiceToggle: $('#voiceToggle'),
    voiceOrb: $('#voiceOrb'),
    voiceState: $('#voiceState'),
    // code
    algoTabs: $('#algoTabs'),
    codeTrace: $('#codeTrace'),
    // controls
    btnBuild: $('#btnBuild'),
    btnExecute: $('#btnExecute'),
    btnBack: $('#btnBack'),
    btnForward: $('#btnForward'),
    btnClear: $('#btnClear'),
    seedValue: $('#seedValue'),
    btnSeedNode: $('#btnSeedNode'),
    btnSeedDemo: $('#btnSeedDemo'),
    // structure input (text auto-layout)
    structFormatTabs: $('#structFormatTabs'),
    structInput: $('#structInput'),
    structStatus: $('#structStatus'),
    btnParseStruct: $('#btnParseStruct'),
    btnStructExample: $('#btnStructExample'),
    // linear algebra (grid transformer)
    linalgModeTabs: $('#linalgModeTabs'),
    linalgBody: $('.linalg-body'),
    linalgDet: $('#linalgDet'),
    matrixGrid: $('#matrixGrid'),
    btnApplyMatrix: $('#btnApplyMatrix'),
    btnResetMatrix: $('#btnResetMatrix'),
    linalgPresets: $('#linalgPresets'),
    laDimToggle: $('#laDimToggle'),
    laVecInputs: $('#laVecInputs'),
    laVecX: $('#laVecX'),
    laVecY: $('#laVecY'),
    laVecZ: $('#laVecZ'),
    btnAddVector: $('#btnAddVector'),
    laVecList: $('#laVecList'),
    btnUndoMatrix: $('#btnUndoMatrix'),
    btnInvertMatrix: $('#btnInvertMatrix'),
    laSnapToggle: $('#laSnapToggle'),
    laEigenToggle: $('#laEigenToggle'),
    laDetToggle: $('#laDetToggle'),
    laSpeed: $('#laSpeed'),
    laSpeedVal: $('#laSpeedVal'),
    // recursion visualizer
    recViewTabs: $('#recViewTabs'),
    recStatus: $('#recStatus'),
    // playback & insight
    complexityBadge: $('#complexityBadge'),
    opCmp: $('#opCmp'),
    opSwap: $('#opSwap'),
    opVisit: $('#opVisit'),
    stepScrubber: $('#stepScrubber'),
    btnScrubBack: $('#btnScrubBack'),
    btnScrubFwd: $('#btnScrubFwd'),
    scrubReadout: $('#scrubReadout'),
    playSpeed: $('#playSpeed'),
    playSpeedVal: $('#playSpeedVal'),
    varList: $('#varList'),
    // custom C++ sandbox
    cppStatus: $('#cppStatus'),
    cppTerminal: $('#cppTerminal'),
    cppStdin: $('#cppStdin'),
    testCaseFormat: $('#testCaseFormat'),
    btnRunCpp: $('#btnRunCpp'),
    btnStopCpp: $('#btnStopCpp'),
    btnCppExample: $('#btnCppExample'),
    // global input
    btnGestureToggle: $('#btnGestureToggle'),
    // hud
    hudMode: $('#hudMode'),
    hudPinch: $('#hudPinch'),
    hudDesc: $('#hudDesc'),
    // splash
    splash: $('#splash'),
    splashMsg: $('#splashMsg'),
    splashEnter: $('#splashEnter'),
  };

  const ALGO_LABELS = {
    linkedListReversal: 'LINKED LIST',
    bstInsert: 'BST INSERT',
    bstDelete: 'BST DELETE',
    dfs: 'DFS',
    dijkstra: 'DIJKSTRA',
    fibonacci: 'FIBONACCI',
    mergeSort: 'MERGE SORT',
    dfsRecursive: 'REC. DFS',
    stack: 'STACK',
    queue: 'QUEUE',
    hashTable: 'HASH TABLE',
    heap: 'MIN-HEAP',
    quickSort: 'QUICKSORT',
    bubbleSort: 'BUBBLE SORT',
    insertionSort: 'INSERTION SORT',
    bfs: 'BFS',
  };

  /** Algorithms that drive the recursion visualizer (call tree + stack). */
  const RECURSIVE_ALGOS = new Set(['fibonacci', 'mergeSort', 'dfsRecursive']);

  /** Big-O time/space per algorithm, shown in the Playback & Insight badge. */
  const ALGO_COMPLEXITY = {
    linkedListReversal: { time: 'O(n)', space: 'O(1)' },
    bstInsert: { time: 'O(h)', space: 'O(h)' },
    bstDelete: { time: 'O(h)', space: 'O(h)' },
    dfs: { time: 'O(V+E)', space: 'O(V)' },
    bfs: { time: 'O(V+E)', space: 'O(V)' },
    dijkstra: { time: 'O(E log V)', space: 'O(V)' },
    fibonacci: { time: 'O(2ⁿ)', space: 'O(n)' },
    mergeSort: { time: 'O(n log n)', space: 'O(n)' },
    dfsRecursive: { time: 'O(V+E)', space: 'O(V)' },
    stack: { time: 'O(1) ops', space: 'O(n)' },
    queue: { time: 'O(1) ops', space: 'O(n)' },
    hashTable: { time: 'O(1) avg', space: 'O(n)' },
    heap: { time: 'O(log n) push', space: 'O(n)' },
    quickSort: { time: 'O(n log n) avg', space: 'O(log n)' },
    bubbleSort: { time: 'O(n²)', space: 'O(1)' },
    insertionSort: { time: 'O(n²)', space: 'O(1)' },
  };

  function updateComplexityBadge(algo) {
    const c = ALGO_COMPLEXITY[algo];
    els.complexityBadge.textContent = c ? `${c.time} · ${c.space}` : 'O(?)';
  }

  /* =========================================================================
   * Engine instances
   * ====================================================================== */
  const engine = new window.DSA.DSAEngine();
  let renderer = null;   // created after we confirm THREE loaded
  let vision = null;
  let speech = null;

  /** Latest presented model — kept so gesture code can read node positions. */
  let currentModel = { nodes: [], edges: [] };

  /** Auto-incrementing default node value when the seed input is empty. */
  let autoValue = 1;

  /* =========================================================================
   * Interaction state machine (driven by vision events)
   * -------------------------------------------------------------------------
   * Ultron-orb gesture grammar — three interaction layers plus node authoring:
   *
   *   ZOOM   Two hands, both pinched. Spread apart → dolly in, together → out.
   *          Highest priority; owns the frame while active (vision emits .zoom).
   *
   *   ROTATE One hand pinched over EMPTY space. Hand deltas spin the field
   *          (yaw = rotation.y, pitch = rotation.x) with momentum.
   *   DRAG   One hand pinched over a NODE. That node follows the fingertip.
   *
   *   LINK   Two-finger pointer (index+middle extended, ring+pinky curled)
   *          starting on Node A. A glowing temp line follows the fingertip;
   *          curling the middle finger over Node B commits the edge, over empty
   *          space discards it.
   *
   *   CREATE Double-pinch in empty space spawns a node (unchanged).
   * ====================================================================== */
  const MODE = {
    IDLE: 'IDLE',
    DRAG_NODE: 'DRAG_NODE',
    ROTATE: 'ROTATE',
    ZOOM: 'ZOOM',
    LINK: 'LINK',
    LASER: 'LASER',            // mouse-driven "draw & shoot" edge laser
    LA_DRAG: 'LA_DRAG',        // dragging a basis vector in linear-algebra mode
    NAV: 'NAV',                // mouse-driven field rotate (empty-space drag)
  };

  // Global input state. When gestures are OFF, the vision pipeline + webcam are
  // stopped and the mouse drives everything. The mouse is ALWAYS live; when
  // gestures are on, vision simply wins any frame it's actively driving.
  let gesturesEnabled = true;
  // True while the 3D stage is showing the linear-algebra grid transformer.
  let linearMode = false;
  // True while the 3D stage is showing the recursion visualizer (auto-entered
  // whenever a recursive algorithm is the active tab). 'tree' | 'stack'.
  let recursionMode = false;
  let recursionView = 'tree';

  // True while a custom-C++ sandbox run is on the stage. Unlike recursionMode,
  // the DS layer stays visible (nodes + edges + call-stack overlay together).
  let sandboxMode = false;
  let sandbox = null;   // Sandbox.SandboxEngine, created in boot()

  // Ghost-node guard: never spawn within this of an existing node.
  const SPAWN_MIN_GAP = 1.5;   // world units (field-local)

  const gesture = {
    mode: MODE.IDLE,
    dragTarget: null,          // uuid of the node locked for dragging
    lastCursor: null,          // {x,y} last normalized cursor (for rotate deltas)
    linkFrom: null,            // uuid of Node A while a link line is being drawn
  };

  /* -------------------------------------------------------------------------
   * Mouse "Draw & Shoot" laser state. Kept separate from `gesture` so the two
   * input methods never share mutable fields. `active` is only true between a
   * mousedown-on-node and its mouseup.
   * ---------------------------------------------------------------------- */
  const mouse = {
    active: false,
    from: null,                // uuid of the locked Source Node
    snapTo: null,              // uuid the laser is currently magnet-locked to
    // Extra mouse roles (used mainly when gestures are off, but always live):
    navFrom: null,             // {x,y} client px anchor for empty-space rotate
    laDrag: false,             // dragging an LA basis vector with the mouse
    downAt: null,              // {x,y,t} of the last mousedown (click vs drag)
  };

  /* =========================================================================
   * C++ syntax highlighting (lightweight tokenizer)
   * ====================================================================== */
  const CPP_KEYWORDS = new Set([
    'if', 'else', 'while', 'for', 'return', 'new', 'continue', 'break',
    'nullptr', 'true', 'false', 'void', 'struct', 'class',
  ]);
  const CPP_TYPES = new Set([
    'int', 'Node', 'stack', 'bool', 'float', 'double', 'auto', 'vector',
  ]);

  /** Escape HTML so code text can't inject markup. */
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Tokenize a single C++ line into span-wrapped HTML. Deliberately simple:
   * handles comments, strings, numbers, keywords, types, and function calls.
   */
  function highlightCpp(line) {
    // Comment first — everything after // is a comment.
    const commentIdx = line.indexOf('//');
    let code = line, comment = '';
    if (commentIdx >= 0) {
      code = line.slice(0, commentIdx);
      comment = line.slice(commentIdx);
    }

    // Tokenize the code part by words / symbols while preserving whitespace.
    let html = code.replace(/("[^"]*")|\b([A-Za-z_]\w*)\b|(\d+)/g, (m, str, word, num) => {
      if (str) return `<span class="tok-str">${esc(str)}</span>`;
      if (num) return `<span class="tok-num">${esc(num)}</span>`;
      if (word) {
        if (CPP_KEYWORDS.has(word)) return `<span class="tok-key">${esc(word)}</span>`;
        if (CPP_TYPES.has(word)) return `<span class="tok-type">${esc(word)}</span>`;
        return `<span class="tok-fn">${esc(word)}</span>`;
      }
      return esc(m);
    });
    // Escape any leftover raw angle brackets/amps not inside spans is already
    // handled per-token; whitespace/punctuation passes through untouched.

    if (comment) html += `<span class="tok-com">${esc(comment)}</span>`;
    return html;
  }

  /** Render the active algorithm's source, marking the highlighted line. */
  function renderCode(algorithm, activeLine) {
    const src = engine.getSource(algorithm);
    const frag = document.createDocumentFragment();
    src.forEach((line, idx) => {
      const el = document.createElement('span');
      el.className = 'code-line' + (idx === activeLine ? ' active' : '');
      el.setAttribute('data-ln', String(idx + 1));
      el.innerHTML = highlightCpp(line) + '\n';
      frag.appendChild(el);
    });
    els.codeTrace.innerHTML = '';
    els.codeTrace.appendChild(frag);

    // Keep the active line in view within the scrollable code block.
    const active = els.codeTrace.querySelector('.code-line.active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* =========================================================================
   * Engine → UI binding
   * ====================================================================== */
  /*
   * DECOUPLED UI FLUSH
   * ------------------------------------------------------------------------
   * The engine emits on every mutation — including once per frame while a node
   * is being dragged. Doing DOM work (re-tokenizing the whole C++ listing,
   * innerHTML swaps, scrollIntoView) synchronously on each emit was the primary
   * source of main-thread jank.
   *
   * Instead, onChange only stashes the latest state and requests a single rAF
   * flush. Within the flush we:
   *   • hand the model to the renderer (cheap uuid-diff reconciliation), and
   *   • rebuild the expensive code panel ONLY when the highlighted line or the
   *     algorithm actually changed. Pure position updates (drags) skip it.
   */
  let _pendingState = null;
  let _uiFlushScheduled = false;
  let _lastRenderedLine = -2;
  let _lastRenderedAlgo = null;

  function scheduleUIFlush() {
    if (_uiFlushScheduled) return;
    _uiFlushScheduled = true;
    requestAnimationFrame(flushUI);
  }

  function flushUI() {
    _uiFlushScheduled = false;
    const state = _pendingState;
    if (!state) return;

    // 3D model reconciliation (allocation-free, safe every frame).
    if (renderer) renderer.setModel(state.model);

    // Recursion visualizer / sandbox overlay: hand the current step's call-frame
    // snapshot to the renderer for the stack tower + call tree. Null frames
    // (non-recursive steps / idle) simply clear it. In sandbox mode the DS layer
    // renders underneath the tower rather than being hidden.
    if (renderer && (recursionMode || sandboxMode)) {
      renderer.renderFrame(state.frame || null, state.stepIndex);
    }

    // Heavy code-panel rebuild: gated on line/algorithm change only.
    if (state.lineIndex !== _lastRenderedLine || state.algorithm !== _lastRenderedAlgo) {
      renderCode(state.algorithm, state.lineIndex);
      _lastRenderedLine = state.lineIndex;
      _lastRenderedAlgo = state.algorithm;
    }

    // Cheap text/badge updates.
    els.descBadge.textContent = state.playing
      ? `step ${state.stepIndex + 1}/${state.stepCount}`
      : 'idle';
    els.hudDesc.textContent = state.description || '';
    els.stepBadge.textContent = state.playing
      ? `STEP ${state.stepIndex + 1}/${state.stepCount}`
      : 'STEP --';
    els.algoBadge.textContent = ALGO_LABELS[state.algorithm] || state.algorithm;

    // --- Playback & Insight panel ------------------------------------------
    updateInsightPanel(state);
  }

  /**
   * Refresh the Playback & Insight card from the current step: op counters, the
   * timeline scrubber position/extent, and the variable inspector. All cheap
   * text/DOM updates gated so we don't thrash when nothing changed.
   */
  let _lastVarsKey = null;
  function updateInsightPanel(state) {
    // Operation counters (running tally snapshot at this step).
    const s = state.stats || { comparisons: 0, swaps: 0, visits: 0 };
    els.opCmp.textContent = s.comparisons || 0;
    els.opSwap.textContent = s.swaps || 0;
    els.opVisit.textContent = s.visits || 0;

    // Timeline scrubber: sync max + value to the trace without firing input.
    if (state.playing && state.stepCount > 0) {
      els.stepScrubber.max = String(state.stepCount - 1);
      els.stepScrubber.value = String(state.stepIndex);
      els.scrubReadout.textContent = `step ${state.stepIndex + 1} / ${state.stepCount}`;
    } else {
      els.stepScrubber.max = '0';
      els.stepScrubber.value = '0';
      els.scrubReadout.textContent = 'step —';
    }

    // Variable inspector: prefer explicit step.vars; fall back to the recursion
    // frame's top-of-stack locals for the recursion-view algorithms.
    let vars = state.vars;
    if ((!vars || !vars.length) && state.frame && state.frame.stack && state.frame.stack.length) {
      const top = state.frame.stack[state.frame.stack.length - 1];
      vars = [
        ...(top.args || []).map((a) => ({ name: a.name, value: a.value })),
        ...(top.locals || []).map((l) => ({ name: l.name, value: l.value })),
      ];
    }
    const key = vars && vars.length
      ? vars.map((v) => `${v.name}=${v.value}`).join('|') : (state.playing ? '∅' : null);
    if (key !== _lastVarsKey) {
      _lastVarsKey = key;
      renderVarList(vars, state.playing);
    }
  }

  function renderVarList(vars, playing) {
    const ul = els.varList;
    ul.innerHTML = '';
    if (!vars || !vars.length) {
      const li = document.createElement('li');
      li.className = 'var-empty';
      li.textContent = playing ? '(no tracked variables)' : '— build a trace —';
      ul.appendChild(li);
      return;
    }
    for (const v of vars) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="var-name">${escapeHtml(String(v.name))}</span>` +
        `<span class="var-val">${escapeHtml(String(v.value))}</span>`;
      ul.appendChild(li);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  engine.onChange((state) => {
    // Keep the synchronous shared reference fresh so gesture math (which reads
    // node positions immediately) never lags a frame behind.
    currentModel = state.model;
    _pendingState = state;
    scheduleUIFlush();
  });

  /* =========================================================================
   * Node spawning helper
   * ====================================================================== */
  function nextValue() {
    const raw = els.seedValue.value.trim();
    if (raw !== '' && !Number.isNaN(Number(raw))) {
      const v = Number(raw);
      els.seedValue.value = '';
      return v;
    }
    return autoValue++;
  }

  /* =========================================================================
   * Gesture handling — the heart of the mid-air interaction
   * ====================================================================== */
  /**
   * Closest node to a world point within a radius. Returns { node, dist } or
   * null. Used by the ghost-node proximity guard on creation.
   */
  function closestNode(worldPoint, radius) {
    let best = null, bestD = Infinity;
    for (const n of currentModel.nodes) {
      const dx = n.position.x - worldPoint.x;
      const dy = n.position.y - worldPoint.y;
      const dz = n.position.z - worldPoint.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best && bestD <= radius ? { node: best, dist: bestD } : null;
  }

  /* -------------------------------------------------------------------------
   * PATH: DOUBLE-PINCH → NODE CREATION.
   * Fired only when vision.js flags a double pinch (two pinch-downs < 300ms).
   * A single pinch NEVER reaches here, so it can never spawn a node.
   * ---------------------------------------------------------------------- */
  function onDoublePinch(hovered, worldPoint) {
    if (!worldPoint) return;
    // Only create in genuinely empty space: not on a node, and not stacked on
    // top of one (ghost-node guard).
    if (hovered) return;
    if (closestNode(worldPoint, SPAWN_MIN_GAP)) return;

    engine.addNode(nextValue(), worldPoint);
    // Do NOT lock a drag here — creation is its own discrete action. The user
    // can single-pinch the fresh node afterward to reposition it.
    gesture.mode = MODE.IDLE;
    gesture.dragTarget = null;
    gesture.linkFrom = null;
    setMode('CREATE');
  }

  /* -------------------------------------------------------------------------
   * ZOOM (two-handed pinch). vision.js emits a signed `zoom` spread scalar;
   * render3d applies the 0.1 camera-Z lerp. Zoom pre-empts every single-hand
   * gesture, so we tear down any in-flight drag/rotate/link first.
   * ---------------------------------------------------------------------- */
  function onZoom(spread) {
    if (gesture.mode === MODE.LINK) renderer.endLink();   // abort a half-drawn link
    gesture.mode = MODE.ZOOM;
    gesture.dragTarget = null;
    gesture.linkFrom = null;
    renderer.zoomCamera(spread);
    setMode('ZOOM');
  }

  /* -------------------------------------------------------------------------
   * SINGLE PINCH-DOWN → contextual lock.
   *   over a node  → DRAG that node.
   *   empty space  → ROTATE the field (Ultron orb spin).
   * ---------------------------------------------------------------------- */
  function onPinchStart(hovered, worldPoint, cursor) {
    if (hovered) {
      gesture.mode = MODE.DRAG_NODE;
      gesture.dragTarget = hovered;
      setMode('DRAG');
    } else {
      gesture.mode = MODE.ROTATE;
      gesture.dragTarget = null;
      gesture.lastCursor = cursor ? { x: cursor.x, y: cursor.y } : null;
      setMode('ROTATE');
    }
  }

  /* -------------------------------------------------------------------------
   * SINGLE PINCH SUSTAINED → drive whichever object we locked onto.
   * ---------------------------------------------------------------------- */
  function onPinchMove(worldPoint, cursor) {
    if (gesture.mode === MODE.DRAG_NODE) {
      // Node follows the fingertip (field-local worldPoint from render3d).
      if (gesture.dragTarget && worldPoint) {
        engine.moveNode(gesture.dragTarget, worldPoint);
      }
    } else if (gesture.mode === MODE.ROTATE) {
      // Hand delta spins the field. render3d applies the momentum lerp; deltas
      // are normalized-screen units, so yaw follows horizontal, pitch vertical.
      if (cursor && gesture.lastCursor) {
        const dnx = cursor.x - gesture.lastCursor.x;
        const dny = cursor.y - gesture.lastCursor.y;
        renderer.rotateField(dnx, dny);
      }
      if (cursor) gesture.lastCursor = { x: cursor.x, y: cursor.y };
    }
  }

  /* -------------------------------------------------------------------------
   * PINCH RELEASE → drop the pinch-driven gesture (drag / rotate).
   * ---------------------------------------------------------------------- */
  function onPinchEnd() {
    if (gesture.mode === MODE.DRAG_NODE || gesture.mode === MODE.ROTATE ||
        gesture.mode === MODE.LA_DRAG) {
      gesture.mode = MODE.IDLE;
      gesture.dragTarget = null;
      gesture.lastCursor = null;
      setMode('IDLE');
    }
  }

  /* -------------------------------------------------------------------------
   * LINKING POSE — two-finger pointer for edge creation.
   *   onLinkStart : pose entered over Node A → anchor a glowing temp line.
   *   onLinkMove  : fingertip drags the free end of the line.
   *   onLinkEnd   : pose exited → commit edge if over Node B, else discard.
   * ---------------------------------------------------------------------- */
  function onLinkStart(hovered) {
    // Only meaningful if the pose begins on a node.
    if (!hovered) return;
    if (renderer.beginLink(hovered)) {
      gesture.mode = MODE.LINK;
      gesture.linkFrom = hovered;
      gesture.dragTarget = null;
      setMode('LINK');
    }
  }

  function onLinkMove(worldPoint) {
    if (gesture.mode !== MODE.LINK) return;
    renderer.updateLink(worldPoint);   // field-local endpoint follows fingertip
  }

  function onLinkEnd(hovered) {
    if (gesture.mode !== MODE.LINK) return;
    const from = gesture.linkFrom;
    // Commit only if we released over a DIFFERENT node.
    if (from && hovered && hovered !== from) {
      engine.addEdge(from, hovered, { directed: true, weight: 1 });
    }
    renderer.endLink();                // solidified via setModel, or discarded
    gesture.mode = MODE.IDLE;
    gesture.linkFrom = null;
    setMode('IDLE');
  }

  function setMode(mode) {
    els.hudMode.textContent = `MODE · ${mode}`;
  }

  /* =========================================================================
   * Vision wiring
   * ====================================================================== */
  function handleVisionFrame(evt) {
    // Cheap HUD text (only when the value actually changed, to avoid layout
    // thrash on every interpolated frame).
    const fpsTxt = `FPS ${evt.fps || 0}`;
    if (els.fpsBadge.textContent !== fpsTxt) els.fpsBadge.textContent = fpsTxt;
    const pinchTxt = `PINCH · ${evt.pinch ? 'yes' : 'no'}`;
    if (els.hudPinch.textContent !== pinchTxt) els.hudPinch.textContent = pinchTxt;

    if (!renderer) return;

    /* ---- LAYER 1: TWO-HANDED ZOOM (highest priority) --------------------
     * When both hands are pinched, vision emits a signed `zoom` spread and no
     * cursor. This owns the frame — we route it and return before any
     * single-hand raycast/gesture logic runs. */
    if (evt.zoom !== null && evt.zoom !== undefined) {
      renderer.updateCursor(0, 0, false, false);
      onZoom(evt.zoom);
      return;
    }
    // Falling out of zoom (second hand dropped) hands control back to idle.
    if (gesture.mode === MODE.ZOOM) onPinchEnd_zoomExit();

    // Update the mid-air cursor + (gated) raycast hover. `forceHover` is on
    // during the linking pose so we resolve node targets WITHOUT a pinch.
    let hovered = null, worldPoint = null;
    if (evt.present && evt.cursor) {
      // forceHover on the linking pose AND on its release edge, so the final
      // "commit over Node B?" raycast is fresh rather than a frame stale.
      const res = renderer.updateCursor(
        evt.cursor.x, evt.cursor.y, true, evt.pinch, evt.linking || evt.linkEnd
      );
      hovered = res.hovered;
      worldPoint = res.worldPoint;
    } else {
      renderer.updateCursor(0, 0, false, false);
      // Lost the hand mid-gesture: tear down whatever was in flight.
      if (!evt.present && gesture.mode !== MODE.IDLE) {
        if (gesture.mode === MODE.LINK) onLinkEnd(null);
        else onPinchEnd();
      }
    }

    /* ---- LINEAR-ALGEBRA MODE owns the pinch grammar ---------------------
     * In grid-transform mode the data-structure gestures (link / create /
     * node-drag) are meaningless. A pinch instead grabs the nearest basis-
     * vector tip and drags it (reshaping the matrix live); an empty-space
     * pinch still rotates the grid. Handle it and return before the DS layers.
     * Two-handed zoom already returned above, so camera dolly still works. */
    if (linearMode) {
      handleLinearGesture(evt);
      return;
    }

    /* ---- LAYER 3: LINKING POSE (two-finger edge pointer) ----------------
     * Handled before pinch so the two grammars never collide. Edge events
     * (linkStart/linkEnd) fire only on real detection frames; linkMove rides
     * every frame so the temp line tracks the interpolated fingertip. */
    if (evt.linkStart) {
      onLinkStart(hovered);
    } else if (evt.linkEnd) {
      onLinkEnd(hovered);
    } else if (gesture.mode === MODE.LINK && evt.linking) {
      onLinkMove(worldPoint);
    }

    /* ---- LAYER 2: SINGLE-HAND PINCH (rotate / drag / create) ------------
     * Skipped entirely while a link is being drawn. Dispatch order matters: a
     * double-pinch also carries a pinchStart edge on its second down, so we
     * handle double-pinch (create) FIRST — a single pinch can never spawn. */
    if (gesture.mode !== MODE.LINK && !evt.linking) {
      if (evt.doublePinch) {
        onDoublePinch(hovered, worldPoint);
      } else if (evt.pinchStart) {
        onPinchStart(hovered, worldPoint, evt.cursor);
      } else if (evt.pinch) {
        onPinchMove(worldPoint, evt.cursor);
      } else if (evt.pinchEnd) {
        onPinchEnd();
      }
    }

    // Swipes map straight onto trace stepping.
    if (evt.swipe === 'SWIPE_RIGHT') stepForward();
    else if (evt.swipe === 'SWIPE_LEFT') stepBackward();
  }

  /** Zoom released (dropped to one/zero hands): return to idle cleanly. */
  function onPinchEnd_zoomExit() {
    gesture.mode = MODE.IDLE;
    gesture.dragTarget = null;
    gesture.lastCursor = null;
    setMode('IDLE');
  }

  /* -------------------------------------------------------------------------
   * LINEAR-ALGEBRA PINCH GRAMMAR.
   *   pinch near î/ĵ/k̂ tip → grab + drag that basis vector (reshapes matrix).
   *   pinch in open space   → rotate the grid (reuses the field rotate path).
   *   release               → settle the matrix into the form + det badge.
   * Hover (no pinch) highlights the grabbable arrow under the cursor.
   *
   * Routes through the SAME screen-space pick/drag the mouse uses
   * (laPickScreen / laDragScreen), so all three arrows — including the purple
   * k̂ that points toward the camera — are grabbable and drags stay correct in
   * both 2D and 3D. The vision cursor's normalized 0..1 coords map to canvas
   * pixels via the shared NDC convention.
   * ---------------------------------------------------------------------- */
  function cursorToClient(cursor) {
    const rect = els.scene.getBoundingClientRect();
    return {
      x: rect.left + cursor.x * rect.width,
      y: rect.top + cursor.y * rect.height,
    };
  }

  function handleLinearGesture(evt) {
    // Hand gone: release any in-flight grab, drop rotate.
    if (!evt.present || !evt.cursor) {
      if (renderer.laIsGrabbing) syncMatrixFromRenderer(renderer.laReleaseBasis());
      if (gesture.mode === MODE.ROTATE || gesture.mode === MODE.LA_DRAG) onPinchEnd();
      renderer.laHighlightBasis(null);
      return;
    }

    const c = cursorToClient(evt.cursor);

    if (evt.pinchStart) {
      // Prefer grabbing a basis tip; fall back to rotating the grid.
      const pick = renderer.laPickScreen(c.x, c.y);
      if (pick !== null && renderer.laGrabBasis(pick)) {
        gesture.mode = MODE.LA_DRAG;
        setMode('LA_DRAG');
      } else {
        gesture.mode = MODE.ROTATE;
        gesture.lastCursor = { x: evt.cursor.x, y: evt.cursor.y };
        setMode('ROTATE');
      }
    } else if (evt.pinch) {
      if (gesture.mode === MODE.LA_DRAG) {
        syncMatrixFromRenderer(renderer.laDragScreen(c.x, c.y));
      } else if (gesture.mode === MODE.ROTATE && evt.cursor && gesture.lastCursor) {
        const dnx = evt.cursor.x - gesture.lastCursor.x;
        const dny = evt.cursor.y - gesture.lastCursor.y;
        renderer.rotateField(dnx, dny);
        gesture.lastCursor = { x: evt.cursor.x, y: evt.cursor.y };
      }
    } else if (evt.pinchEnd) {
      if (gesture.mode === MODE.LA_DRAG) syncMatrixFromRenderer(renderer.laReleaseBasis());
      onPinchEnd();
    } else {
      // Idle hand: just highlight the arrow the cursor is near.
      renderer.laHighlightBasis(renderer.laPickScreen(c.x, c.y));
    }
  }

  /** Push a renderer-produced matrix (drag result) back into the form + badge. */
  function syncMatrixFromRenderer(m) {
    if (!m) return;
    writeMatrixCells(m);
    updateDetBadge(m);
  }

  /* =========================================================================
   * Trace control (shared by buttons, swipes, and voice)
   * ====================================================================== */
  function buildTrace() {
    // In sandbox mode the trace comes from @VIS output, not a trace builder, so
    // never rebuild — just report the already-built step count.
    if (sandboxMode) return engine.algorithmHistory.length;
    if (currentModel.nodes.length === 0) {
      els.hudDesc.textContent = 'Add some nodes first, then Build Trace.';
      return 0;
    }
    const n = engine.buildTrace();
    if (n === 0) els.hudDesc.textContent = 'Nothing to trace for this structure.';
    return n;
  }

  /*
   * DECOUPLED ALGORITHM TICKS
   * ------------------------------------------------------------------------
   * engine.buildTrace() deep-clones the entire model for every algorithm step
   * — heavy, synchronous work. It must never run inside a rAF frame (render or
   * vision), or it stalls the compositor and trips the unresponsive-page
   * watchdog. `deferHeavy` bounces such work to a macrotask so the current
   * frame finishes painting first.
   */
  function deferHeavy(fn) {
    setTimeout(fn, 0);
  }

  let _buildScheduled = false;
  function stepForward() {
    if (engine.algorithmHistory.length === 0) {
      // Build off-frame, then advance once the trace exists.
      if (_buildScheduled) return;
      _buildScheduled = true;
      deferHeavy(() => {
        _buildScheduled = false;
        if (buildTrace()) engine.stepForward();
      });
      return;
    }
    engine.stepForward();
  }

  function stepBackward() {
    engine.stepBackward();
  }

  let executeTimer = null;
  let execSpeedMs = 900;            // playback interval, driven by the speed slider
  function execute() {
    stopExecute();
    // Build the (potentially large) trace off the current frame.
    deferHeavy(() => {
      const steps = buildTrace();
      if (!steps) return;
      engine.jumpToStart();
      // Auto-advance on a timer — setInterval callbacks run between frames,
      // never inside requestAnimationFrame, so playback can't block rendering.
      executeTimer = setInterval(() => {
        const advanced = engine.stepForward();
        if (!advanced) stopExecute();
      }, execSpeedMs);
    });
  }
  function stopExecute() {
    if (executeTimer) { clearInterval(executeTimer); executeTimer = null; }
  }

  /** Restart the auto-play interval at the current speed (if playing). */
  function restartPlaybackTimer() {
    if (!executeTimer) return;
    clearInterval(executeTimer);
    executeTimer = setInterval(() => {
      const advanced = engine.stepForward();
      if (!advanced) stopExecute();
    }, execSpeedMs);
  }

  /**
   * Auto-play an ALREADY-BUILT history (no rebuild). The sandbox uses this: its
   * trace is populated by @VIS commands, so calling the normal execute() would
   * wrongly re-run buildTrace() and wipe it (customCpp has no trace builder).
   */
  function playExistingHistory() {
    stopExecute();
    if (engine.algorithmHistory.length === 0) return;
    engine.jumpToStart();
    executeTimer = setInterval(() => {
      const advanced = engine.stepForward();
      if (!advanced) stopExecute();
    }, execSpeedMs);
  }

  function clearAll() {
    stopExecute();
    exitSandboxStage();
    engine.clear();
    autoValue = 1;
    setMode('IDLE');
  }

  /* =========================================================================
   * Speech wiring
   * ====================================================================== */
  function handleVoiceCommand(cmd) {
    switch (cmd.intent) {
      case 'EXECUTE': execute(); break;
      case 'FORWARD': stopExecute(); stepForward(); break;
      case 'BACK':    stopExecute(); stepBackward(); break;
      case 'CLEAR':   clearAll(); break;
      default: break;
    }
  }

  function setVoiceStatus(state, detail) {
    const orb = els.voiceOrb;
    orb.className = 'voice-orb ' +
      (state === 'listening' ? 'voice-listening'
        : state === 'processing' ? 'voice-processing'
        : state === 'error' ? 'voice-error'
        : 'voice-idle');
    els.voiceState.textContent = detail || state;
  }

  /* =========================================================================
   * Manual controls + algorithm tabs
   * ====================================================================== */
  function wireControls() {
    els.btnBuild.addEventListener('click', buildTrace);
    els.btnExecute.addEventListener('click', execute);
    els.btnForward.addEventListener('click', () => { stopExecute(); stepForward(); });
    els.btnBack.addEventListener('click', () => { stopExecute(); stepBackward(); });
    els.btnClear.addEventListener('click', clearAll);

    els.btnSeedNode.addEventListener('click', () => {
      // Spawn on a loose spiral so manually-added nodes don't stack.
      const i = currentModel.nodes.length;
      const angle = i * 0.9;
      const r = 4 + i * 0.6;
      engine.addNode(nextValue(), {
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r * 0.4,
        z: 0,
      });
    });

    els.btnSeedDemo.addEventListener('click', seedDemoData);

    // Algorithm tab switching.
    els.algoTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      els.algoTabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const algo = btn.getAttribute('data-algo');
      stopExecute();
      exitSandboxStage();   // switching algorithms leaves the C++ sandbox stage
      engine.setActiveAlgorithm(algo);
      // Re-render the source immediately (engine._resetTrace emits nothing here).
      renderCode(algo, -1);
      els.algoBadge.textContent = ALGO_LABELS[algo] || algo;
      updateComplexityBadge(algo);
      syncRecursionMode(algo);
    });

    els.voiceToggle.addEventListener('click', () => {
      if (!speech) return;
      const on = speech.toggle();
      els.voiceToggle.textContent = on ? 'disable' : 'enable';
    });

    els.btnGestureToggle.addEventListener('click', () => setGesturesEnabled(!gesturesEnabled));
  }

  /* -------------------------------------------------------------------------
   * GLOBAL HAND-GESTURE TOGGLE.
   * OFF → stop the vision pipeline AND the webcam stream (camera light off);
   *       the mouse (always live) becomes the sole input.
   * ON  → re-acquire the camera + restart detection.
   * The mouse works either way; this only controls the camera/vision half.
   * ---------------------------------------------------------------------- */
  async function setGesturesEnabled(on) {
    gesturesEnabled = on;
    els.btnGestureToggle.classList.toggle('is-on', on);
    els.btnGestureToggle.setAttribute('aria-pressed', String(on));
    els.btnGestureToggle.textContent = on ? 'GESTURES · ON' : 'GESTURES · OFF';

    // Turning off mid-gesture must tear down anything vision had in flight.
    if (!on) {
      if (gesture.mode !== MODE.IDLE) {
        if (gesture.mode === MODE.LINK) onLinkEnd(null);
        else if (renderer && renderer.laIsGrabbing) renderer.laReleaseBasis();
        onPinchEnd();
        onPinchEnd_zoomExit();
      }
      // The rAF loop is about to stop, so hide the now-frozen mid-air reticle.
      if (renderer) renderer.updateCursor(0, 0, false, false);
    }

    if (!vision) {
      // No vision engine at all (camera never initialized) — mouse-only anyway.
      els.hudDesc.textContent = on
        ? 'Camera unavailable — mouse controls remain active.'
        : 'Gestures off. Use the mouse to build and explore.';
      return;
    }
    try {
      await vision.setEnabled(on);
    } catch (err) {
      console.warn('[app] gesture toggle failed:', err);
      // Camera re-request denied: fall back to mouse and reflect reality.
      gesturesEnabled = false;
      els.btnGestureToggle.classList.remove('is-on');
      els.btnGestureToggle.setAttribute('aria-pressed', 'false');
      els.btnGestureToggle.textContent = 'GESTURES · OFF';
    }
    els.hudDesc.textContent = on
      ? 'Gestures on. Pinch to grab; two hands to zoom.'
      : 'Gestures off. Mouse: drag empty space to orbit, click to spawn, wheel to zoom.';
  }

  /* =========================================================================
   * MOUSE "DRAW & SHOOT" LASER (fallback that mirrors the vision link gesture)
   * -------------------------------------------------------------------------
   *   mousedown on a node  → lock it as the Source Node, start the beam.
   *   mousemove (held)     → stretch the beam to the cursor; auto-aim magnetism
   *                          snaps the tip to any node within 2.0 units.
   *   mouseup              → snapped ? commit the edge : destroy the beam.
   *
   * A vision gesture always wins: if the hands are mid-pinch/rotate/zoom/link,
   * the mouse path stays inert so the two inputs never fight over the beam.
   * ====================================================================== */
  function visionOwnsFrame() {
    // A live vision gesture only pre-empts the mouse while gestures are ON.
    if (!gesturesEnabled) return false;
    return gesture.mode === MODE.DRAG_NODE ||
           gesture.mode === MODE.ROTATE ||
           gesture.mode === MODE.ZOOM ||
           gesture.mode === MODE.LINK ||
           gesture.mode === MODE.LA_DRAG;
  }

  /** Reset every transient mouse role. Called on release, blur, and toggles. */
  function resetMouse() {
    if (mouse.active) renderer.endLink();
    if (mouse.laDrag) { renderer.laReleaseBasis(); renderer.laHighlightBasis(null); }
    mouse.active = false;
    mouse.from = null;
    mouse.snapTo = null;
    mouse.navFrom = null;
    mouse.laDrag = false;
    mouse.downAt = null;
    setMode(linearMode ? 'LINEAR' : 'IDLE');
  }

  function wireMouse() {
    const canvas = els.scene;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;              // left button only
      if (!renderer || visionOwnsFrame()) return;

      mouse.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };

      /* ---- LINEAR-ALGEBRA MODE: grab a basis tip, else rotate the grid ---- */
      if (linearMode) {
        // Screen-space pick so all three arrows (incl. purple k̂, which points
        // toward the camera in the tilted view) are grabbable.
        const pick = renderer.laPickScreen(e.clientX, e.clientY);
        if (pick !== null && renderer.laGrabBasis(pick)) {
          mouse.laDrag = true;
          setMode('LA_DRAG');
        } else {
          mouse.navFrom = { x: e.clientX, y: e.clientY };
          setMode('NAV');
        }
        return;
      }

      /* ---- DATA-STRUCTURE MODE: on a node → laser link; else → rotate ----- */
      const { hovered } = renderer.raycastScreen(e.clientX, e.clientY);
      if (hovered && renderer.beginLink(hovered)) {
        mouse.active = true;
        mouse.from = hovered;
        mouse.snapTo = null;
        setMode('LASER');
      } else {
        // Empty space → orbit the field (was gesture-only before).
        mouse.navFrom = { x: e.clientX, y: e.clientY };
        setMode('NAV');
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!renderer) return;

      // Hover highlight for LA basis tips even before grabbing.
      if (linearMode && !mouse.laDrag && !mouse.navFrom) {
        renderer.laHighlightBasis(renderer.laPickScreen(e.clientX, e.clientY));
      }

      if (mouse.laDrag) {
        syncMatrixFromRenderer(renderer.laDragScreen(e.clientX, e.clientY));
        return;
      }

      if (mouse.navFrom) {
        // Pixel delta → normalized-screen delta (matches rotateField's units).
        const rect = canvas.getBoundingClientRect();
        const dnx = (e.clientX - mouse.navFrom.x) / rect.width;
        const dny = (e.clientY - mouse.navFrom.y) / rect.height;
        renderer.rotateField(dnx, dny);
        mouse.navFrom = { x: e.clientX, y: e.clientY };
        return;
      }

      if (mouse.active) {
        const { worldPoint } = renderer.raycastScreen(e.clientX, e.clientY);
        if (!worldPoint) return;
        // Auto-aim: is the tip inside a node's magnet radius?
        const target = renderer.magnetTarget(mouse.from, worldPoint);
        if (target) {
          mouse.snapTo = target;
          renderer.snapLinkTo(target);         // pin + locked-green glow
        } else {
          mouse.snapTo = null;
          renderer.updateLink(worldPoint);     // free-flying aiming beam
        }
      }
    });

    // Commit (or discard) on release. Listen on window so a mouseup that lands
    // outside the canvas still resolves the interaction.
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0) return;

      if (mouse.laDrag) {
        syncMatrixFromRenderer(renderer.laReleaseBasis());
        resetMouse();
        return;
      }

      if (mouse.navFrom) {
        // A click that barely moved in empty space = spawn a node (DS mode only).
        const moved = mouse.downAt &&
          Math.hypot(e.clientX - mouse.downAt.x, e.clientY - mouse.downAt.y) > 5;
        if (!linearMode && !moved) {
          const { hovered, worldPoint } = renderer.raycastScreen(e.clientX, e.clientY);
          if (!hovered && worldPoint && !closestNode(worldPoint, SPAWN_MIN_GAP)) {
            engine.addNode(nextValue(), worldPoint);
            setMode('CREATE');
          }
        }
        resetMouse();
        return;
      }

      if (mouse.active) {
        if (mouse.snapTo && mouse.snapTo !== mouse.from) {
          // Magnetically locked onto Node B → permanently commit the edge.
          engine.addEdge(mouse.from, mouse.snapTo, { directed: true, weight: 1 });
        }
        resetMouse();
      }
    });

    // Losing the window (alt-tab, drag-off) should never leave state stuck on.
    window.addEventListener('blur', () => {
      if (mouse.active || mouse.navFrom || mouse.laDrag) resetMouse();
    });

    // Scroll-wheel dolly zoom (works regardless of gesture state). rotateField/
    // zoomCamera share the same lerp targets the two-handed pinch drives.
    canvas.addEventListener('wheel', (e) => {
      if (!renderer) return;
      e.preventDefault();
      // Wheel-up (negative deltaY) = zoom in. Map to the same signed "spread"
      // scalar the pinch zoom uses; small magnitude for a gentle dolly.
      renderer.zoomCamera(-e.deltaY * 0.0015);
    }, { passive: false });
  }

  /* =========================================================================
   * TEXT-BASED STRUCTURAL INPUT → AUTO-LAYOUT
   * -------------------------------------------------------------------------
   * Paste a raw interview test case (tree array or edge list); the engine
   * parses + lays it out and emits, which flows through the normal
   * onChange → setModel path. We also switch the active algorithm to something
   * sensible for the shape so "Build Trace" just works afterward.
   * ====================================================================== */
  const STRUCT_EXAMPLES = {
    tree: '[3, 9, 20, null, null, 15, 7]',
    graph: '[[0,1],[1,2],[2,0],[1,3],[3,4],[2,4]]',
    array: '5, 2, 8, 1, 9, 3, 7',
  };
  // The format the structure panel is currently set to.
  let structFormat = 'tree';

  function setStructStatus(msg, isError) {
    els.structStatus.textContent = msg;
    els.structStatus.classList.toggle('is-error', !!isError);
  }

  function wireStructureInput() {
    // Format tab switching (Binary Tree ↔ Graph / Edges).
    els.structFormatTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      els.structFormatTabs.querySelectorAll('.tab')
        .forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      structFormat = btn.getAttribute('data-format');
      els.structInput.placeholder = STRUCT_EXAMPLES[structFormat];
      setStructStatus(
        structFormat === 'tree' ? 'level-order array, nulls allowed'
          : structFormat === 'graph' ? 'edge list e.g. [[0,1],[1,2]]'
            : 'comma-separated values e.g. 5, 2, 8, 1', false);
    });

    els.btnStructExample.addEventListener('click', () => {
      els.structInput.value = STRUCT_EXAMPLES[structFormat];
    });

    els.btnParseStruct.addEventListener('click', () => {
      const text = els.structInput.value;
      if (!text.trim()) { setStructStatus('input is empty', true); return; }

      stopExecute();
      const res = engine.loadFromText(structFormat, text);
      if (!res.ok) {
        setStructStatus(res.error || 'parse failed', true);
        return;
      }
      setStructStatus(`${res.counts.nodes} nodes · ${res.counts.edges} edges`, false);

      // Pick an algorithm that matches the shape so tracing is meaningful. For
      // the array format, keep the current algorithm if it already consumes a
      // flat value list; otherwise default to quicksort.
      const ARRAY_ALGOS = new Set(['stack', 'queue', 'hashTable', 'heap',
        'quickSort', 'bubbleSort', 'insertionSort']);
      let algo;
      if (structFormat === 'tree') algo = 'bstInsert';
      else if (structFormat === 'graph') algo = 'dfs';
      else algo = ARRAY_ALGOS.has(engine.activeAlgorithm) ? engine.activeAlgorithm : 'quickSort';
      engine.setActiveAlgorithm(algo);
      syncAlgoTab(algo);
      renderCode(algo, -1);
      els.algoBadge.textContent = ALGO_LABELS[algo] || algo;
      updateComplexityBadge(algo);
      syncRecursionMode(algo);
    });
  }

  /** Reflect the active algorithm in the C++ trace tab strip. */
  function syncAlgoTab(algo) {
    const tabs = els.algoTabs.querySelectorAll('.tab');
    tabs.forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-algo') === algo);
    });
  }

  /* =========================================================================
   * LINEAR ALGEBRA GRID TRANSFORMER (3Blue1Brown-style)
   * -------------------------------------------------------------------------
   * A dedicated visualization mode: the 3D stage swaps the data-structure
   * layer for a unit grid + î/ĵ/k̂ basis arrows, and a 3x3 matrix form drives
   * a 2-second animated transform (displayed = M(t) applied to the base grid).
   * Matrices are read/written column-major (data-mx index == THREE.Matrix3
   * element index) so a column of the form == where a basis vector lands.
   * ====================================================================== */

  // Presets, expressed column-major (î-col, ĵ-col, k̂-col). Z is left as the
  // identity axis so these read as clean 2D transforms on the visible grid.
  const LA_PRESETS = {
    rotate90: [0, 1, 0, -1, 0, 0, 0, 0, 1],   // +90° about Z (CCW)
    scale2:   [2, 0, 0, 0, 2, 0, 0, 0, 1],    // uniform 2× in-plane
    shearX:   [1, 0, 0, 1, 1, 0, 0, 0, 1],    // x += y
    reflectX: [1, 0, 0, 0, -1, 0, 0, 0, 1],   // flip across the x-axis
    squash:   [1, 0, 0, 0.5, 0, 0, 0, 0, 1],  // collapse to a line (det 0)
  };

  /** Read the nine matrix cells into a column-major float array. */
  function readMatrixCells() {
    const m = new Array(9).fill(0);
    els.matrixGrid.querySelectorAll('.mx-cell').forEach((cell) => {
      const idx = parseInt(cell.getAttribute('data-mx'), 10);
      const v = parseFloat(cell.value);
      m[idx] = Number.isFinite(v) ? v : 0;
    });
    return m;
  }

  /** Write a column-major array back into the cells (rounded for legibility). */
  function writeMatrixCells(m) {
    els.matrixGrid.querySelectorAll('.mx-cell').forEach((cell) => {
      const idx = parseInt(cell.getAttribute('data-mx'), 10);
      // Trim floating drift from live drags; keep clean integers integer-looking.
      const v = Math.round(m[idx] * 100) / 100;
      cell.value = String(v);
    });
  }

  /** 3x3 determinant (column-major) — shown live; det 0 == squashed space. */
  function det3(m) {
    return (
      m[0] * (m[4] * m[8] - m[5] * m[7]) -
      m[3] * (m[1] * m[8] - m[2] * m[7]) +
      m[6] * (m[1] * m[5] - m[2] * m[4])
    );
  }

  function updateDetBadge(m) {
    const d = det3(m);
    els.linalgDet.textContent = `det ${d.toFixed(2)}`;
    els.linalgDet.classList.toggle('is-error', Math.abs(d) < 1e-6);
  }

  /**
   * Inverse of a column-major 3×3, or null if singular (|det| ~ 0). Returns a
   * column-major array so it drops straight into applyMatrix / the cells.
   */
  function invert3(m) {
    const d = det3(m);
    if (Math.abs(d) < 1e-6) return null;      // singular — no inverse
    const inv = 1 / d;
    // Cofactor / adjugate, transposed, in column-major order.
    const c = [
      (m[4] * m[8] - m[5] * m[7]) * inv,
      (m[2] * m[7] - m[1] * m[8]) * inv,
      (m[1] * m[5] - m[2] * m[4]) * inv,
      (m[5] * m[6] - m[3] * m[8]) * inv,
      (m[0] * m[8] - m[2] * m[6]) * inv,
      (m[2] * m[3] - m[0] * m[5]) * inv,
      (m[3] * m[7] - m[4] * m[6]) * inv,
      (m[1] * m[6] - m[0] * m[7]) * inv,
      (m[0] * m[4] - m[1] * m[3]) * inv,
    ];
    return c;
  }

  /* Undo stack of applied matrices. Each apply pushes the PREVIOUS matrix so
   * Undo animates back to it. Capped so it can't grow without bound. */
  const laHistory = [];
  const LA_HISTORY_MAX = 32;

  function laPushHistory(prevMatrix) {
    laHistory.push(prevMatrix.slice());
    if (laHistory.length > LA_HISTORY_MAX) laHistory.shift();
    updateUndoButton();
  }

  function updateUndoButton() {
    if (els.btnUndoMatrix) els.btnUndoMatrix.disabled = laHistory.length === 0;
  }

  /** Apply a matrix AND record the current one for undo. Central entry point. */
  function applyMatrixTracked(next) {
    if (!renderer) return;
    laPushHistory(readMatrixCells());
    writeMatrixCells(next);
    renderer.applyMatrix(next);
    updateDetBadge(next);
  }

  /* -------------------------------------------------------------------------
   * RECURSION MODE toggling. A recursive algorithm tab auto-enters the
   * visualizer; switching to any other algorithm leaves it. Linear-algebra
   * mode wins over recursion (it fully owns the stage), so we never enter
   * recursion while the grid transformer is active.
   * ---------------------------------------------------------------------- */
  function syncRecursionMode(algo) {
    if (!renderer) return;
    const wantRec = RECURSIVE_ALGOS.has(algo) && !linearMode;
    if (wantRec && !recursionMode) {
      recursionMode = true;
      renderer.enterRecursionMode(recursionView);
      setMode('RECURSION');
      els.hudDesc.textContent =
        'Build & Execute to watch the recursion unfold. Toggle Call Tree / Stack Frames in the Recursion card.';
    } else if (wantRec && recursionMode) {
      // Already in recursion mode — nothing to re-enter.
    } else if (!wantRec && recursionMode) {
      recursionMode = false;
      renderer.exitRecursionMode();
      renderer.resumeAutoOrbit();
      setMode('IDLE');
    }
  }

  function wireRecursion() {
    els.recViewTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn || !renderer) return;
      els.recViewTabs.querySelectorAll('.tab')
        .forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      recursionView = btn.getAttribute('data-recview') === 'stack' ? 'stack' : 'tree';
      els.recStatus.textContent =
        recursionView === 'stack' ? 'stack frames' : 'tree view';
      if (recursionMode) renderer.setRecursionMode(recursionView);
    });
  }

  /* -------------------------------------------------------------------------
   * CUSTOM C++ SANDBOX wiring. Run C++ through JSCPP in a worker (sandbox.js),
   * which streams @VIS commands back into the engine as a replayable trace. The
   * usual Execute / Next / Back / swipe controls then play it, because a sandbox
   * run populates the same algorithmHistory as any built-in algorithm.
   * ---------------------------------------------------------------------- */
  function appendTerminal(text, kind) {
    const line = document.createElement('span');
    line.className = 't-line t-' + (kind || 'out');
    line.textContent = text;
    els.cppTerminal.appendChild(line);
    els.cppTerminal.scrollTop = els.cppTerminal.scrollHeight;
  }

  function setCppStatus(kind, text) {
    els.cppStatus.textContent = text;
    els.cppStatus.classList.toggle('is-error', kind === 'error');
  }

  function enterSandboxStage() {
    // A sandbox run owns the stage like recursion does, but keeps the DS layer
    // visible. Tear down any competing mode first.
    stopExecute();
    if (linearMode) {
      renderer.exitLinearMode();
      els.linalgBody.classList.add('hidden');
      els.linalgModeTabs.querySelectorAll('.tab').forEach((t, i) =>
        t.classList.toggle('active', i === 0));
      linearMode = false;
    }
    if (recursionMode) {
      recursionMode = false;
      renderer.exitRecursionMode();
    }
    sandboxMode = true;
    if (renderer.enterSandboxMode) renderer.enterSandboxMode();
    setMode('C++ SANDBOX');
  }

  /** Leave the sandbox stage (called when switching to another mode). */
  function exitSandboxStage() {
    if (!sandboxMode) return;
    if (sandbox && sandbox.running) sandbox.stop();
    sandboxMode = false;
    if (renderer && renderer.exitSandboxMode) renderer.exitSandboxMode();
    els.btnRunCpp.disabled = false;
    els.btnStopCpp.disabled = true;
  }

  function wireSandbox() {
    if (!window.Sandbox) return;   // sandbox.js failed to load; card stays inert

    sandbox = new window.Sandbox.SandboxEngine({
      engine,
      getRenderer: () => renderer,
      getCode: () =>
        (window.__cppEditor ? window.__cppEditor.getValue() : ''),
      getStdin: () => (els.cppStdin ? els.cppStdin.value : ''),
      getFormat: () => (els.testCaseFormat ? els.testCaseFormat.value : 'raw'),
      hooks: {
        onStatus: (kind, text) => setCppStatus(kind, text),
        onTerminal: (text, kind) => appendTerminal(text, kind),
        onRunStart: () => {
          els.cppTerminal.innerHTML = '';
          els.btnRunCpp.disabled = true;
          els.btnStopCpp.disabled = false;
          enterSandboxStage();
        },
        onRunEnd: (success) => {
          els.btnRunCpp.disabled = false;
          els.btnStopCpp.disabled = true;
          // If the run produced steps, auto-play the already-built history so
          // the graph + stack build up visibly; the user can then scrub with
          // Back/Next. NOT execute() — that would rebuild and wipe the trace.
          if (success && engine.algorithmHistory.length > 0) {
            playExistingHistory();
          }
        },
      },
    });

    els.btnRunCpp.addEventListener('click', () => {
      if (!window.__cppEditorReady) {
        appendTerminal('Editor still loading — try again in a moment.', 'dim');
        return;
      }
      sandbox.run();
    });

    els.btnStopCpp.addEventListener('click', () => {
      sandbox.stop('■ Stopped by user.');
      els.btnRunCpp.disabled = false;
      els.btnStopCpp.disabled = true;
    });

    els.btnCppExample.addEventListener('click', () => {
      if (window.__cppEditor) window.__cppEditor.setValue(EXAMPLE_CPP);
      if (els.cppStdin) els.cppStdin.value = EXAMPLE_STDIN;
      if (els.testCaseFormat) els.testCaseFormat.value = 'raw';
      appendTerminal('Loaded example: recursive Fibonacci. The branching call tree, live args, and return values all draw automatically — no @VIS commands.', 'dim');
    });
  }

  // DEFAULT example: plain mathematical recursion. Nothing is annotated — the
  // debugger reads each fib(n) activation off the call stack, spawns a call-graph
  // node labelled with its argument, draws the parent→child edge, and animates the
  // return value back up the edge when the frame pops. This is the recursion-tree
  // (recursionvisualizer.com-style) view the sandbox is built for. Format = "raw"
  // because there's no data-structure test case to auto-draw; n is read from stdin.
  const EXAMPLE_CPP = `// Recursive Fibonacci — paste it, hit Run, watch the tree branch.
// No @VIS annotations: the call graph, the live argument on each node, and the
// return value bubbling back up the edge are ALL read from the debugger.
#include <iostream>
using namespace std;

int fib(int n) {
    if (n < 2) return n;          // base case → leaf, returns n
    int a = fib(n - 1);           // left child
    int b = fib(n - 2);           // right child
    return a + b;                 // returns up to the caller
}

int main() {
    int n;
    cin >> n;                     // read n from the stdin box
    int result = fib(n);
    cout << "fib(" << n << ") = " << result << endl;
    return 0;
}
`;

  // Default test case for EXAMPLE_CPP: compute fib(5). Bump it to 6–7 for a
  // bushier tree (kept small so the branching stays readable on screen).
  const EXAMPLE_STDIN = `5
`;

  // A second, graph-flavored example: an unannotated recursive DFS. Switch the
  // format selector to "Graph (N nodes, M edges)" and paste an "N M" + edges
  // stdin to use it. Kept here as a reference for the graph-traversal workflow.
  // eslint-disable-next-line no-unused-vars
  const EXAMPLE_CPP_DFS = `// Recursive DFS. Reads "N M" then M edges "u v" from stdin (format = Graph).
// JSCPP has no GLOBAL arrays, so adjacency lives in main() and is passed by ref.
#include <iostream>
using namespace std;

void dfs(int u, int adj[20][20], int deg[20], bool seen[20]) {
    seen[u] = true;
    cout << "@VIS:HIGHLIGHT:" << u << endl;   // light up the visited node
    for (int i = 0; i < deg[u]; i++) {
        int v = adj[u][i];
        if (!seen[v]) dfs(v, adj, deg, seen);
    }
}

int main() {
    int n, m;
    cin >> n >> m;
    int adj[20][20];
    int deg[20];
    bool seen[20];
    for (int i = 0; i < n; i++) { deg[i] = 0; seen[i] = false; }
    for (int k = 0; k < m; k++) {
        int u, v;
        cin >> u >> v;
        adj[u][deg[u]++] = v;
        adj[v][deg[v]++] = u;
    }
    dfs(0, adj, deg, seen);
    cout << "dfs complete" << endl;
    return 0;
}
`;

  // Reset the 2D/3D toggle back to 2D and hide/clear the vector UI. Called on
  // entering and leaving Grid Transform so each visit starts in a clean state.
  function resetLaDimUI() {
    const toggle = els.laDimToggle;
    if (toggle) {
      toggle.querySelectorAll('.dim-btn').forEach((b) =>
        b.classList.toggle('active', b.getAttribute('data-dim') === '2d'));
    }
    if (els.laVecInputs) els.laVecInputs.classList.add('hidden');
    if (els.laVecList) els.laVecList.innerHTML = '';
    if (renderer && renderer.setLinearDimension) renderer.setLinearDimension('2d');
  }

  /* Reset snap / eigen / det toggles, speed, and the undo history so each
   * visit to Grid Transform starts from a clean, predictable state. */
  function resetLaOptions() {
    laHistory.length = 0;
    updateUndoButton();
    if (els.laSnapToggle) els.laSnapToggle.checked = false;
    if (els.laEigenToggle) els.laEigenToggle.checked = false;
    if (els.laDetToggle) els.laDetToggle.checked = false;
    if (els.laSpeed) { els.laSpeed.value = '2'; }
    if (els.laSpeedVal) els.laSpeedVal.textContent = '2.0s';
    if (renderer) {
      if (renderer.setLaSnap) renderer.setLaSnap(false);
      if (renderer.setLaEigen) renderer.setLaEigen(false);
      if (renderer.setLaDet) renderer.setLaDet(false);
      if (renderer.setLaSpeed) renderer.setLaSpeed(2);
    }
  }

  function wireLinearAlgebra() {
    // Mode toggle: Data Structure ↔ Grid Transform.
    els.linalgModeTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn || !renderer) return;
      els.linalgModeTabs.querySelectorAll('.tab')
        .forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');

      const on = btn.getAttribute('data-lamode') === 'on';
      els.linalgBody.classList.toggle('hidden', !on);
      linearMode = on;
      if (on) {
        stopExecute();
        exitSandboxStage();
        // Linear-algebra mode fully owns the stage — tear down recursion first.
        if (recursionMode) {
          recursionMode = false;
          renderer.exitRecursionMode();
        }
        renderer.enterLinearMode();
        // Always start in 2D — reset the toggle + hide the vector panel.
        resetLaDimUI();
        resetLaOptions();
        const m = readMatrixCells();
        renderer.applyMatrix(m);
        updateDetBadge(m);
        setMode('LINEAR');
        els.hudDesc.textContent =
          'Grab î (green) or ĵ (red) and drag to reshape the matrix. Pinch/mouse both work.';
      } else {
        renderer.exitLinearMode();
        resetLaDimUI();
        resetLaOptions();
        renderer.resumeAutoOrbit();
        setMode('IDLE');
        // Coming out of LA mode, re-enter recursion if a recursive algo is live.
        syncRecursionMode(engine.activeAlgorithm);
      }
    });

    els.btnApplyMatrix.addEventListener('click', () => {
      if (!renderer) return;
      applyMatrixTracked(readMatrixCells());
    });

    els.btnResetMatrix.addEventListener('click', () => {
      if (!renderer) return;
      applyMatrixTracked([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    });

    // Live determinant readout as the user edits cells.
    els.matrixGrid.addEventListener('input', () => updateDetBadge(readMatrixCells()));

    // Presets: load the matrix into the form and animate immediately.
    els.linalgPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-mini');
      if (!btn || !renderer) return;
      const preset = LA_PRESETS[btn.getAttribute('data-preset')];
      if (!preset) return;
      applyMatrixTracked(preset.slice());
    });

    // Inverse: animate to M⁻¹, or flash the det badge if singular (no inverse).
    els.btnInvertMatrix.addEventListener('click', () => {
      if (!renderer) return;
      const inv = invert3(readMatrixCells());
      if (!inv) {
        els.linalgDet.classList.add('is-error');
        els.hudDesc.textContent = 'Matrix is singular (det 0) — no inverse exists.';
        return;
      }
      applyMatrixTracked(inv);
    });

    // Undo: animate back to the previously applied matrix.
    els.btnUndoMatrix.addEventListener('click', () => {
      if (!renderer || laHistory.length === 0) return;
      const prev = laHistory.pop();
      writeMatrixCells(prev);
      renderer.applyMatrix(prev);
      updateDetBadge(prev);
      updateUndoButton();
    });

    // Snap-to-integer while dragging basis tips.
    els.laSnapToggle.addEventListener('change', () => {
      if (renderer) renderer.setLaSnap(els.laSnapToggle.checked);
    });

    // Eigenvector overlay toggle.
    els.laEigenToggle.addEventListener('change', () => {
      if (renderer) renderer.setLaEigen(els.laEigenToggle.checked);
    });

    // Determinant area/volume shading toggle.
    els.laDetToggle.addEventListener('change', () => {
      if (renderer) renderer.setLaDet(els.laDetToggle.checked);
    });

    // Animation speed slider (seconds per transition).
    els.laSpeed.addEventListener('input', () => {
      const s = parseFloat(els.laSpeed.value);
      if (renderer) renderer.setLaSpeed(s);
      els.laSpeedVal.textContent = s.toFixed(1) + 's';
    });

    // 2D / 3D toggle: switch the renderer's coordinate stage + reveal vector UI.
    els.laDimToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('.dim-btn');
      if (!btn || !renderer) return;
      const dim = btn.getAttribute('data-dim');
      els.laDimToggle.querySelectorAll('.dim-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderer.setLinearDimension(dim);
      els.laVecInputs.classList.toggle('hidden', dim !== '3d');
      els.hudDesc.textContent = dim === '3d'
        ? 'Insert x/y/z vectors below — apply a matrix and watch them transform in 3D.'
        : 'Grab î (green) or ĵ (red) and drag to reshape the matrix. Pinch/mouse both work.';
    });

    // Add a user vector from the x/y/z fields; append a removable list row.
    els.btnAddVector.addEventListener('click', () => {
      if (!renderer) return;
      const x = parseFloat(els.laVecX.value) || 0;
      const y = parseFloat(els.laVecY.value) || 0;
      const z = parseFloat(els.laVecZ.value) || 0;
      if (x === 0 && y === 0 && z === 0) return;
      const { id, color } = renderer.laAddVector(x, y, z);
      const hex = '#' + color.toString(16).padStart(6, '0');
      const li = document.createElement('li');
      li.innerHTML =
        `<span><span class="vec-swatch" style="background:${hex}"></span>` +
        `(${x}, ${y}, ${z})</span>` +
        `<button class="vec-del" aria-label="remove">×</button>`;
      li.querySelector('.vec-del').addEventListener('click', () => {
        renderer.laRemoveVector(id);
        li.remove();
      });
      els.laVecList.appendChild(li);
    });
  }

  /* =========================================================================
   * Playback & Insight wiring — speed slider + timeline scrubber.
   * ====================================================================== */
  function wireInsight() {
    // Playback speed: update the interval; restart the timer if mid-play.
    els.playSpeed.addEventListener('input', () => {
      execSpeedMs = parseInt(els.playSpeed.value, 10) || 900;
      els.playSpeedVal.textContent = (execSpeedMs / 1000).toFixed(1) + 's';
      restartPlaybackTimer();
    });

    // Timeline scrubber: jump to a step. Scrubbing pauses auto-play so the user
    // stays in control of the position.
    els.stepScrubber.addEventListener('input', () => {
      stopExecute();
      const i = parseInt(els.stepScrubber.value, 10) || 0;
      // If no trace is built yet, build one first so there's something to scrub.
      if (engine.algorithmHistory.length === 0) {
        if (!buildTrace()) return;
      }
      engine.jumpTo(i);
    });

    // Step nudge buttons flanking the scrubber.
    els.btnScrubBack.addEventListener('click', () => { stopExecute(); stepBackward(); });
    els.btnScrubFwd.addEventListener('click', () => { stopExecute(); stepForward(); });
  }

  /* =========================================================================
   * Demo data — seeds a structure appropriate to the active algorithm.
   * ====================================================================== */
  function seedDemoData() {
    stopExecute();
    engine.clear();
    autoValue = 1;
    const algo = engine.activeAlgorithm;

    if (algo === 'linkedListReversal') {
      // A left-to-right chain with directed next pointers.
      const vals = [10, 20, 30, 40];
      const nodes = vals.map((v, i) =>
        engine.addNode(v, { x: -9 + i * 6, y: 0, z: 0 })
      );
      for (let i = 0; i < nodes.length - 1; i++) {
        engine.addEdge(nodes[i].uuid, nodes[i + 1].uuid, { directed: true });
      }
    } else if (algo === 'bstInsert' || algo === 'bstDelete') {
      // Loose scatter of values; the BST trace computes real tree positions.
      const vals = [50, 30, 70, 20, 40, 60, 80];
      vals.forEach((v, i) => {
        const angle = i * 1.1;
        engine.addNode(v, { x: Math.cos(angle) * 7, y: Math.sin(angle) * 4, z: 0 });
      });
    } else if (algo === 'stack' || algo === 'queue' ||
               algo === 'hashTable' || algo === 'heap' ||
               algo === 'quickSort' || algo === 'bubbleSort' ||
               algo === 'insertionSort') {
      // Synthesized structures read a flat value list (the builder lays them
      // out). Seed a row of plain value nodes as the input array.
      const demo = {
        stack: [3, 7, 1, 9],
        queue: [3, 7, 1, 9],
        hashTable: [15, 22, 8, 29, 1],
        heap: [5, 3, 8, 1, 9, 2],
        quickSort: [5, 2, 8, 1, 9, 3, 7],
        bubbleSort: [5, 2, 8, 1, 9, 3],
        insertionSort: [5, 2, 8, 1, 9, 3],
      }[algo];
      demo.forEach((v, i) =>
        engine.addNode(v, { x: -((demo.length - 1) * 1.6) / 2 + i * 1.6, y: 0, z: 0 })
      );
    } else {
      // Graph algorithms (DFS / BFS / Dijkstra): a small weighted graph.
      const vals = [1, 2, 3, 4, 5];
      const nodes = vals.map((v, i) => {
        const angle = (i / vals.length) * Math.PI * 2;
        return engine.addNode(v, { x: Math.cos(angle) * 8, y: Math.sin(angle) * 6, z: 0 });
      });
      const links = [[0, 1, 4], [0, 2, 1], [2, 1, 2], [1, 3, 1], [2, 3, 5], [3, 4, 3]];
      links.forEach(([a, b, w]) =>
        engine.addEdge(nodes[a].uuid, nodes[b].uuid, { directed: true, weight: w })
      );
    }
  }

  /* =========================================================================
   * Boot sequence
   * ====================================================================== */
  function setSplash(msg) { els.splashMsg.textContent = msg; }

  async function boot() {
    wireControls();
    wireMouse();
    wireStructureInput();
    wireLinearAlgebra();
    wireRecursion();
    wireSandbox();
    wireInsight();

    // 1. 3D engine (required). Fail loudly if THREE / Renderer3D missing.
    if (!window.Render3D) {
      setSplash('3D engine failed to load. Check your network / CDN access.');
      return;
    }
    try {
      renderer = new window.Render3D.Renderer3D(els.scene);
      renderer.start();
    } catch (err) {
      console.error('[app] renderer init failed:', err);
      setSplash('WebGL unavailable in this browser.');
      return;
    }

    // Render the initial (empty) code panel.
    renderCode(engine.activeAlgorithm, -1);
    updateComplexityBadge(engine.activeAlgorithm);

    // 2. Speech (optional). Never blocks the lab.
    try {
      speech = new window.Speech.SpeechEngine({
        onCommand: handleVoiceCommand,
        onStatus: setVoiceStatus,
      });
    } catch (err) {
      console.warn('[app] speech unavailable:', err);
    }

    // 3. Vision (optional but core). Requires camera permission.
    setSplash('Requesting camera + loading hand model…');
    try {
      vision = new window.Vision.VisionEngine({
        video: els.webcam,
        overlay: els.overlay,
        onFrame: handleVisionFrame,
        onStatus: (state, detail) => {
          els.visionStatus.textContent = state;
          els.visionStatus.className = 'pill pill-' +
            (state === 'ready' ? 'ready'
              : state === 'error' ? 'error'
              : state === 'loading' ? 'loading' : 'idle');
          if (detail) setSplash(detail);
        },
      });
      await vision.init();
      vision.start();
    } catch (err) {
      console.error('[app] vision init failed:', err);
      // The lab still works with the mouse + manual buttons + (maybe) voice.
      vision = null;
      gesturesEnabled = false;
      els.btnGestureToggle.classList.remove('is-on');
      els.btnGestureToggle.setAttribute('aria-pressed', 'false');
      els.btnGestureToggle.textContent = 'GESTURES · OFF';
      els.hudDesc.textContent =
        'Camera unavailable — use the mouse, manual buttons, and voice commands.';
    }

    // Reveal the lab. Offer an explicit enter button (also unlocks audio/mic
    // autoplay policies on some browsers).
    els.splashEnter.hidden = false;
    setSplash('Ready.');
    els.splashEnter.addEventListener('click', () => {
      els.splash.classList.add('hidden');
      // Seed something so the scene isn't empty on first view.
      if (currentModel.nodes.length === 0) seedDemoData();
    });
  }

  // Kick everything off once the DOM is parsed.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
