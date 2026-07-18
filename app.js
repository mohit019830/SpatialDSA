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
   * Standard-viewport gesture grammar (three distinct execution paths):
   *
   *   1. DOUBLE-PINCH in empty space  → create a node (single pinch never does).
   *   2. SINGLE PINCH on a node mesh  → PATH A: lock + drag that node's XYZ.
   *   3. SINGLE PINCH in empty space  → PATH B: lock the camera; hand delta
   *      pans the whole field (lerp-smoothed inside render3d).
   * ====================================================================== */
  // Interaction modes.
  const MODE = { IDLE: 'IDLE', DRAG_NODE: 'DRAG_NODE', CAMERA: 'CAMERA' };

  // Ghost-node guard: never spawn within this of an existing node.
  const SPAWN_MIN_GAP = 1.5;   // world units

  const gesture = {
    mode: MODE.IDLE,
    dragTarget: null,          // uuid of the node locked for dragging (Path A)
    lastCursor: null,          // {x,y} last normalized cursor (for camera deltas)
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
    setMode('CREATE');
  }

  /* -------------------------------------------------------------------------
   * PATH: SINGLE PINCH-DOWN → contextual lock.
   *   hovered != null → PATH A: lock the node for dragging.
   *   hovered == null → PATH B: lock the camera for panning.
   * The renderer already raycast through the fingertip on the pinch-down edge,
   * so `hovered` is the authoritative mesh-intersection result.
   * ---------------------------------------------------------------------- */
  function onPinchStart(hovered, worldPoint, cursor) {
    if (hovered) {
      gesture.mode = MODE.DRAG_NODE;
      gesture.dragTarget = hovered;
      setMode('DRAG');
    } else {
      gesture.mode = MODE.CAMERA;
      gesture.dragTarget = null;
      gesture.lastCursor = cursor ? { x: cursor.x, y: cursor.y } : null;
      setMode('CAMERA');
    }
  }

  /* -------------------------------------------------------------------------
   * SINGLE PINCH SUSTAINED → drive whichever object we locked onto.
   * ---------------------------------------------------------------------- */
  function onPinchMove(worldPoint, cursor) {
    if (gesture.mode === MODE.DRAG_NODE) {
      // PATH A: node follows the cursor's world position.
      if (gesture.dragTarget && worldPoint) {
        engine.moveNode(gesture.dragTarget, worldPoint);
      }
    } else if (gesture.mode === MODE.CAMERA) {
      // PATH B: translate hand delta into a camera pan. render3d applies the
      // 0.1 lerp so the field glides. Deltas are normalized-screen units.
      if (cursor && gesture.lastCursor) {
        const dnx = cursor.x - gesture.lastCursor.x;
        const dny = cursor.y - gesture.lastCursor.y;
        renderer.panCamera(dnx, dny);
      }
      if (cursor) gesture.lastCursor = { x: cursor.x, y: cursor.y };
    }
  }

  /* -------------------------------------------------------------------------
   * PINCH RELEASE → drop whatever we were holding.
   * ---------------------------------------------------------------------- */
  function onPinchEnd() {
    if (gesture.mode === MODE.CAMERA) {
      // Hand the camera back to the gentle idle auto-orbit.
      renderer.resumeAutoOrbit();
    }
    gesture.mode = MODE.IDLE;
    gesture.dragTarget = null;
    gesture.lastCursor = null;
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

    // Update the mid-air cursor + (gated) raycast hover. Passing evt.pinch lets
    // the renderer restrict expensive raycasts to active-pinch movement.
    let hovered = null, worldPoint = null;
    if (evt.present && evt.cursor) {
      const res = renderer.updateCursor(evt.cursor.x, evt.cursor.y, true, evt.pinch);
      hovered = res.hovered;
      worldPoint = res.worldPoint;
    } else {
      renderer.updateCursor(0, 0, false, false);
      // Lost the hand mid-gesture: release any lock so nothing sticks.
      if (!evt.present && gesture.mode !== MODE.IDLE) onPinchEnd();
    }

    // Pinch edge events fire ONLY on real detection frames (vision.js never
    // emits them on interpolated frames), so the state machine stays stable.
    //
    // Dispatch order matters: a double-pinch also carries a pinchStart edge on
    // its second down, so we handle the double-pinch (node create) FIRST and
    // return, ensuring a single pinch alone can never spawn a node.
    if (evt.doublePinch) {
      onDoublePinch(hovered, worldPoint);
    } else if (evt.pinchStart) {
      onPinchStart(hovered, worldPoint, evt.cursor);
    } else if (evt.pinch) {
      onPinchMove(worldPoint, evt.cursor);
    } else if (evt.pinchEnd) {
      onPinchEnd();
    }

    // Swipes map straight onto trace stepping.
    if (evt.swipe === 'SWIPE_RIGHT') stepForward();
    else if (evt.swipe === 'SWIPE_LEFT') stepBackward();
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
