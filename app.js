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
  };

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
  };

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
  };

  /* =========================================================================
   * C++ syntax highlighting (lightweight tokenizer)
   * ====================================================================== */
  const CPP_KEYWORDS = new Set([
    'if', 'else', 'while', 'for', 'return', 'new', 'continue', 'break',
    'nullptr', 'true', 'false', 'void', 'struct', 'class',
  ]);
  const CPP_TYPES = new Set(['int', 'Node', 'stack', 'bool', 'float', 'double', 'auto']);

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
    if (gesture.mode === MODE.DRAG_NODE || gesture.mode === MODE.ROTATE) {
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

  /* =========================================================================
   * Trace control (shared by buttons, swipes, and voice)
   * ====================================================================== */
  function buildTrace() {
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
      }, 900);
    });
  }
  function stopExecute() {
    if (executeTimer) { clearInterval(executeTimer); executeTimer = null; }
  }

  function clearAll() {
    stopExecute();
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
      engine.setActiveAlgorithm(algo);
      // Re-render the source immediately (engine._resetTrace emits nothing here).
      renderCode(algo, -1);
      els.algoBadge.textContent = ALGO_LABELS[algo] || algo;
    });

    els.voiceToggle.addEventListener('click', () => {
      if (!speech) return;
      const on = speech.toggle();
      els.voiceToggle.textContent = on ? 'disable' : 'enable';
    });
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
    return gesture.mode === MODE.DRAG_NODE ||
           gesture.mode === MODE.ROTATE ||
           gesture.mode === MODE.ZOOM ||
           gesture.mode === MODE.LINK;
  }

  function wireMouse() {
    const canvas = els.scene;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;              // left button only
      if (!renderer || visionOwnsFrame()) return;

      const { hovered } = renderer.raycastScreen(e.clientX, e.clientY);
      if (!hovered) return;                    // must start ON a node

      if (renderer.beginLink(hovered)) {
        mouse.active = true;
        mouse.from = hovered;
        mouse.snapTo = null;
        setMode('LASER');
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!mouse.active || !renderer) return;

      const { worldPoint } = renderer.raycastScreen(e.clientX, e.clientY);
      if (!worldPoint) return;

      // Auto-aim: is the tip inside a node's magnet radius?
      const target = renderer.magnetTarget(mouse.from, worldPoint);
      if (target) {
        mouse.snapTo = target;
        renderer.snapLinkTo(target);           // pin + locked-green glow
      } else {
        mouse.snapTo = null;
        renderer.updateLink(worldPoint);       // free-flying aiming beam
      }
    });

    // Commit (or discard) on release. Listen on window so a mouseup that lands
    // outside the canvas still resolves the beam.
    window.addEventListener('mouseup', (e) => {
      if (!mouse.active) return;
      if (e.button !== 0) return;

      if (mouse.snapTo && mouse.snapTo !== mouse.from) {
        // Magnetically locked onto Node B → permanently commit the edge.
        engine.addEdge(mouse.from, mouse.snapTo, { directed: true, weight: 1 });
      }
      // Whether committed (solidified via setModel) or released in open air,
      // tear the temporary beam down.
      renderer.endLink();
      mouse.active = false;
      mouse.from = null;
      mouse.snapTo = null;
      setMode('IDLE');
    });

    // Losing the window (alt-tab, drag-off) should never leave a beam stuck on.
    window.addEventListener('blur', () => {
      if (!mouse.active) return;
      renderer.endLink();
      mouse.active = false;
      mouse.from = null;
      mouse.snapTo = null;
      setMode('IDLE');
    });
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
      setStructStatus(structFormat === 'tree'
        ? 'level-order array, nulls allowed'
        : 'edge list e.g. [[0,1],[1,2]]', false);
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

      // Pick an algorithm that matches the shape so tracing is meaningful.
      const algo = structFormat === 'tree' ? 'bstInsert' : 'dfs';
      engine.setActiveAlgorithm(algo);
      syncAlgoTab(algo);
      renderCode(algo, -1);
      els.algoBadge.textContent = ALGO_LABELS[algo] || algo;
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

  /** Write a column-major float array back into the nine cells. */
  function writeMatrixCells(m) {
    els.matrixGrid.querySelectorAll('.mx-cell').forEach((cell) => {
      const idx = parseInt(cell.getAttribute('data-mx'), 10);
      cell.value = String(m[idx]);
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
      if (on) {
        stopExecute();
        renderer.enterLinearMode();
        const m = readMatrixCells();
        renderer.applyMatrix(m);
        updateDetBadge(m);
        setMode('LINEAR');
      } else {
        renderer.exitLinearMode();
        renderer.resumeAutoOrbit();
        setMode('IDLE');
      }
    });

    els.btnApplyMatrix.addEventListener('click', () => {
      if (!renderer) return;
      const m = readMatrixCells();
      renderer.applyMatrix(m);
      updateDetBadge(m);
    });

    els.btnResetMatrix.addEventListener('click', () => {
      if (!renderer) return;
      const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      writeMatrixCells(I);
      renderer.applyMatrix(I);
      updateDetBadge(I);
    });

    // Live determinant readout as the user edits cells.
    els.matrixGrid.addEventListener('input', () => updateDetBadge(readMatrixCells()));

    // Presets: load the matrix into the form and animate immediately.
    els.linalgPresets.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-mini');
      if (!btn || !renderer) return;
      const preset = LA_PRESETS[btn.getAttribute('data-preset')];
      if (!preset) return;
      writeMatrixCells(preset);
      renderer.applyMatrix(preset);
      updateDetBadge(preset);
    });
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
    } else {
      // Graph algorithms (DFS / Dijkstra): a small weighted graph.
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
      // The lab still works with manual buttons + (maybe) voice.
      els.hudDesc.textContent =
        'Camera unavailable — use the manual controls and voice commands.';
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
