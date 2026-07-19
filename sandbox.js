/* ===========================================================================
 * sandbox.js — Custom C++ Sandbox
 * ---------------------------------------------------------------------------
 * Runs the user's own C++ through JSCPP and drives the 3D visualizer from it.
 *
 * ARCHITECTURE
 *   • JSCPP is synchronous and can spin forever on a bad loop. So it runs inside
 *     a Web Worker built on the fly from a Blob — a hung program can never
 *     freeze the tab, and the main thread arms a hard terminate() backstop on
 *     top of JSCPP's own maxTimeout (which only fires between operations).
 *   • The worker captures everything the program writes to stdout via
 *     config.stdio.write and streams it back chunk by chunk.
 *   • The MAIN thread owns all engine mutation. It line-buffers the stream and
 *     routes each line: `@VIS:...` commands become engine trace snapshots, and
 *     everything else prints verbatim to the terminal. Keeping engine access on
 *     the main thread means the whole existing playback machine (Execute / Next
 *     / Back / swipe) replays a sandbox run for free.
 *
 * THE @VIS PROTOCOL  (emit these from C++ with cout)
 *   @VIS:NODE:<id>:<value>      create a node; <id> is your own integer handle
 *   @VIS:EDGE:<idA>:<idB>       connect two previously-created nodes (directed)
 *   @VIS:CALL:<label>:<args>    push a call frame (stack tower grows)
 *   @VIS:RET:<value>            pop the top call frame (unwinds)
 *   @VIS:LINE:<lineNumber>      highlight a 1-based source line
 *   @VIS:LAYOUT:TREE:<array>    bulk-build a LeetCode tree, e.g.
 *                               @VIS:LAYOUT:TREE:[3,9,20,null,null,15,7]
 *   @VIS:LAYOUT:GRAPH:<edges>   bulk-build a graph from an edge list, e.g.
 *                               @VIS:LAYOUT:GRAPH:[[0,1],[1,2],[2,0]]
 * The <id>→uuid mapping lives here (per design): the engine keys nodes by uuid,
 * the sandbox translates your integer ids onto them.
 *
 * MACRO LAYOUTS pass the raw test-case string straight to the engine's parser +
 * auto-layout (tree grid / force-directed graph). The engine mints the nodes and
 * hands back the id→uuid map, which we splice into `_idMap` SYNCHRONOUSLY before
 * the next line is routed — so any following @VIS:EDGE / LINE / node-scoped
 * command that names a tree value or vertex id resolves against the laid-out
 * structure. A layout is recorded as the first trace step, so playback opens on
 * the fully-positioned data structure.
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

  /* ---------------------------------------------------------------------
   * The worker body. Stringified and turned into a Blob URL at runtime so we
   * stay 100% CDN / no-build. It imports JSCPP, runs the code, and posts back
   * `stdout` chunks, a terminal `error`, and a final `done`.
   * ------------------------------------------------------------------ */
  function workerSource(cdnUrl, maxTimeout) {
    return `
      self.__done = false;
      try {
        importScripts(${JSON.stringify(cdnUrl)});
      } catch (e) {
        self.postMessage({ type: 'error', message: 'Failed to load JSCPP from CDN: ' + e.message });
        self.postMessage({ type: 'done' });
      }
      self.onmessage = function (ev) {
        var code = ev.data && ev.data.code;
        if (typeof code !== 'string') return;
        var config = {
          stdio: { write: function (s) { self.postMessage({ type: 'stdout', chunk: s }); } },
          maxTimeout: ${maxTimeout}
        };
        try {
          var ret = JSCPP.run(code, '', config);
          self.postMessage({ type: 'exit', code: ret });
        } catch (e) {
          self.postMessage({ type: 'error', message: (e && e.message) ? e.message : String(e) });
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
     * @param {object} opts.hooks   { onStatus, onTerminal, onRunStart, onRunEnd }
     */
    constructor(opts) {
      this.engine = opts.engine;
      this.getRenderer = opts.getRenderer || (() => null);
      this.getCode = opts.getCode;
      this.hooks = opts.hooks || {};

      this._worker = null;
      this._timer = null;
      this._lineBuf = '';
      this._idMap = new Map();   // C++ integer id -> engine node uuid
      this._cmdCount = 0;
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

      this._running = true;
      this._lineBuf = '';
      this._idMap.clear();
      this._cmdCount = 0;

      // Prime the engine: reset, show the user's listing, enter sandbox trace.
      this.engine.setSandboxSource(code.split('\n'));
      this.engine.sandboxBegin();

      // Renderer: overlay the stack tower without hiding the graph.
      const r = this.getRenderer();
      if (r && r.enterSandboxMode) r.enterSandboxMode();

      if (this.hooks.onRunStart) this.hooks.onRunStart();
      this._status('loading', 'running…');
      this._term('▶ Running C++ in sandboxed worker…', 'dim');

      // Spawn the worker.
      try {
        this._spawnWorker(code);
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

    /* ---- worker plumbing ------------------------------------------- */

    _spawnWorker(code) {
      const src = workerSource(JSCPP_CDN, JSCPP_MAXTIMEOUT_MS);
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

      w.postMessage({ code });
    }

    _onWorkerMessage(msg) {
      if (!msg || !this._running) return;
      switch (msg.type) {
        case 'stdout':
          this._ingest(msg.chunk);
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
          this._status('ready', `${this._cmdCount} @VIS cmds · ${steps} steps`);
          this._term(`✓ Done. Parsed ${this._cmdCount} @VIS command(s) into ${steps} step(s). Use Execute / Next / Back to play it.`, 'ok');
        } else {
          this._status('ready', 'no @VIS output');
          this._term('✓ Program finished but emitted no @VIS commands. Add cout << "@VIS:..." lines to drive the visualizer.', 'dim');
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
