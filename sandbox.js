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

  // Pinned JSCPP build. The worker importScripts() this EXACT URL — do not float
  // to a version range or @latest. The automatic Stack Tower depends on JSCPP's
  // undocumented internal runtime shape (rt.scope, frames named "function <name>"),
  // which is only verified against 2.0.2. A minor bump can silently change it, at
  // which point readStack() degrades to line-only tracing (no tower). Keep the
  // version string and the assert in the worker in lockstep if you ever re-pin.
  const JSCPP_VERSION = '2.0.2';
  const JSCPP_CDN = `https://cdn.jsdelivr.net/npm/JSCPP@${JSCPP_VERSION}/dist/JSCPP.es5.min.js`;

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

      // Stringify one JSCPP variable cell {t,v} to a short display value, or null
      // if it isn't worth showing (function pointers, streams, aggregates). NOTE:
      // makeValueString returns a NUMBER for int/double cells, so we String()-coerce
      // rather than reject non-strings — that was the bug that blanked every value.
      function valStr(rt, val) {
        try {
          var ts = rt.makeTypeString(val.t);
          if (typeof ts === 'string' && ts.indexOf('(*f)') >= 0) return null; // fn ptr
          var s = rt.makeValueString(val);
          if (s == null) return null;
          s = String(s);
          if (s === '<object>') return null; // cin/cout/endl and other opaque objects
          return s.length > 40 ? s.slice(0, 39) + '…' : s;
        } catch (e) { return null; }
      }

      // Read the C++ call stack + per-frame variables off JSCPP's internal runtime
      // (dbg.rt.scope). Undocumented and guarded: any deviation returns null → the
      // main thread degrades to line-only tracing instead of crashing.
      //
      // Scope layout (verified against JSCPP 2.0.2): rt.scope is an array, bottom
      // (global) → top. A "function <name>" scope opens a call frame; its own cell
      // holds the ARGUMENTS, and the block scopes that follow it (CompoundStatement,
      // SelectionStatement_if, IterationStatement_for, …) hold that frame's LOCALS —
      // until the next "function <name>" opens the child frame. We fold all those
      // into the current frame. Returns [{label, vars:[{name,value}]}] bottom→top.
      function readFrames(dbg) {
        try {
          var rt = dbg && dbg.rt;
          var scope = rt && rt.scope;
          if (!Array.isArray(scope)) return null;
          var frames = [];
          var cur = null;
          for (var i = 0; i < scope.length; i++) {
            var sc = scope[i];
            var nm = sc && sc['$name'];
            if (typeof nm === 'string' && nm.indexOf('function ') === 0) {
              cur = { label: nm.slice(9), vars: [] };
              frames.push(cur);
            }
            if (!cur) continue; // skip the global scope's builtins (cin/cout/funcs)
            for (var key in sc) {
              if (key === '$name') continue;
              var val = sc[key];
              if (val && typeof val === 'object' && ('t' in val) && ('v' in val)) {
                var vs = valStr(rt, val);
                if (vs === null) continue;
                var dup = false;
                for (var d = 0; d < cur.vars.length; d++) {
                  if (cur.vars[d].name === key) { dup = true; break; }
                }
                if (!dup) cur.vars.push({ name: key, value: vs });
              }
            }
          }
          return frames;
        } catch (e) { return null; }
      }

      // Count active C++ function frames (the "call depth"). main == 1.
      function funcDepth(dbg) {
        try {
          var scope = dbg && dbg.rt && dbg.rt.scope;
          if (!Array.isArray(scope)) return 0;
          var d = 0;
          for (var i = 0; i < scope.length; i++) {
            var nm = scope[i] && scope[i]['$name'];
            if (typeof nm === 'string' && nm.indexOf('function ') === 0) d++;
          }
          return d;
        } catch (e) { return 0; }
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

        // Probe the undocumented scope shape ONCE up front so the user gets an
        // early, explicit signal on the first run: readFrames returns [] (readable,
        // no function frames yet) when the internal shape is intact, or null when
        // it isn't. null → the Stack Tower won't build; we degrade to line-only.
        if (readFrames(dbg) === null) {
          self.postMessage({ type: 'note', message: 'Stack introspection unavailable (JSCPP internals changed?) — tracing lines only, no Stack Tower.' });
        }

        // RETURN-VALUE CAPTURE. The debugger's public stepping (next/nextNode)
        // swallows the value a function returns — dbg.next() just yields false
        // until the whole program ends. The ONE reliable interception point
        // (verified against 2.0.2) is the return-statement visitor itself, which
        // evaluates to ["return", {t,v}] the instant the value is computed. We wrap
        // it and push each value onto a FIFO. Returns fire innermost-first — the
        // same order frames pop — so the main thread consumes the queue one value
        // per detected pop and the two stay aligned. Guarded: if the visitor table
        // isn't shaped as expected, we simply capture nothing (bubbles show blank).
        var retQueue = [];      // captured return values, oldest first
        try {
          var interp = dbg.rt && dbg.rt.interp;
          var vis = interp && interp.visitors;
          if (vis && typeof vis.JumpStatement_return === 'function') {
            var origRet = vis.JumpStatement_return;
            vis.JumpStatement_return = function* (i2, s2, p2) {
              var r = yield* origRet.call(this, i2, s2, p2);
              try {
                if (r && r.length && r[0] === 'return' && r[1] && ('t' in r[1])) {
                  var vs = valStr(dbg.rt, r[1]);
                  retQueue.push(vs === null ? '' : vs);
                } else if (r && r[0] === 'return') {
                  retQueue.push('');   // void return — still a pop
                }
              } catch (e) {}
              return r;
            };
          }
        } catch (e) { /* no capture; bubbles will be blank but tree still builds */ }

        // Signature of a frame list, used to coalesce steps: emit a new snapshot
        // only when the line, the call depth, OR any visible variable changed —
        // so assignments like "int a = …" produce a step even on the same line.
        function framesSig(frames) {
          if (!frames) return '?';
          var parts = [];
          for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            var vs = [];
            for (var j = 0; j < f.vars.length; j++) vs.push(f.vars[j].name + '=' + f.vars[j].value);
            parts.push(f.label + '(' + vs.join(',') + ')');
          }
          return parts.join('>');
        }

        var done = false, raw = 0, emitted = 0, lastSig = null;
        while (raw < ${maxRaw}) {
          var node = null;
          try { node = dbg.nextNode(); } catch (e) { node = null; }
          var line = (node && typeof node.sLine === 'number') ? node.sLine : null;
          var frames = readFrames(dbg);

          if (line !== null && line > 0) {
            var sig = line + '|' + framesSig(frames);
            if (sig !== lastSig) {
              // Hand over any return values captured since the last emitted step,
              // in fire order (innermost-first = pop order). The main thread pairs
              // them with the pops it detects from the depth drop.
              var returns = retQueue;
              retQueue = [];
              self.postMessage({ type: 'step', line: line, frames: frames, returns: returns });
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
      this._stackNames = [];     // last-seen frame names (to name popped frames)
      this._lastFrames = [];     // last-seen full frame snapshot (label + vars)
      this._lastReturn = null;   // best-effort return value for the next pop
      this._retQueue = [];       // captured return values awaiting their pops (FIFO)
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
      this._stackNames = [];
      this._lastFrames = [];
      this._retQueue = [];

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
          this._applyStep(msg.line, msg.frames, msg.returns);
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
     * `frames` is the live C++ call stack bottom→top, each {label, vars:[{name,
     * value}]}, or null if runtime introspection failed (→ line-only, no tower).
     * `returns` is the FIFO of return values captured by the worker since the last
     * step, in fire order (innermost-first = pop order), so we consume one per
     * detected pop and the value lands on the frame that actually returned.
     *
     * We reconcile our mirrored stack against the reported frames:
     *   deeper   → CALL frames pushed (function entered / recursed), seeded with
     *              that frame's current variables so the node label + face show them.
     *   shallower→ RET frames popped; each pop consumes one captured return value,
     *              which colors the returning node "resolved" and rides the return
     *              bubble up its edge to the parent.
     *   same     → a LINE step; we re-sync the TOP frame's variables (so an
     *              assignment such as `int a = …` updates the visible face) and
     *              highlight the current source line.
     * This is what drives the automatic recursion TREE (call graph) + stack tower,
     * with live variable values and real return bubbles — no @VIS annotations.
     */
    _applyStep(line, frames, returns) {
      const eng = this.engine;
      const ln = (typeof line === 'number' ? line : 0) - 1; // → 0-based
      const oneBased = (typeof line === 'number') ? line : null;

      if (!Array.isArray(frames)) {
        // No introspection available — degrade to line highlighting only.
        eng.sandboxLine(ln, 'Execute line');
        this._stepCount++;
        return;
      }

      // Queue any return values that arrived with this step; consumed per pop.
      if (Array.isArray(returns) && returns.length) {
        for (const rv of returns) this._retQueue.push(rv);
      }

      const depth = frames.length;

      if (depth > this._stackDepth) {
        // Enter one CALL per new frame. Label it with a compact signature built
        // from its current variables (the bound args at entry). That label becomes
        // the call-graph NODE caption (e.g. "fib(3)"); parentId/depth are set by
        // the engine so the tree lays out top-down and edges connect parent→child.
        for (let d = this._stackDepth; d < depth; d++) {
          const f = frames[d] || { label: 'fn', vars: [] };
          const vars = f.vars || [];
          const sig = this._signature(f.label, vars);
          eng.emitCallEnter(ln, sig, [], vars.slice(), `Call ${sig}`);
          this._traceDepth('call', d + 1, sig, oneBased);
        }
      } else if (depth < this._stackDepth) {
        // Pop returned frames, consuming one captured return value per pop (FIFO,
        // innermost-first). The engine marks the node resolved + fires the bubble.
        for (let d = this._stackDepth; d > depth; d--) {
          const retVal = this._retQueue.length ? this._retQueue.shift() : '';
          eng.sandboxReturn(retVal, ln);
          const name = this._stackNames[d - 1] || 'fn';
          this._traceDepth('return', d, name, oneBased, retVal);
        }
        // After popping, refresh the now-top frame's variables (a return usually
        // just assigned into the caller, e.g. `int a = fib(...)`).
        this._syncTop(frames, ln);
      } else {
        // Same depth: re-sync the top frame's variables and highlight the line.
        this._syncTop(frames, ln);
      }

      this._stackDepth = depth;
      this._stackNames = frames.map((f) => f.label);
      // Remember the top frame's variable snapshot so the next pop can reference it.
      this._lastFrames = frames.map((f) => ({ label: f.label, vars: (f.vars || []).slice() }));
      this._stepCount++;
    }

    /**
     * Re-sync the current top-of-stack frame's variables into the engine and
     * highlight `line`. Uses emitLineHighlight's localsPatch so newly-appeared
     * locals (an assignment mid-function) show up on the frame face immediately.
     */
    _syncTop(frames, ln) {
      const top = frames[frames.length - 1];
      const patch = top && top.vars ? top.vars.slice() : [];
      this.engine.emitLineHighlight(ln, 'Execute line', patch);
    }

    /** Build a compact call signature like "fib(n=4)" from a frame's variables. */
    _signature(label, vars) {
      if (!vars || !vars.length) return `${label}()`;
      const inner = vars.map((v) => `${v.name}=${v.value}`).join(', ');
      const sig = `${label}(${inner})`;
      return sig.length > 48 ? `${label}(…)` : sig;
    }

    /**
     * Trace-depth indicator: prints a call/return line to the terminal on every
     * stack transition, indented to match depth, so the Stack Tower's build/unwind
     * rhythm is easy to sanity-check against the 3D scene while testing.
     *   depth 1  → enter main
     *     depth 2  → enter dfs        @ L10
     *     depth 2  ← return dfs       @ L18
     *   depth 1  ← return main
     */
    _traceDepth(kind, depth, name, line, retVal) {
      const indent = '  '.repeat(Math.max(0, depth - 1));
      const arrow = kind === 'call' ? '→ enter ' : '← return ';
      const at = (typeof line === 'number') ? `  @ L${line}` : '';
      const rv = (kind === 'return' && retVal !== undefined && retVal !== '')
        ? `  ⇒ ${retVal}` : '';
      this._term(`${indent}${arrow}${name}  ·depth ${depth}${at}${rv}`, 'dim');
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
