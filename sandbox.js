/* ===========================================================================
 * sandbox.js — Custom C++ Sandbox
 * ---------------------------------------------------------------------------
 * Runs the user's own C++ through JSCPP and drives the 3D visualizer from it.
 *
 * ARCHITECTURE (debugger-driven, automatic tracing)
 *   The goal: paste a standard algorithm + a test case and watch it run — no
 *   need to sprinkle @VIS: commands through the code. Three pieces make that
 *   happen:
 *
 *   1. AUTO-SETUP. Before running, we read the stdin box + a format selector and
 *      draw the data structure on the canvas using the Phase-2 text parsers:
 *      "Graph (N nodes, M edges)" → sandboxAutoGraph, "Binary Tree Array" →
 *      sandboxLayout('tree'), "Raw Text" → nothing drawn. This becomes step 0.
 *
 *   2. AUTOMATIC EXECUTION TRACE. JSCPP runs in the worker in DEBUG mode. Instead
 *      of run-to-completion, we walk the program node-by-node and read the
 *      current line + call stack at each transition, posting {type:'step'}
 *      snapshots. The main thread feeds these to the engine's recursion tower, so
 *      line highlighting and the 3D stack build/pop happen for free — the same
 *      Execute / Next / Back playback replays it.
 *
 *   3. ONE MANUAL COMMAND. C++ array indices don't map to node uuids, so to light
 *      up a node during traversal the user prints exactly one thing:
 *          cout << "@VIS:HIGHLIGHT:" << nodeId << endl;
 *      That's the only @VIS command in the new model; everything else is stdout.
 *
 *   Why a Worker: JSCPP is synchronous and can spin forever on a bad loop. In a
 *   Blob worker a hung program can't freeze the tab; the main thread arms a hard
 *   terminate() backstop on top of JSCPP's own maxTimeout and the step caps.
 *   The MAIN thread owns all engine mutation — worker messages (steps, stdout)
 *   arrive in execution order and are applied there.
 *
 * REMAINING @VIS COMMAND
 *   @VIS:HIGHLIGHT:<nodeId>   mark a node active during traversal. <nodeId> is a
 *                            vertex id / tree value from the auto-setup id map.
 *
 * CAVEAT (honest note): the call stack is read from JSCPP's UNDOCUMENTED internal
 * runtime (dbg.rt.scope). It's guarded — if that shape changes on a version bump,
 * readStack() returns null and we degrade to line-only tracing rather than crash.
 *
 * JSCPP LIMITS (documented for the user, surfaced in the terminal on error):
 *   JSCPP is an older, unmaintained interpreter. Basic types, arrays, pointers,
 *   references, functions/recursion, structs, and <iostream> cout work. STL
 *   containers (<vector>, <map>, <string> methods, <algorithm>) are largely
 *   unsupported. Author demos with plain arrays + recursion for best results.
 * ======================================================================== */
(function () {
  'use strict';

  // Pinned JSCPP build. The worker importScripts() this exact URL.
  const JSCPP_CDN = 'https://cdn.jsdelivr.net/npm/JSCPP@2.0.2/dist/JSCPP.es5.min.js';

  // Hard wall-clock ceiling. JSCPP's maxTimeout only checks between operations,
  // so a tight empty loop can slip past it — this terminate() is the real guard.
  const HARD_TIMEOUT_MS = 5000;
  const JSCPP_MAXTIMEOUT_MS = 4000;

  // Debugger stepping caps. RAW is every AST node the debugger walks (a single
  // `for` header fires many nodes); EMIT is the coalesced snapshots we actually
  // push to the timeline. Without these an accidental big loop would either hang
  // the worker or flood the history with tens of thousands of steps.
  const MAX_RAW_STEPS = 500000;
  const MAX_EMIT_STEPS = 4000;

  /* ---------------------------------------------------------------------
   * The worker body. Stringified and turned into a Blob URL at runtime so we
   * stay 100% CDN / no-build.
   *
   * DEBUGGER-DRIVEN TRACING (the pivot): instead of JSCPP.run() to completion,
   * we start it in debug mode ({debug:true}) which returns a debugger and breaks
   * on the first node. We then walk the program node-by-node with next(), and on
   * each node read:
   *   • the current line — dbg.nextNode().sLine (1-based; null while entering a
   *     call, so we just skip emitting that tick)
   *   • the call stack — from the UNDOCUMENTED internal runtime dbg.rt.scope,
   *     an array of { $name } frames where functions are named "function <name>".
   *     readStack() is fully guarded: if that shape ever changes (JSCPP bump) it
   *     returns null and the main thread degrades to line-only tracing.
   * We coalesce on a (line + stack) signature so only real transitions become
   * timeline steps, and post each as {type:'step'}. stdout (including any manual
   * @VIS:HIGHLIGHT the user prints) still streams via config.stdio.write, and
   * because both go through the same message queue in execution order, the main
   * thread applies them consistently.
   * ------------------------------------------------------------------ */
  function workerSource(cdnUrl, maxTimeout, maxRaw, maxEmit) {
    return `
      try {
        importScripts(${JSON.stringify(cdnUrl)});
      } catch (e) {
        self.postMessage({ type: 'error', message: 'Failed to load JSCPP from CDN: ' + e.message });
        self.postMessage({ type: 'done' });
      }

      // Read the C++ call stack off JSCPP's internal runtime. Undocumented, so
      // guarded: any deviation from the expected shape returns null → the main
      // thread falls back to line-only tracing instead of crashing.
      function readStack(dbg) {
        try {
          var scope = dbg && dbg.rt && dbg.rt.scope;
          if (!Array.isArray(scope)) return null;
          var out = [];
          for (var i = 0; i < scope.length; i++) {
            var nm = scope[i] && scope[i]['$name'];
            if (typeof nm === 'string' && nm.indexOf('function ') === 0) {
              out.push(nm.slice(9)); // strip "function " → bare C++ function name
            }
          }
          return out;
        } catch (e) { return null; }
      }

      self.onmessage = function (ev) {
        var code = ev.data && ev.data.code;
        if (typeof code !== 'string') return;
        // stdin: raw test-case string fed to cin/scanf/getline.
        var stdin = (ev.data && typeof ev.data.stdin === 'string') ? ev.data.stdin : '';
        var config = {
          stdio: { write: function (s) { self.postMessage({ type: 'stdout', chunk: s }); } },
          debug: true,
          maxTimeout: ${maxTimeout}
        };

        var dbg;
        try {
          dbg = JSCPP.run(code, stdin, config);
        } catch (e) {
          self.postMessage({ type: 'error', message: (e && e.message) ? e.message : String(e) });
          self.postMessage({ type: 'done' });
          return;
        }

        // If this build didn't hand back a debugger, we can't auto-trace. Say so
        // plainly rather than pretending — the manual @VIS path still works via
        // stdout, but there'll be no automatic line/stack steps.
        if (!dbg || typeof dbg.next !== 'function') {
          self.postMessage({ type: 'error', message: 'JSCPP debug mode unavailable in this build — no automatic tracing.' });
          self.postMessage({ type: 'done' });
          return;
        }

        var done = false, raw = 0, emitted = 0, lastSig = null;
        while (raw < ${maxRaw}) {
          var node = null;
          try { node = dbg.nextNode(); } catch (e) { node = null; }
          var line = (node && typeof node.sLine === 'number') ? node.sLine : null;
          var stack = readStack(dbg);

          if (line !== null) {
            var sig = line + '|' + (stack ? stack.join('>') : '?');
            if (sig !== lastSig) {
              self.postMessage({ type: 'step', line: line, stack: stack });
              lastSig = sig;
              if (++emitted >= ${maxEmit}) {
                self.postMessage({ type: 'note', message: 'Step limit (' + ${maxEmit} + ') reached — trace truncated.' });
                break;
              }
            }
          }

          try {
            done = dbg.next();
          } catch (e) {
            self.postMessage({ type: 'error', message: (e && e.message) ? e.message : String(e) });
            break;
          }
          if (done !== false) {            // exit code lives in done.v (may be 0)
            self.postMessage({ type: 'exit', code: (done && typeof done.v === 'number') ? done.v : 0 });
            break;
          }
          raw++;
        }
        if (raw >= ${maxRaw}) {
          self.postMessage({ type: 'error', message: 'Execution exceeded ' + ${maxRaw} + ' steps — terminated (possible infinite loop).' });
        }
        self.postMessage({ type: 'done' });
      };
    `;
  }

  class SandboxEngine {
    /**
     * @param {object} opts
     * @param {DSAEngine} opts.engine   the shared engine instance
     * @param {() => Renderer3D} opts.getRenderer  late-bound renderer accessor
     * @param {() => string} opts.getCode   reads the editor (CodeMirror or textarea)
     * @param {() => string} opts.getStdin  reads the stdin box (test-case input)
     * @param {() => string} opts.getFormat reads the test-case format selector
     *        ('graph' | 'tree' | 'raw')
     * @param {object} opts.hooks   { onStatus, onTerminal, onRunStart, onRunEnd }
     */
    constructor(opts) {
      this.engine = opts.engine;
      this.getRenderer = opts.getRenderer || (() => null);
      this.getCode = opts.getCode;
      this.getStdin = opts.getStdin || (() => '');
      this.getFormat = opts.getFormat || (() => 'raw');
      this.hooks = opts.hooks || {};

      this._worker = null;
      this._timer = null;
      this._lineBuf = '';
      this._idMap = new Map();   // C++ vertex id / tree value -> engine node uuid
      this._cmdCount = 0;        // manual @VIS commands applied
      this._stepCount = 0;       // automatic debugger steps applied
      this._stackDepth = 0;      // current mirrored call-stack depth
      this._running = false;
    }

    get running() { return this._running; }

    /* ---- lifecycle -------------------------------------------------- */

    run() {
      if (this._running) return;
      const code = (this.getCode ? this.getCode() : '') || '';
      if (!code.trim()) {
        this._status('error', 'nothing to run');
        this._term('No C++ source to run.', 'err');
        return;
      }

      // Standard input (test cases). Normalize CRLF → LF so cin/getline see the
      // line breaks JSCPP expects, and guarantee a trailing newline so the final
      // token/line is delimited — otherwise a bare "5" can read short of EOF.
      let stdin = (this.getStdin ? this.getStdin() : '') || '';
      stdin = stdin.replace(/\r\n/g, '\n');
      if (stdin.length && !stdin.endsWith('\n')) stdin += '\n';

      const format = (this.getFormat ? this.getFormat() : 'raw') || 'raw';

      this._running = true;
      this._lineBuf = '';
      this._idMap.clear();
      this._cmdCount = 0;
      this._stepCount = 0;
      this._stackDepth = 0;

      // Prime the engine: reset, show the user's listing, enter sandbox trace.
      this.engine.setSandboxSource(code.split('\n'));
      this.engine.sandboxBegin();

      // Renderer: overlay the stack tower without hiding the graph.
      const r = this.getRenderer();
      if (r && r.enterSandboxMode) r.enterSandboxMode();

      if (this.hooks.onRunStart) this.hooks.onRunStart();
      this._status('loading', 'running…');
      this._term('▶ Running C++ in sandboxed worker (debug trace)…', 'dim');

      if (stdin.length) this._term(`↳ stdin: ${stdin.split('\n').length - 1} line(s) fed to cin.`, 'dim');

      // AUTO-SETUP: draw the test case on the canvas before the program runs, so
      // step 0 already shows the data structure and the id map is ready for any
      // @VIS:HIGHLIGHT the program emits.
      try {
        this._autoSetup(format, stdin);
      } catch (e) {
        this._term('Auto-setup skipped: ' + e.message, 'dim');
      }

      // Spawn the worker.
      try {
        this._spawnWorker(code, stdin);
      } catch (e) {
        this._running = false;
        this._status('error', 'worker failed');
        this._term('Could not start worker: ' + e.message, 'err');
      }
    }

    stop(reason) {
      this._killWorker();
      if (!this._running) return;
      this._running = false;
      if (reason) this._term(reason, 'dim');
      this._status('idle', 'stopped');
      if (this.hooks.onRunEnd) this.hooks.onRunEnd(false);
    }

    /* ---- auto-setup: draw the test case from stdin ------------------ */

    /**
     * Draw the data structure from the stdin test case, using the selected
     * format, BEFORE the program runs. Populates `_idMap` (vertex id / tree
     * value → uuid) so a later @VIS:HIGHLIGHT can resolve nodes, and records the
     * drawing as the first trace step. 'raw' draws nothing (no visualization).
     */
    _autoSetup(format, stdin) {
      const eng = this.engine;
      const mergeMap = (map) => {
        if (!map) return 0;
        let n = 0;
        // Engine returns a Map from sandboxAutoGraph/sandboxLayout.
        const put = (k, v) => { this._idMap.set(String(k), v); n++; };
        if (map instanceof Map) map.forEach((v, k) => put(k, v));
        else for (const k in map) {
          if (Object.prototype.hasOwnProperty.call(map, k)) put(k, map[k]);
        }
        return n;
      };

      if (format === 'graph') {
        // "N M" header, then M lines of "u v" (optional weight w). Parse to
        // explicit count + pairs so isolated nodes still draw.
        const toks = stdin.trim().split(/\s+/).map(Number);
        if (toks.length < 2 || !Number.isFinite(toks[0])) {
          throw new Error('graph format expects "N M" on the first line');
        }
        const n = toks[0], m = toks[1];
        const pairs = [];
        let p = 2;
        for (let k = 0; k < m && p + 1 < toks.length; k++) {
          pairs.push([toks[p++], toks[p++]]);
        }
        const res = eng.sandboxAutoGraph(n, pairs);
        this._idMap.clear();
        mergeMap(res && res.idMap);
        this._term(`↳ auto-drew graph: ${n} node(s), ${pairs.length} edge(s).`, 'dim');
      } else if (format === 'tree') {
        // A LeetCode-style level-order array. Accept either a bracketed array
        // pasted directly or whitespace-separated tokens (nulls as "null"/"#").
        let payload = stdin.trim();
        if (payload && payload[0] !== '[') {
          const toks = payload.split(/\s+/).map((t) =>
            (t === 'null' || t === '#' || t === 'N') ? 'null' : t);
          payload = '[' + toks.join(',') + ']';
        }
        if (!payload) throw new Error('tree format expects a level-order array');
        const map = eng.sandboxLayout('tree', payload);
        this._idMap.clear();
        mergeMap(map);
        this._term('↳ auto-drew binary tree from array.', 'dim');
      }
      // 'raw' → intentionally nothing drawn.
    }

    /* ---- worker plumbing ------------------------------------------- */

    _spawnWorker(code, stdin) {
      const src = workerSource(JSCPP_CDN, JSCPP_MAXTIMEOUT_MS, MAX_RAW_STEPS, MAX_EMIT_STEPS);
      const blob = new Blob([src], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url);
      URL.revokeObjectURL(url);   // safe: the worker keeps running once created
      this._worker = w;

      w.onmessage = (ev) => this._onWorkerMessage(ev.data);
      w.onerror = (err) => {
        this._term('Worker error: ' + (err.message || 'unknown'), 'err');
        this._finish(false);
      };

      // Hard timeout backstop against infinite loops.
      this._timer = setTimeout(() => {
        this._term(`Execution exceeded ${HARD_TIMEOUT_MS}ms — terminated (possible infinite loop).`, 'err');
        this._finish(false);
      }, HARD_TIMEOUT_MS);

      w.postMessage({ code, stdin: stdin || '' });
    }

    _onWorkerMessage(msg) {
      if (!msg || !this._running) return;
      switch (msg.type) {
        case 'step':
          this._applyStep(msg.line, msg.stack);
          break;
        case 'stdout':
          this._ingest(msg.chunk);
          break;
        case 'note':
          this._term(msg.message, 'dim');
          break;
        case 'error':
          this._term(msg.message, 'err');
          break;
        case 'exit':
          if (typeof msg.code === 'number' && msg.code !== 0) {
            this._term('Program returned exit code ' + msg.code, 'dim');
          }
          break;
        case 'done':
          this._flushLine();      // emit any trailing unterminated line
          this._finish(true);
          break;
      }
    }

    /**
     * Apply one automatic debugger step. `line` is 1-based (engine wants 0-based);
     * `stack` is the array of active C++ function names (deepest last), or null if
     * the runtime introspection failed (→ line-only, no stack tower changes).
     *
     * We reconcile our mirrored call-stack depth against the reported one:
     *   deeper  → CALL frames pushed (function entered / recursed)
     *   shallower → RET frames popped (functions returned)
     *   same    → a plain LINE step within the current frame.
     * This is what makes the 3D stack tower build and unwind automatically.
     */
    _applyStep(line, stack) {
      const eng = this.engine;
      const ln = (typeof line === 'number' ? line : 0) - 1; // → 0-based

      if (Array.isArray(stack)) {
        const depth = stack.length;
        if (depth > this._stackDepth) {
          // One CALL per new frame (usually one, but guard for jumps).
          for (let d = this._stackDepth; d < depth; d++) {
            eng.sandboxCall(stack[d] || 'fn', '', ln);
          }
        } else if (depth < this._stackDepth) {
          for (let d = this._stackDepth; d > depth; d--) {
            eng.sandboxReturn('', ln);
          }
        } else {
          eng.sandboxLine(ln, 'Execute line');
        }
        this._stackDepth = depth;
      } else {
        // No stack introspection available — degrade to line highlighting only.
        eng.sandboxLine(ln, 'Execute line');
      }
      this._stepCount++;
    }

    _killWorker() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      if (this._worker) { this._worker.terminate(); this._worker = null; }
    }

    _finish(success) {
      if (!this._running) return;
      this._killWorker();
      this._running = false;

      const steps = this.engine.sandboxEnd();
      if (success) {
        if (steps > 0) {
          const hl = this._cmdCount ? ` · ${this._cmdCount} highlight(s)` : '';
          this._status('ready', `${this._stepCount} steps${hl}`);
          this._term(`✓ Done. Traced ${this._stepCount} execution step(s) into ${steps} frame(s)${hl ? `, ${this._cmdCount} node highlight(s)` : ''}. Use Execute / Next / Back to play it.`, 'ok');
        } else {
          this._status('ready', 'no steps');
          this._term('✓ Program finished but produced no trace steps. If nothing drew, check the format selector matches your stdin.', 'dim');
        }
      } else {
        this._status('error', 'run failed');
      }
      if (this.hooks.onRunEnd) this.hooks.onRunEnd(success);
    }

    /* ---- stdout stream → @VIS parsing ------------------------------ */

    _ingest(chunk) {
      if (!chunk) return;
      this._lineBuf += chunk;
      let nl;
      while ((nl = this._lineBuf.indexOf('\n')) >= 0) {
        const line = this._lineBuf.slice(0, nl);
        this._lineBuf = this._lineBuf.slice(nl + 1);
        this._routeLine(line);
      }
    }

    _flushLine() {
      if (this._lineBuf.length) {
        this._routeLine(this._lineBuf);
        this._lineBuf = '';
      }
    }

    _routeLine(rawLine) {
      const line = rawLine.replace(/\r$/, '');
      const trimmed = line.trim();
      if (trimmed.indexOf('@VIS:') !== 0) {
        // Plain program output.
        if (line.length) this._term(line, 'out');
        return;
      }
      try {
        this._applyVis(trimmed.slice('@VIS:'.length));
      } catch (e) {
        this._term('malformed @VIS ignored: ' + trimmed + '  (' + e.message + ')', 'dim');
      }
    }

    /**
     * Parse and apply one `@VIS:` command body (the text after the prefix).
     * Colon-delimited: CMD[:arg[:arg...]]. Unknown commands are warned + skipped.
     */
    _applyVis(body) {
      const parts = body.split(':');
      const cmd = (parts[0] || '').trim().toUpperCase();
      const eng = this.engine;

      switch (cmd) {
        case 'HIGHLIGHT': {
          // The ONE manual command in the debugger-driven model. Resolve the
          // vertex id / tree value against the auto-setup id map and light it up.
          const id = parts[1] != null ? parts[1].trim() : '';
          if (id === '') throw new Error('HIGHLIGHT needs a node id');
          const uuid = this._idMap.get(id);
          if (!uuid) throw new Error(`HIGHLIGHT: no node with id ${id} (did the format/stdin match?)`);
          eng.sandboxHighlight(uuid);
          this._cmdCount++;
          break;
        }
        case 'LAYOUT': {
          // @VIS:LAYOUT:TREE:<array>  or  @VIS:LAYOUT:GRAPH:<edgelist>
          // The payload can itself contain ':'-free brackets/commas, but rejoin
          // the tail on ':' anyway so we never truncate an exotic string.
          const kind = (parts[1] || '').trim().toUpperCase();
          const payload = parts.slice(2).join(':').trim();
          if (kind !== 'TREE' && kind !== 'GRAPH') {
            throw new Error(`LAYOUT type must be TREE or GRAPH (got "${kind}")`);
          }
          if (payload === '') throw new Error('LAYOUT needs a data string');

          const format = kind === 'TREE' ? 'tree' : 'graph';
          // The engine parses + auto-lays-out and records the FIRST trace step,
          // returning { id -> uuid }. Merge it into _idMap right now, before the
          // next line is routed, so subsequent EDGE/LINE/highlight commands that
          // reference tree values or vertex ids resolve against these nodes.
          const map = eng.sandboxLayout(format, payload);
          let mapped = 0;
          for (const id in map) {
            if (Object.prototype.hasOwnProperty.call(map, id)) {
              this._idMap.set(id, map[id]);
              mapped++;
            }
          }
          this._cmdCount++;
          this._term(`↳ LAYOUT ${kind}: positioned ${mapped} node(s).`, 'dim');
          break;
        }
        case 'NODE': {
          const id = parts[1] != null ? parts[1].trim() : '';
          const valRaw = parts[2] != null ? parts[2].trim() : id;
          if (id === '') throw new Error('NODE needs an id');
          const value = this._num(valRaw, valRaw);
          const uuid = eng.sandboxNode(value);
          this._idMap.set(id, uuid);
          this._cmdCount++;
          break;
        }
        case 'EDGE': {
          const a = parts[1] != null ? parts[1].trim() : '';
          const b = parts[2] != null ? parts[2].trim() : '';
          const ua = this._idMap.get(a);
          const ub = this._idMap.get(b);
          if (!ua || !ub) throw new Error(`EDGE references unknown node id (${a}->${b})`);
          eng.sandboxEdge(ua, ub);
          this._cmdCount++;
          break;
        }
        case 'CALL': {
          const label = parts[1] != null ? parts[1].trim() : 'call';
          const args = parts.slice(2).join(':').trim();
          eng.sandboxCall(label, args);
          this._cmdCount++;
          break;
        }
        case 'RET': {
          const raw = parts.slice(1).join(':').trim();
          eng.sandboxReturn(this._num(raw, raw));
          this._cmdCount++;
          break;
        }
        case 'LINE': {
          const ln = parseInt(parts[1], 10);
          if (Number.isNaN(ln)) throw new Error('LINE needs a number');
          eng.sandboxLine(ln - 1);   // engine lines are 0-based
          this._cmdCount++;
          break;
        }
        default:
          throw new Error('unknown command ' + cmd);
      }
    }

    /* ---- small helpers --------------------------------------------- */

    _num(raw, fallback) {
      if (raw === '' || raw == null) return fallback;
      const n = Number(raw);
      return Number.isNaN(n) ? fallback : n;
    }

    _status(kind, text) {
      if (this.hooks.onStatus) this.hooks.onStatus(kind, text);
    }

    _term(text, kind) {
      if (this.hooks.onTerminal) this.hooks.onTerminal(text, kind || 'out');
    }
  }

  window.Sandbox = { SandboxEngine };
})();
