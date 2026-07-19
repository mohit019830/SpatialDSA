/**
 * dsaEngine.js
 * ---------------------------------------------------------------------------
 * Algorithmic Logic & Memory State Machine.
 *
 * This module is the single source of truth for the "scene model" — a flat,
 * serializable description of every node and edge that render3d.js draws.
 *
 * The crucial component here is the RECURSION TRACKER: instead of relying on
 * native JavaScript call-stack recursion (which we cannot pause, rewind, or
 * inspect), every algorithm is expressed as an explicit step generator. Each
 * step pushes a *deep-cloned snapshot* of the entire scene model plus the
 * highlighted C++ source line onto `algorithmHistory`. Stepping backward is
 * therefore a pure, lossless restore of a previous moment in time.
 *
 * The model shape (the contract shared with render3d.js and app.js):
 *
 *   model = {
 *     nodes: [{ uuid, value, position:{x,y,z}, state }],
 *     edges: [{ uuid, from, to, directed, state }],
 *   }
 *
 * `state` is a semantic string ('default' | 'active' | 'visited' | 'path' |
 * 'added' | 'compare' | 'removed'); render3d maps it to a color. Keeping color
 * decisions out of the engine keeps the logic layer purely about data.
 * ---------------------------------------------------------------------------
 */

'use strict';

/* ===========================================================================
 * 0. Small utilities
 * ======================================================================== */

/** RFC4122-ish v4 uuid. Uses crypto when available, falls back gracefully. */
function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older / insecure contexts.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Structured deep clone. Prefers the native structuredClone (fast, correct),
 * falls back to JSON round-tripping which is sufficient for our plain-object
 * model (no functions, dates, or cyclic refs live inside a model snapshot).
 */
function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch (_e) {
      /* fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(obj));
}

/* ===========================================================================
 * 1. Explicit data-structure node classes
 * ======================================================================== */

/** A singly linked list node with an explicit visual uuid. */
class LinkedListNode {
  constructor(value) {
    this.value = value;
    this.next = null;         // reference to another LinkedListNode
    this.uuid = generateUUID();
  }
}

/** A binary-search-tree node carrying its own spatial coordinates. */
class BSTNode {
  constructor(value) {
    this.value = value;
    this.left = null;
    this.right = null;
    this.parent = null;
    this.uuid = generateUUID();
    // Explicit coordinates so the layout survives cloning/replay.
    this.x = 0;
    this.y = 0;
    this.z = 0;
  }
}

/**
 * A weighted graph backed by an explicit adjacency-list Map.
 * adjacency: Map<nodeId, Array<{ to:nodeId, weight:number, edgeId:string }>>
 */
class Graph {
  constructor() {
    this.adjacency = new Map();
    this.directed = false;
  }

  addVertex(id) {
    if (!this.adjacency.has(id)) this.adjacency.set(id, []);
  }

  addEdge(from, to, weight = 1, edgeId = generateUUID()) {
    this.addVertex(from);
    this.addVertex(to);
    this.adjacency.get(from).push({ to, weight, edgeId });
    if (!this.directed) {
      this.adjacency.get(to).push({ to: from, weight, edgeId });
    }
  }

  neighbors(id) {
    return this.adjacency.get(id) || [];
  }
}

/* ===========================================================================
 * 2. C++ source listings (kept beside the algorithms that trace them)
 *
 * Each listing is an array of lines. Trace steps reference lines by index so
 * the UI can highlight exactly one line at a time. Line 0 is intentionally a
 * signature/opening line so a "before we start" step can point at it.
 * ======================================================================== */

const CPP_SOURCES = {
  linkedListReversal: [
    'Node* reverse(Node* head) {',
    '    Node* prev = nullptr;',
    '    Node* curr = head;',
    '    while (curr != nullptr) {',
    '        Node* next = curr->next;',
    '        curr->next = prev;',
    '        prev = curr;',
    '        curr = next;',
    '    }',
    '    return prev;',
    '}',
  ],

  bstInsert: [
    'Node* insert(Node* root, int key) {',
    '    if (root == nullptr)',
    '        return new Node(key);',
    '    if (key < root->value)',
    '        root->left  = insert(root->left, key);',
    '    else if (key > root->value)',
    '        root->right = insert(root->right, key);',
    '    return root;',
    '}',
  ],

  bstDelete: [
    'Node* remove(Node* root, int key) {',
    '    if (root == nullptr) return root;',
    '    if (key < root->value)',
    '        root->left  = remove(root->left, key);',
    '    else if (key > root->value)',
    '        root->right = remove(root->right, key);',
    '    else {',
    '        if (!root->left)  return root->right;',
    '        if (!root->right) return root->left;',
    '        Node* succ = minValue(root->right);',
    '        root->value = succ->value;',
    '        root->right = remove(root->right, succ->value);',
    '    }',
    '    return root;',
    '}',
  ],

  dfs: [
    'void dfs(int start) {',
    '    stack<int> st;  st.push(start);',
    '    while (!st.empty()) {',
    '        int u = st.top(); st.pop();',
    '        if (visited[u]) continue;',
    '        visited[u] = true;   // backtrack point',
    '        for (int v : adj[u])',
    '            if (!visited[v])',
    '                st.push(v);',
    '    }',
    '}',
  ],

  dijkstra: [
    'void dijkstra(int src) {',
    '    dist.assign(n, INF); dist[src] = 0;',
    '    priority_queue<Pair> pq; pq.push({0, src});',
    '    while (!pq.empty()) {',
    '        auto [d, u] = pq.top(); pq.pop();',
    '        if (d > dist[u]) continue;',
    '        for (auto [v, w] : adj[u]) {',
    '            if (dist[u] + w < dist[v]) {',
    '                dist[v] = dist[u] + w;',
    '                pq.push({dist[v], v});',
    '            }',
    '        }',
    '    }',
    '}',
  ],

  fibonacci: [
    'int fib(int n) {',
    '    if (n <= 1)',
    '        return n;              // base case',
    '    return fib(n - 1) + fib(n - 2);',
    '}',
  ],

  mergeSort: [
    'void mergeSort(vector<int>& a, int l, int r) {',
    '    if (l >= r) return;        // base case: 0 or 1 element',
    '    int m = (l + r) / 2;',
    '    mergeSort(a, l, m);        // sort left half',
    '    mergeSort(a, m + 1, r);    // sort right half',
    '    merge(a, l, m, r);         // combine sorted halves',
    '}',
  ],

  dfsRecursive: [
    'void dfs(int u) {',
    '    visited[u] = true;         // mark on entry',
    '    for (int v : adj[u])',
    '        if (!visited[v])',
    '            dfs(v);            // recurse into neighbor',
    '}',
  ],
};

/* ===========================================================================
 * 3. The engine
 * ======================================================================== */

class DSAEngine {
  constructor() {
    /**
     * The LIVE model the user edits by hand (spawning/dragging nodes).
     * Algorithms read from this to seed their traces.
     */
    this.model = { nodes: [], edges: [] };

    /** Which algorithm listing is currently active in the UI. */
    this.activeAlgorithm = 'linkedListReversal';

    /**
     * Chronological state history. Each entry:
     *   { model, lineIndex, description, algorithm }
     * `model` is a *deep clone* — mutating the live model never corrupts it.
     */
    this.algorithmHistory = [];

    /** Cursor into algorithmHistory. -1 means "not playing a trace". */
    this.historyIndex = -1;

    /** Optional observers notified whenever the presented model changes. */
    this._listeners = new Set();
  }

  /* --------------------------------------------------------------------- */
  /* Observer plumbing                                                     */
  /* --------------------------------------------------------------------- */

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snapshot = this.getPresentedState();
    this._listeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch (err) {
        console.error('[dsaEngine] listener threw:', err);
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* Live model editing (driven by hand gestures in app.js)                */
  /* --------------------------------------------------------------------- */

  /** Insert a free-standing node at a world position. Returns the new node. */
  addNode(value, position = { x: 0, y: 0, z: 0 }) {
    const node = {
      uuid: generateUUID(),
      value: value,
      position: { x: position.x, y: position.y, z: position.z },
      state: 'added',
    };
    this.model.nodes.push(node);
    this._resetTrace();
    this._emit();
    return node;
  }

  /** Move an existing node (live drag). No trace impact. */
  moveNode(uuid, position) {
    const node = this.model.nodes.find((n) => n.uuid === uuid);
    if (!node) return false;
    node.position = { x: position.x, y: position.y, z: position.z };
    // Do NOT reset the trace during a drag — dragging is a view concern.
    this._emit();
    return true;
  }

  /** Connect two nodes with an edge. Rejects self-loops and duplicates. */
  addEdge(fromUuid, toUuid, { directed = true, weight = 1 } = {}) {
    if (fromUuid === toUuid) return null;
    const exists = this.model.edges.some(
      (e) =>
        (e.from === fromUuid && e.to === toUuid) ||
        (!directed && e.from === toUuid && e.to === fromUuid)
    );
    if (exists) return null;

    const edge = {
      uuid: generateUUID(),
      from: fromUuid,
      to: toUuid,
      directed,
      weight,
      state: 'default',
    };
    this.model.edges.push(edge);
    this._resetTrace();
    this._emit();
    return edge;
  }

  /** Remove a node and any edges touching it. */
  removeNode(uuid) {
    this.model.nodes = this.model.nodes.filter((n) => n.uuid !== uuid);
    this.model.edges = this.model.edges.filter(
      (e) => e.from !== uuid && e.to !== uuid
    );
    this._resetTrace();
    this._emit();
  }

  /** Flush everything back to an empty universe. */
  clear() {
    this.model = { nodes: [], edges: [] };
    this._resetTrace();
    this._emit();
  }

  setActiveAlgorithm(key) {
    if (!CPP_SOURCES[key] && key !== 'bst' && key !== 'graph') {
      console.warn('[dsaEngine] unknown algorithm key:', key);
    }
    this.activeAlgorithm = key;
    this._resetTrace();
  }

  getSource(key = this.activeAlgorithm) {
    return CPP_SOURCES[key] || [];
  }

  /* --------------------------------------------------------------------- */
  /* Text-based structural input + auto-layout                             */
  /* ---------------------------------------------------------------------
   * Accept raw interview test-case strings, parse them into a {nodes, edges}
   * model, and compute clean spatial coordinates:
   *   • Binary trees  → fixed depth/column grid   (deterministic, tidy).
   *   • Graphs        → force-directed relaxation  (symmetric spread).
   * Everything funnels through addNode/addEdge so emit + render + trace all
   * behave exactly as they do for hand-built structures.
   * ------------------------------------------------------------------ */

  /** Grid spacing for binary-tree layout (world/field-local units). */
  static get TREE_X_SPACING() { return 3.2; }
  static get TREE_Y_SPACING() { return 4.5; }

  /**
   * Public entry point. Clears the universe and rebuilds it from `text` in the
   * given `format` ('tree' | 'graph'). Returns { ok, error, counts } so the UI
   * can surface parse failures inline without throwing.
   */
  loadFromText(format, text) {
    let parsed;
    try {
      if (format === 'tree') {
        parsed = this._parseTreeArray(text);
      } else if (format === 'graph') {
        parsed = this._parseEdgeList(text);
      } else {
        return { ok: false, error: `Unknown format "${format}".` };
      }
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }

    if (!parsed || parsed.nodes.length === 0) {
      return { ok: false, error: 'No nodes found in input.' };
    }

    // Commit: wipe and rebuild the live model in one shot, emitting once.
    this.model = { nodes: parsed.nodes, edges: parsed.edges };
    this._resetTrace();
    this._emit();
    return {
      ok: true,
      counts: { nodes: parsed.nodes.length, edges: parsed.edges.length },
    };
  }

  /**
   * Parse LeetCode level-order binary-tree notation, e.g.
   *   [3, 9, 20, null, null, 15, 7]
   * Nulls are holes (no node, and their children are skipped). Coordinates use
   * a fixed binary-depth grid so the tree reads top-down and never overlaps:
   *   depth d      → y = -d * TREE_Y_SPACING
   *   column-in-row→ x spread symmetrically around 0, scaled by 2^(maxDepth-d)
   *     so deeper rows fan out and parent/child columns stay aligned.
   * Parent→child directed edges are created for present children.
   */
  _parseTreeArray(text) {
    const tokens = this._tokenizeArray(text); // array of numbers / null
    if (tokens.length === 0) return { nodes: [], edges: [] };

    // First pass: assign each array index that is non-null a tree slot. We use
    // the classic implicit-heap indexing on the *dense* array (including nulls)
    // so children of index i are 2i+1 and 2i+2 — matching LeetCode semantics.
    const nodeByIndex = new Map(); // arrayIndex -> node object
    const depthOf = new Map();     // arrayIndex -> depth
    let maxDepth = 0;

    // Depth of implicit-heap index i is floor(log2(i+1)).
    const heapDepth = (i) => Math.floor(Math.log2(i + 1));

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === null) continue;
      const d = heapDepth(i);
      depthOf.set(i, d);
      if (d > maxDepth) maxDepth = d;
    }

    // Second pass: position + create nodes. Within a row, order present nodes
    // by their heap "column" (i - (2^d - 1)) across the full row width so
    // siblings stay under the right side of their parent.
    const nodes = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === null) continue;
      const d = depthOf.get(i);
      const firstIndexOfRow = Math.pow(2, d) - 1;   // 0,1,3,7,...
      const colInRow = i - firstIndexOfRow;         // 0..(2^d - 1)
      const rowCount = Math.pow(2, d);
      // Center the row around x=0. Fan-out factor keeps deep rows wide enough
      // that leaves never collide: total row width scales with the widest row.
      const slotWidth = DSAEngine.TREE_X_SPACING * Math.pow(2, maxDepth - d);
      const x = (colInRow - (rowCount - 1) / 2) * slotWidth;
      const y = -d * DSAEngine.TREE_Y_SPACING;

      const node = {
        uuid: generateUUID(),
        value: tokens[i],
        position: { x, y, z: 0 },
        state: 'default',
      };
      nodeByIndex.set(i, node);
      nodes.push(node);
    }

    // Edges: connect each present node to its present children (2i+1, 2i+2).
    const edges = [];
    for (const [i, parent] of nodeByIndex) {
      for (const childIdx of [2 * i + 1, 2 * i + 2]) {
        const child = nodeByIndex.get(childIdx);
        if (child) {
          edges.push({
            uuid: generateUUID(),
            from: parent.uuid,
            to: child.uuid,
            directed: true,
            weight: 1,
            state: 'default',
          });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Parse an edge list such as [[0,1],[1,2],[2,0]] (optionally weighted:
   * [[0,1,5],...]). Vertex ids are arbitrary but are de-duplicated into nodes
   * carrying their original id as `value`. Positions are seeded on a circle
   * then relaxed by a force-directed pass for symmetric spatial distribution.
   */
  _parseEdgeList(text) {
    const pairs = this._tokenizeEdgeList(text); // array of [a,b] or [a,b,w]
    if (pairs.length === 0) return { nodes: [], edges: [] };

    // Collect vertices in first-seen order for stable layout seeding.
    const nodeById = new Map();
    const order = [];
    const ensure = (id) => {
      const key = String(id);
      if (!nodeById.has(key)) {
        const node = {
          uuid: generateUUID(),
          value: id,
          position: { x: 0, y: 0, z: 0 },
          state: 'default',
        };
        nodeById.set(key, node);
        order.push(node);
      }
      return nodeById.get(key);
    };

    const edges = [];
    const seen = new Set();
    for (const p of pairs) {
      const a = ensure(p[0]);
      const b = ensure(p[1]);
      if (a === b) continue;                       // drop self-loops
      // De-dup undirected duplicates (a-b == b-a).
      const k1 = `${a.uuid}|${b.uuid}`;
      const k2 = `${b.uuid}|${a.uuid}`;
      if (seen.has(k1) || seen.has(k2)) continue;
      seen.add(k1);
      edges.push({
        uuid: generateUUID(),
        from: a.uuid,
        to: b.uuid,
        directed: true,
        weight: p.length > 2 && Number.isFinite(p[2]) ? p[2] : 1,
        state: 'default',
      });
    }

    // Seed on a circle so the force layout starts spread out (never all at 0,0,
    // which would make repulsion directions degenerate).
    const n = order.length;
    const seedR = Math.max(6, n * 1.4);
    order.forEach((node, i) => {
      const ang = (i / n) * Math.PI * 2;
      node.position.x = Math.cos(ang) * seedR;
      node.position.y = Math.sin(ang) * seedR;
      node.position.z = 0;
    });

    this._forceLayout(order, edges);
    return { nodes: order, edges };
  }

  /**
   * Lightweight Fruchterman-Reingold force-directed layout. Runs a bounded,
   * synchronous relaxation (small graphs only — interview cases), so it never
   * blocks meaningfully. Repulsion between every pair + spring attraction
   * along edges + gentle centering. Mutates node.position in place (z kept
   * shallow for readability of the 2.5D field).
   */
  _forceLayout(nodes, edges, iterations = 140) {
    const n = nodes.length;
    if (n <= 1) return;

    // Index nodes for O(1) edge endpoint lookup.
    const idx = new Map();
    nodes.forEach((node, i) => idx.set(node.uuid, i));

    const AREA = Math.max(1, n) * 60;           // target spread area
    const k = Math.sqrt(AREA / n);              // ideal edge length
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    let temp = k * 2.2;                          // cooling schedule start
    const cool = temp / (iterations + 1);

    for (let it = 0; it < iterations; it++) {
      for (let i = 0; i < n; i++) { disp[i].x = 0; disp[i].y = 0; }

      // Repulsion: every pair pushes apart (~ k^2 / distance).
      for (let i = 0; i < n; i++) {
        const pi = nodes[i].position;
        for (let j = i + 1; j < n; j++) {
          const pj = nodes[j].position;
          let dx = pi.x - pj.x;
          let dy = pi.y - pj.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          if (dist < 0.01) { dx = (Math.random() - 0.5) * 0.1; dy = (Math.random() - 0.5) * 0.1; dist = 0.01; }
          const force = (k * k) / dist;
          const ux = dx / dist, uy = dy / dist;
          disp[i].x += ux * force; disp[i].y += uy * force;
          disp[j].x -= ux * force; disp[j].y -= uy * force;
        }
      }

      // Attraction: edges pull endpoints together (~ dist^2 / k).
      for (const e of edges) {
        const a = idx.get(e.from), b = idx.get(e.to);
        if (a === undefined || b === undefined) continue;
        const pa = nodes[a].position, pb = nodes[b].position;
        const dx = pa.x - pb.x, dy = pa.y - pb.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const force = (dist * dist) / k;
        const ux = dx / dist, uy = dy / dist;
        disp[a].x -= ux * force; disp[a].y -= uy * force;
        disp[b].x += ux * force; disp[b].y += uy * force;
      }

      // Apply displacement clamped by the current temperature, then cool.
      for (let i = 0; i < n; i++) {
        const d = disp[i];
        const dl = Math.hypot(d.x, d.y) || 0.01;
        const p = nodes[i].position;
        p.x += (d.x / dl) * Math.min(dl, temp);
        p.y += (d.y / dl) * Math.min(dl, temp);
        // Mild centering pull so the whole layout stays near the origin.
        p.x -= p.x * 0.008;
        p.y -= p.y * 0.008;
      }
      temp = Math.max(temp - cool, k * 0.05);
    }

    // Final recenter on the centroid so the graph sits symmetric about origin.
    let cx = 0, cy = 0;
    for (const node of nodes) { cx += node.position.x; cy += node.position.y; }
    cx /= n; cy /= n;
    for (const node of nodes) { node.position.x -= cx; node.position.y -= cy; node.position.z = 0; }
  }

  /* ---- Tokenizers (tolerant of whitespace / trailing commas) ---------- */

  /**
   * Tokenize a flat array literal like "[3, 9, 20, null, null, 15, 7]" into
   * [3, 9, 20, null, null, 15, 7]. Accepts integers, floats, and null (also
   * the words "null"/"#"/"-" as hole markers). Throws on malformed content.
   */
  _tokenizeArray(text) {
    const inner = this._stripBrackets(text);
    if (inner.trim() === '') return [];
    return inner.split(',').map((raw) => {
      const t = raw.trim();
      if (t === '' ) return null;                 // "[1,,2]" → treat as hole
      if (t === 'null' || t === '#' || t === '-' || t === 'None') return null;
      const num = Number(t);
      if (!Number.isFinite(num)) {
        throw new Error(`Invalid tree value: "${t}"`);
      }
      return num;
    });
  }

  /**
   * Tokenize an edge list "[[0,1],[1,2],[2,0]]" into [[0,1],[1,2],[2,0]].
   * Also accepts newline / space separated pairs like "0 1\n1 2". Weighted
   * triples [a,b,w] are preserved. Throws on malformed content.
   */
  _tokenizeEdgeList(text) {
    const trimmed = (text || '').trim();
    if (trimmed === '') return [];

    // Path A: bracketed JSON-ish nested arrays. Extract each [...] group.
    if (trimmed.includes('[')) {
      const groups = trimmed.match(/\[[^\[\]]*\]/g);
      if (!groups) throw new Error('Could not find any [a,b] pairs.');
      // Skip a leading outer wrapper match if it captured the whole thing empty.
      return groups
        .map((g) => this._stripBrackets(g)
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((v) => Number.isFinite(v)))
        .filter((arr) => arr.length >= 2);
    }

    // Path B: whitespace / line separated pairs.
    return trimmed.split(/\n|;/).map((line) => {
      const parts = line.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      return parts;
    }).filter((arr) => arr.length >= 2);
  }

  /** Strip one layer of surrounding [ ] (and any outer whitespace). */
  _stripBrackets(text) {
    const t = (text || '').trim();
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      // No brackets at all — treat the whole thing as the inner CSV.
      return t;
    }
    return t.slice(start + 1, end);
  }

  /* --------------------------------------------------------------------- */
  /* Trace lifecycle                                                        */
  /* --------------------------------------------------------------------- */

  _resetTrace() {
    this.algorithmHistory = [];
    this.historyIndex = -1;
  }

  /**
   * The state the UI should currently render. During a trace it is the model
   * at `historyIndex`; otherwise it is the live edit model.
   */
  getPresentedState() {
    if (this.historyIndex >= 0 && this.algorithmHistory[this.historyIndex]) {
      const step = this.algorithmHistory[this.historyIndex];
      return {
        model: step.model,
        lineIndex: step.lineIndex,
        description: step.description,
        algorithm: step.algorithm,
        frame: step.frame || null,
        stepIndex: this.historyIndex,
        stepCount: this.algorithmHistory.length,
        playing: true,
      };
    }
    return {
      model: this.model,
      lineIndex: -1,
      description: 'Live editing — spawn and connect nodes in mid-air.',
      algorithm: this.activeAlgorithm,
      frame: null,
      stepIndex: -1,
      stepCount: this.algorithmHistory.length,
      playing: false,
    };
  }

  /**
   * Push one immutable snapshot onto the history. This is the ONLY place a
   * step is recorded, guaranteeing every step is a deep clone.
   */
  _record(model, lineIndex, description, algorithm, frame = null) {
    this.algorithmHistory.push({
      model: deepClone(model),
      lineIndex,
      description,
      algorithm,
      // Recursion algorithms carry a call-frame event describing the change to
      // the call stack at this step (see the recursion visualizer). Non-
      // recursive algorithms simply omit it, so it defaults to null and the
      // renderer's recursion layer stays dormant.
      frame: frame ? deepClone(frame) : null,
    });
  }

  /** Advance one step through the recorded trace. */
  stepForward() {
    if (this.algorithmHistory.length === 0) return false;
    if (this.historyIndex < this.algorithmHistory.length - 1) {
      this.historyIndex += 1;
      this._emit();
      return true;
    }
    return false;
  }

  /** Pop back one step — a lossless restore of an earlier moment. */
  stepBackward() {
    if (this.algorithmHistory.length === 0) return false;
    if (this.historyIndex > 0) {
      this.historyIndex -= 1;
      this._emit();
      return true;
    }
    // Stepping back off the front returns to the live model.
    if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this._emit();
      return true;
    }
    return false;
  }

  /** Jump to the last recorded step (used by "execute" macro playback). */
  jumpToEnd() {
    if (this.algorithmHistory.length === 0) return;
    this.historyIndex = this.algorithmHistory.length - 1;
    this._emit();
  }

  jumpToStart() {
    if (this.algorithmHistory.length === 0) return;
    this.historyIndex = 0;
    this._emit();
  }

  /**
   * Build a trace for the active algorithm from the current live model and
   * arm the history at step 0. Returns the number of steps created.
   */
  buildTrace() {
    this._resetTrace();
    switch (this.activeAlgorithm) {
      case 'linkedListReversal':
        this._traceLinkedListReversal();
        break;
      case 'bstInsert':
      case 'bst':
        this._traceBSTInsertAll();
        break;
      case 'bstDelete':
        this._traceBSTDelete();
        break;
      case 'dfs':
        this._traceDFS();
        break;
      case 'dijkstra':
      case 'graph':
        this._traceDijkstra();
        break;
      case 'fibonacci':
        this._traceFibonacci();
        break;
      case 'mergeSort':
        this._traceMergeSort();
        break;
      case 'dfsRecursive':
        this._traceDFSRecursive();
        break;
      default:
        console.warn('[dsaEngine] no trace builder for', this.activeAlgorithm);
    }
    if (this.algorithmHistory.length > 0) this.historyIndex = 0;
    this._emit();
    return this.algorithmHistory.length;
  }

  /* --------------------------------------------------------------------- */
  /* Helpers to build a working model from the live nodes                  */
  /* --------------------------------------------------------------------- */

  /** Return a fresh working copy of the live model to mutate during tracing. */
  _workingModel() {
    return deepClone(this.model);
  }

  _setAllNodeStates(model, state) {
    model.nodes.forEach((n) => (n.state = state));
  }

  _setAllEdgeStates(model, state) {
    model.edges.forEach((e) => (e.state = state));
  }

  _findNode(model, uuid) {
    return model.nodes.find((n) => n.uuid === uuid);
  }

  /* --------------------------------------------------------------------- */
  /* ALGORITHM 1 — Singly linked list reversal                             */
  /*                                                                       */
  /* We treat the live nodes as a chain ordered by their existing directed */
  /* edges (falling back to spawn order). The reversal is expressed with   */
  /* the classic three-pointer loop, recording a snapshot per pointer op.  */
  /* --------------------------------------------------------------------- */

  _linkedListOrder(model) {
    // Build next-map from directed edges.
    const nextOf = new Map();
    const hasIncoming = new Set();
    model.edges.forEach((e) => {
      if (e.directed) {
        nextOf.set(e.from, e.to);
        hasIncoming.add(e.to);
      }
    });

    // Head = a node with an outgoing edge but no incoming edge.
    let head = model.nodes.find(
      (n) => nextOf.has(n.uuid) && !hasIncoming.has(n.uuid)
    );
    // Fallbacks: any node with no incoming, else first node.
    if (!head) head = model.nodes.find((n) => !hasIncoming.has(n.uuid));
    if (!head) head = model.nodes[0];

    const order = [];
    const seen = new Set();
    let cur = head;
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      order.push(cur);
      const nx = nextOf.get(cur.uuid);
      cur = nx ? this._findNode(model, nx) : null;
    }
    // Append any orphan nodes so nothing silently disappears.
    model.nodes.forEach((n) => {
      if (!seen.has(n.uuid)) order.push(n);
    });
    return order;
  }

  _traceLinkedListReversal() {
    const ALGO = 'linkedListReversal';
    const model = this._workingModel();
    if (model.nodes.length === 0) return;

    const order = this._linkedListOrder(model);

    // Rebuild a clean forward chain of edges so the visual matches the list.
    model.edges = [];
    for (let i = 0; i < order.length - 1; i++) {
      model.edges.push({
        uuid: generateUUID(),
        from: order[i].uuid,
        to: order[i + 1].uuid,
        directed: true,
        weight: 1,
        state: 'default',
      });
    }
    this._setAllNodeStates(model, 'default');

    // Convenience: map uuid -> index in `order` for edge rewrites.
    const edgeBetween = (fromU, toU) =>
      model.edges.find((e) => e.from === fromU && e.to === toU);

    this._record(model, 0, 'Reverse a singly linked list in place.', ALGO);

    // prev = nullptr
    let prevIdx = -1;               // index into order, -1 == nullptr
    let currIdx = 0;                // curr = head
    this._record(model, 1, 'prev = nullptr', ALGO);

    // curr = head
    if (order[currIdx]) order[currIdx].state = 'active';
    this._record(model, 2, 'curr = head → point at the first node', ALGO);

    while (currIdx >= 0 && currIdx < order.length) {
      // while (curr != nullptr)
      this._record(model, 3, `Loop check: curr = ${order[currIdx].value}`, ALGO);

      // next = curr->next
      const nextIdx = currIdx + 1 < order.length ? currIdx + 1 : -1;
      if (nextIdx >= 0) order[nextIdx].state = 'compare';
      this._record(
        model,
        4,
        `next = curr->next (${nextIdx >= 0 ? order[nextIdx].value : 'nullptr'})`,
        ALGO
      );

      // curr->next = prev  — flip the edge
      // Remove forward edge curr->next
      if (nextIdx >= 0) {
        const fwd = edgeBetween(order[currIdx].uuid, order[nextIdx].uuid);
        if (fwd) fwd.state = 'removed';
      }
      // Add reversed edge curr->prev
      if (prevIdx >= 0) {
        model.edges.push({
          uuid: generateUUID(),
          from: order[currIdx].uuid,
          to: order[prevIdx].uuid,
          directed: true,
          weight: 1,
          state: 'path',
        });
      }
      // Physically drop the removed forward edge now that it's shown.
      model.edges = model.edges.filter((e) => e.state !== 'removed');
      this._record(model, 5, 'curr->next = prev → pointer flipped', ALGO);

      // prev = curr
      if (prevIdx >= 0) order[prevIdx].state = 'visited';
      order[currIdx].state = 'active';
      prevIdx = currIdx;
      this._record(model, 6, `prev = curr (${order[prevIdx].value})`, ALGO);

      // curr = next
      currIdx = nextIdx;
      if (currIdx >= 0) order[currIdx].state = 'active';
      this._record(
        model,
        7,
        `curr = next (${currIdx >= 0 ? order[currIdx].value : 'nullptr'})`,
        ALGO
      );
    }

    // Loop exit
    this._record(model, 8, 'curr == nullptr → loop ends', ALGO);

    // return prev — highlight the new head
    if (prevIdx >= 0) {
      this._setAllNodeStates(model, 'visited');
      order[prevIdx].state = 'path';
    }
    this._record(model, 9, 'return prev → list reversed. New head highlighted.', ALGO);
  }

  /* --------------------------------------------------------------------- */
  /* ALGORITHM 2 — BST insertion (explicit iterative descent)              */
  /*                                                                       */
  /* Nodes are inserted in spawn order. Each insertion walks from the root */
  /* comparing keys, recording each comparison, then places the node and   */
  /* lays out the tree spatially (x by in-order, y by depth).              */
  /* --------------------------------------------------------------------- */

  _traceBSTInsertAll() {
    const ALGO = 'bstInsert';
    const source = this._workingModel();
    if (source.nodes.length === 0) return;

    // Start from an empty tree; insert values one by one.
    const values = source.nodes.map((n) => Number(n.value));
    let root = null; // BSTNode
    const nodeById = new Map(); // uuid -> BSTNode (for stable identity)

    // The model we grow as insertions happen.
    const model = { nodes: [], edges: [] };

    const pushSnapshot = (lineIndex, description) => {
      this._layoutBST(root); // refresh coordinates
      // Sync model nodes/edges from the BST.
      this._syncModelFromBST(root, model, nodeById);
      this._record(model, lineIndex, description, ALGO);
    };

    this._record(model, 0, 'Build a BST by inserting values one at a time.', ALGO);

    for (const value of values) {
      const fresh = new BSTNode(value);
      nodeById.set(fresh.uuid, fresh);

      if (root === null) {
        // if (root == nullptr) return new Node(key);
        this._record(model, 1, `Tree empty → root becomes ${value}`, ALGO);
        root = fresh;
        pushSnapshot(2, `Created root node ${value}`);
        continue;
      }

      // Iterative descent replaces native recursion.
      let cur = root;
      let placed = false;
      while (!placed) {
        // Highlight the node we are comparing against.
        this._clearBSTStates(root);
        cur.state = 'compare';
        pushSnapshot(3, `Compare ${value} with ${cur.value}`);

        if (value < cur.value) {
          this._record(model, 4, `${value} < ${cur.value} → go left`, ALGO);
          if (cur.left === null) {
            cur.left = fresh;
            fresh.parent = cur;
            fresh.state = 'added';
            pushSnapshot(4, `Inserted ${value} as left child of ${cur.value}`);
            placed = true;
          } else {
            cur = cur.left;
          }
        } else if (value > cur.value) {
          this._record(model, 5, `${value} > ${cur.value} → go right`, ALGO);
          if (cur.right === null) {
            cur.right = fresh;
            fresh.parent = cur;
            fresh.state = 'added';
            pushSnapshot(6, `Inserted ${value} as right child of ${cur.value}`);
            placed = true;
          } else {
            cur = cur.right;
          }
        } else {
          // Duplicate — BSTs typically ignore it.
          this._record(model, 6, `${value} already present → ignored`, ALGO);
          placed = true;
        }
      }
    }

    // return root — final clean render.
    this._clearBSTStates(root);
    this._layoutBST(root);
    this._syncModelFromBST(root, model, nodeById);
    this._record(model, 7, 'return root → BST complete.', ALGO);
  }

  _clearBSTStates(root) {
    this._bstForEach(root, (n) => (n.state = 'default'));
  }

  _bstForEach(root, fn) {
    if (!root) return;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      fn(n);
      if (n.right) stack.push(n.right);
      if (n.left) stack.push(n.left);
    }
  }

  /** Assign x by in-order index, y by depth (negative = downward). */
  _layoutBST(root) {
    if (!root) return;
    let order = 0;
    const H_SPACING = 3.2;
    const V_SPACING = 3.0;

    // Iterative in-order traversal for x assignment.
    const stack = [];
    let node = root;
    const depthOf = new Map();

    // First compute depth via BFS.
    const q = [{ n: root, d: 0 }];
    while (q.length) {
      const { n, d } = q.shift();
      depthOf.set(n.uuid, d);
      if (n.left) q.push({ n: n.left, d: d + 1 });
      if (n.right) q.push({ n: n.right, d: d + 1 });
    }

    while (stack.length || node) {
      while (node) {
        stack.push(node);
        node = node.left;
      }
      node = stack.pop();
      node.x = order * H_SPACING;
      node.y = -(depthOf.get(node.uuid) || 0) * V_SPACING + 6;
      node.z = 0;
      order += 1;
      node = node.right;
    }

    // Center horizontally around 0.
    const maxOrder = order - 1;
    const centerShift = (maxOrder * H_SPACING) / 2;
    this._bstForEach(root, (n) => {
      n.x -= centerShift;
    });
  }

  /** Rebuild the flat model (nodes+edges) from the current BST. */
  _syncModelFromBST(root, model, _nodeById) {
    model.nodes = [];
    model.edges = [];
    this._bstForEach(root, (n) => {
      model.nodes.push({
        uuid: n.uuid,
        value: n.value,
        position: { x: n.x, y: n.y, z: n.z },
        state: n.state || 'default',
      });
      if (n.left) {
        model.edges.push({
          uuid: `${n.uuid}->${n.left.uuid}`,
          from: n.uuid,
          to: n.left.uuid,
          directed: true,
          weight: 1,
          state: 'default',
        });
      }
      if (n.right) {
        model.edges.push({
          uuid: `${n.uuid}->${n.right.uuid}`,
          from: n.uuid,
          to: n.right.uuid,
          directed: true,
          weight: 1,
          state: 'default',
        });
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* ALGORITHM 3 — BST deletion                                            */
  /*                                                                       */
  /* Builds a BST from the live nodes, then deletes the largest value to   */
  /* demonstrate the three cases (leaf, one child, two children + inorder  */
  /* successor). Fully explicit, no native recursion.                      */
  /* --------------------------------------------------------------------- */

  _traceBSTDelete() {
    const ALGO = 'bstDelete';
    const source = this._workingModel();
    if (source.nodes.length === 0) return;

    // Build the tree silently first.
    const values = source.nodes.map((n) => Number(n.value));
    let root = null;
    const insert = (value) => {
      const fresh = new BSTNode(value);
      if (!root) {
        root = fresh;
        return;
      }
      let cur = root;
      while (true) {
        if (value < cur.value) {
          if (!cur.left) {
            cur.left = fresh;
            fresh.parent = cur;
            return;
          }
          cur = cur.left;
        } else if (value > cur.value) {
          if (!cur.right) {
            cur.right = fresh;
            fresh.parent = cur;
            return;
          }
          cur = cur.right;
        } else {
          return; // dup
        }
      }
    };
    values.forEach(insert);

    const model = { nodes: [], edges: [] };
    const sync = (lineIndex, description) => {
      this._layoutBST(root);
      this._syncModelFromBST(root, model, null);
      this._record(model, lineIndex, description, ALGO);
    };

    // Choose a key to delete — the root value makes the 2-child case likely.
    const key = root ? root.value : values[0];
    sync(0, `Delete key ${key} from the BST.`);

    // Explicit search for the node + parent.
    let parent = null;
    let cur = root;
    while (cur && cur.value !== key) {
      this._clearBSTStates(root);
      cur.state = 'compare';
      sync(2, `Searching for ${key}: at ${cur.value}`);
      parent = cur;
      if (key < cur.value) {
        this._record(model, 2, `${key} < ${cur.value} → go left`, ALGO);
        cur = cur.left;
      } else {
        this._record(model, 4, `${key} > ${cur.value} → go right`, ALGO);
        cur = cur.right;
      }
    }

    if (!cur) {
      this._record(model, 1, `Key ${key} not found.`, ALGO);
      return;
    }

    this._clearBSTStates(root);
    cur.state = 'active';
    sync(5, `Found ${key} → determine deletion case`);

    const replaceInParent = (target, replacement) => {
      if (!target.parent) {
        root = replacement;
        if (replacement) replacement.parent = null;
      } else if (target.parent.left === target) {
        target.parent.left = replacement;
        if (replacement) replacement.parent = target.parent;
      } else {
        target.parent.right = replacement;
        if (replacement) replacement.parent = target.parent;
      }
    };

    if (!cur.left) {
      // Case: no left child (covers leaf too).
      this._record(model, 7, 'No left child → splice in right subtree', ALGO);
      replaceInParent(cur, cur.right);
      sync(7, `Removed ${key}, promoted right child`);
    } else if (!cur.right) {
      this._record(model, 8, 'No right child → splice in left subtree', ALGO);
      replaceInParent(cur, cur.left);
      sync(8, `Removed ${key}, promoted left child`);
    } else {
      // Two children → inorder successor (min of right subtree).
      this._record(model, 9, 'Two children → find inorder successor', ALGO);
      let succParent = cur;
      let succ = cur.right;
      while (succ.left) {
        this._clearBSTStates(root);
        cur.state = 'active';
        succ.state = 'compare';
        sync(9, `Descending for successor: ${succ.value}`);
        succParent = succ;
        succ = succ.left;
      }
      this._clearBSTStates(root);
      cur.state = 'active';
      succ.state = 'path';
      sync(10, `Successor is ${succ.value}`);

      cur.value = succ.value;
      this._clearBSTStates(root);
      cur.state = 'added';
      sync(11, `Copied successor value ${succ.value} into node`);

      // Remove the successor (it has no left child).
      if (succParent.left === succ) succParent.left = succ.right;
      else succParent.right = succ.right;
      if (succ.right) succ.right.parent = succParent;
      sync(12, `Removed duplicate successor node`);
    }

    this._clearBSTStates(root);
    sync(14, 'return root → deletion complete.');
  }

  /* --------------------------------------------------------------------- */
  /* ALGORITHM 4 — DFS with an explicit stack (recursive backtracking)     */
  /* --------------------------------------------------------------------- */

  _buildGraphFromModel(model) {
    const g = new Graph();
    g.directed = false;
    model.nodes.forEach((n) => g.addVertex(n.uuid));
    model.edges.forEach((e) =>
      g.addEdge(e.from, e.to, Number(e.weight) || 1, e.uuid)
    );
    return g;
  }

  _traceDFS() {
    const ALGO = 'dfs';
    const model = this._workingModel();
    if (model.nodes.length === 0) return;

    const graph = this._buildGraphFromModel(model);
    const start = model.nodes[0].uuid;

    this._setAllNodeStates(model, 'default');
    this._setAllEdgeStates(model, 'default');
    this._record(model, 0, 'Depth-first search using an explicit stack.', ALGO);

    const visited = new Set();
    const stack = [start];
    const startNode = this._findNode(model, start);
    if (startNode) startNode.state = 'active';
    this._record(model, 1, `Push start node ${startNode.value}`, ALGO);

    while (stack.length) {
      this._record(model, 2, `Stack: [${stack
        .map((u) => this._findNode(model, u)?.value)
        .join(', ')}]`, ALGO);

      const u = stack.pop();
      const uNode = this._findNode(model, u);
      this._setAllNodeStates(model, undefined); // no-op guard
      // Mark the currently-processing node distinctly.
      model.nodes.forEach((n) => {
        if (visited.has(n.uuid)) n.state = 'visited';
        else n.state = 'default';
      });
      if (uNode) uNode.state = 'active';
      this._record(model, 3, `Pop ${uNode?.value}`, ALGO);

      if (visited.has(u)) {
        this._record(model, 4, `${uNode?.value} already visited → backtrack`, ALGO);
        continue;
      }

      visited.add(u);
      if (uNode) uNode.state = 'visited';
      this._record(model, 5, `Visit ${uNode?.value} (backtrack point)`, ALGO);

      // Neighbors in deterministic order.
      const nbrs = graph.neighbors(u);
      for (let i = 0; i < nbrs.length; i++) {
        const v = nbrs[i].to;
        const vNode = this._findNode(model, v);
        // Highlight the edge being explored.
        const edge = model.edges.find(
          (e) =>
            (e.from === u && e.to === v) || (e.from === v && e.to === u)
        );
        this._record(model, 6, `Look at neighbor ${vNode?.value}`, ALGO);
        if (!visited.has(v)) {
          if (edge) edge.state = 'path';
          if (vNode && vNode.state !== 'visited') vNode.state = 'compare';
          stack.push(v);
          this._record(model, 8, `Push ${vNode?.value}`, ALGO);
        } else {
          this._record(model, 7, `${vNode?.value} visited → skip`, ALGO);
        }
      }
    }

    model.nodes.forEach((n) => (n.state = visited.has(n.uuid) ? 'visited' : 'default'));
    this._record(model, 9, 'Stack empty → DFS complete.', ALGO);
  }

  /* --------------------------------------------------------------------- */
  /* ALGORITHM 5 — Dijkstra's shortest paths                               */
  /* --------------------------------------------------------------------- */

  _traceDijkstra() {
    const ALGO = 'dijkstra';
    const model = this._workingModel();
    if (model.nodes.length === 0) return;

    const graph = this._buildGraphFromModel(model);
    const src = model.nodes[0].uuid;

    const dist = new Map();
    model.nodes.forEach((n) => dist.set(n.uuid, Infinity));
    dist.set(src, 0);

    const labelFor = (u) => {
      const n = this._findNode(model, u);
      const d = dist.get(u);
      return `${n?.value}(${d === Infinity ? '∞' : d})`;
    };

    this._setAllNodeStates(model, 'default');
    this._setAllEdgeStates(model, 'default');
    const srcNode = this._findNode(model, src);
    if (srcNode) srcNode.state = 'active';
    this._record(model, 1, `dist[${srcNode?.value}] = 0, all others = ∞`, ALGO);

    // Simple array-backed priority queue (fine for teaching-scale graphs).
    const pq = [{ d: 0, u: src }];
    const settled = new Set();
    this._record(model, 2, `Push (0, ${srcNode?.value}) into the queue`, ALGO);

    while (pq.length) {
      // Extract-min.
      pq.sort((a, b) => a.d - b.d);
      const { d, u } = pq.shift();
      const uNode = this._findNode(model, u);

      model.nodes.forEach((n) => {
        if (settled.has(n.uuid)) n.state = 'visited';
        else n.state = 'default';
      });
      if (uNode) uNode.state = 'active';
      this._record(model, 4, `Pop min: ${labelFor(u)}`, ALGO);

      if (d > dist.get(u)) {
        this._record(model, 5, `Stale entry for ${uNode?.value} → skip`, ALGO);
        continue;
      }

      settled.add(u);
      if (uNode) uNode.state = 'visited';

      const nbrs = graph.neighbors(u);
      for (const { to: v, weight, edgeId } of nbrs) {
        const vNode = this._findNode(model, v);
        const edge = model.edges.find((e) => e.uuid === edgeId) ||
          model.edges.find(
            (e) =>
              (e.from === u && e.to === v) || (e.from === v && e.to === u)
          );
        if (edge) edge.state = 'compare';
        const alt = dist.get(u) + weight;
        this._record(
          model,
          6,
          `Relax edge ${uNode?.value}→${vNode?.value} (w=${weight}): ${alt} vs ${
            dist.get(v) === Infinity ? '∞' : dist.get(v)
          }`,
          ALGO
        );

        if (alt < dist.get(v)) {
          dist.set(v, alt);
          if (edge) edge.state = 'path';
          if (vNode && !settled.has(v)) vNode.state = 'compare';
          pq.push({ d: alt, u: v });
          this._record(model, 8, `Improved dist[${vNode?.value}] = ${alt}`, ALGO);
        } else if (edge) {
          edge.state = 'default';
        }
      }
    }

    model.nodes.forEach(
      (n) => (n.state = settled.has(n.uuid) ? 'path' : 'default')
    );
    this._record(model, 11, 'Queue empty → shortest paths finalized.', ALGO);
  }

  /* ===================================================================== */
  /* RECURSION VISUALIZER — instrumented recursive algorithms              */
  /*                                                                       */
  /* Algorithms drive three lifecycle hooks — emitCallEnter / emitLine-    */
  /* Highlight / emitCallReturn — which give clean, readable instrumenta-  */
  /* tion. Under the hood every hook records a FULL call-state snapshot     */
  /* (`frame`), not an event delta. That is what makes trace navigation     */
  /* lossless and reverse-stepping cheap and correct: stepping back is a    */
  /* jump to snapshot N−1, never an inverse-event replay (which would be    */
  /* fragile against MergeSort's in-place array mutation).                  */
  /*                                                                       */
  /* frame = {                                                             */
  /*   event      : 'callEnter' | 'line' | 'return',                       */
  /*   activeId   : id of the frame this step acts on,                     */
  /*   returnValue: meaningful only when event === 'return',               */
  /*   nodes : [{id, parentId, depth, label, args[], locals[],             */
  /*             status:'active'|'returned', result}],   // whole call tree */
  /*   stack : [{id, label, args[], locals[], depth}],   // bottom → top    */
  /* }                                                                     */
  /* args / locals are ordered [{name, value}] lists so the 3D stack block */
  /* face can render a faithful frame (signature + args + locals + result).*/
  /* ===================================================================== */

  /** Reset the per-trace call-frame bookkeeping. Called by each algorithm. */
  _recBegin(model, algo) {
    this._rec = { model, algo, nodes: [], stack: [], nextId: 0 };
  }

  /** Build a full call-state snapshot from the current tracer bookkeeping. */
  _recFrame(event, activeId, returnValue) {
    const { nodes, stack } = this._rec;
    const clone = (list) => (list || []).map((p) => ({ name: p.name, value: p.value }));
    return {
      event,
      activeId,
      returnValue: returnValue === undefined ? null : returnValue,
      nodes: nodes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        depth: n.depth,
        label: n.label,
        args: clone(n.args),
        locals: clone(n.locals),
        status: n.status,
        result: n.result,
      })),
      stack: stack.map((id) => {
        const n = nodes.find((c) => c.id === id);
        return {
          id, label: n.label, args: clone(n.args), locals: clone(n.locals), depth: n.depth,
        };
      }),
    };
  }

  /* --- Lifecycle hooks the algorithms call ------------------------------ */

  /**
   * Enter a new activation. Allocates a frame id, parents it to the current
   * stack top, pushes it onto both the call-node list and the live stack, and
   * records a 'callEnter' snapshot. Returns the new frame's id (the algorithm
   * threads it to its recursive children as their parent).
   *   label  — display signature, e.g. 'fib(4)' or 'msort(0,3)'
   *   args   — ordered [{name, value}] bound parameters
   *   locals — ordered [{name, value}] initial locals (usually [])
   */
  emitCallEnter(line, label, args, locals, desc) {
    const rec = this._rec;
    const id = rec.nextId++;
    const parentId = rec.stack.length ? rec.stack[rec.stack.length - 1] : null;
    const depth = rec.stack.length;
    const node = {
      id, parentId, depth, label,
      args: args || [], locals: locals || [],
      status: 'active', result: null,
    };
    rec.nodes.push(node);
    rec.stack.push(id);
    this._record(rec.model, line, desc || `Call ${label}`, rec.algo,
      this._recFrame('callEnter', id));
    return id;
  }

  /**
   * Highlight a source line within the current (top-of-stack) frame, optionally
   * patching that frame's locals first so the stack block face stays current.
   *   localsPatch — [{name, value}] entries merged by name into the frame.
   */
  emitLineHighlight(line, desc, localsPatch) {
    const rec = this._rec;
    const id = rec.stack.length ? rec.stack[rec.stack.length - 1] : null;
    if (id !== null && localsPatch && localsPatch.length) {
      const node = rec.nodes.find((n) => n.id === id);
      for (const p of localsPatch) {
        const existing = node.locals.find((l) => l.name === p.name);
        if (existing) existing.value = p.value;
        else node.locals.push({ name: p.name, value: p.value });
      }
    }
    this._record(rec.model, line, desc, rec.algo, this._recFrame('line', id));
  }

  /**
   * Return from the current (top-of-stack) frame with `returnValue`. Marks the
   * frame resolved, pops the live stack, and records a 'return' snapshot that
   * carries the value (the renderer animates it travelling up to the parent).
   */
  emitCallReturn(line, returnValue, desc) {
    const rec = this._rec;
    const id = rec.stack[rec.stack.length - 1];
    const node = rec.nodes.find((n) => n.id === id);
    node.result = returnValue;
    node.status = 'returned';
    rec.stack.pop();
    this._record(rec.model, line, desc || `${node.label} returns ${returnValue}`,
      rec.algo, this._recFrame('return', id, returnValue));
    return returnValue;
  }

  /* ALGORITHM 6 — Recursive Fibonacci (exponential call tree) ----------- */
  _traceFibonacci() {
    const ALGO = 'fibonacci';
    // The recursion view owns the stage; no data-structure model is shown.
    const model = { nodes: [], edges: [] };
    this._recBegin(model, ALGO);

    // Input n: use the first live node's value if present (clamped to a small
    // range so the tree stays legible), else default to 5.
    let n = 5;
    if (this.model.nodes.length) {
      const v = Math.round(this.model.nodes[0].value);
      if (Number.isFinite(v)) n = Math.max(1, Math.min(7, v));
    }

    const fib = (val) => {
      this.emitCallEnter(0, `fib(${val})`, [{ name: 'n', value: val }], []);

      if (val <= 1) {
        this.emitLineHighlight(1, `fib(${val}): n ≤ 1 → base case`);
        return this.emitCallReturn(2, val, `Return ${val} (base case)`);
      }

      this.emitLineHighlight(3,
        `fib(${val}) needs fib(${val - 1}) + fib(${val - 2})`);
      const a = fib(val - 1);
      this.emitLineHighlight(3, `got fib(${val - 1}) = ${a}`, [{ name: 'a', value: a }]);
      const b = fib(val - 2);
      this.emitLineHighlight(3, `got fib(${val - 2}) = ${b}`, [{ name: 'b', value: b }]);
      return this.emitCallReturn(3, a + b, `fib(${val}) returns ${a + b}`);
    };

    fib(n);
  }

  /* ALGORITHM 7 — Recursive Merge Sort (divide & conquer tree) ---------- */
  _traceMergeSort() {
    const ALGO = 'mergeSort';
    const model = { nodes: [], edges: [] };

    // Seed the array from live node values (up to 8), else a fixed sample.
    let arr = this.model.nodes
      .map((n) => Math.round(n.value))
      .filter((v) => Number.isFinite(v))
      .slice(0, 8);
    if (arr.length < 2) arr = [5, 2, 8, 1, 9, 3, 7, 4];
    this._recBegin(model, ALGO);

    // The current contents of the [l..r] slice — a live local that changes as
    // the in-place merge sorts it. Rendered on the stack block face.
    const sub = (l, r) => `[${arr.slice(l, r + 1).join(',')}]`;

    const mergeSort = (l, r) => {
      // Stable identity label (indices), with the slice contents as a local so
      // the tree node identity survives the in-place mutation of `arr`.
      this.emitCallEnter(0, `msort(${l},${r})`,
        [{ name: 'l', value: l }, { name: 'r', value: r }],
        [{ name: 'arr[l..r]', value: sub(l, r) }]);

      if (l >= r) {
        const base = arr[l] !== undefined ? String(arr[l]) : '∅';
        this.emitLineHighlight(1, `l ≥ r → base case ${sub(l, r)}`,
          [{ name: 'arr[l..r]', value: sub(l, r) }]);
        return this.emitCallReturn(1, base, `single element ${base}`);
      }

      const m = Math.floor((l + r) / 2);
      this.emitLineHighlight(2, `split at m=${m}`, [{ name: 'm', value: m }]);
      mergeSort(l, m);
      mergeSort(m + 1, r);

      // Merge the two now-sorted halves in place.
      this.emitLineHighlight(5, `merge halves of [${l}..${r}]`);
      const merged = arr.slice(l, r + 1).sort((a, b) => a - b);
      for (let i = 0; i < merged.length; i++) arr[l + i] = merged[i];
      this.emitLineHighlight(5, `merged → ${sub(l, r)}`,
        [{ name: 'arr[l..r]', value: sub(l, r) }]);
      return this.emitCallReturn(6, merged.join(','), `sorted → ${sub(l, r)}`);
    };

    mergeSort(0, arr.length - 1);
  }

  /* ALGORITHM 8 — Recursive DFS (implicit call-stack traversal) --------- */
  _traceDFSRecursive() {
    const ALGO = 'dfsRecursive';
    const model = this._workingModel();
    if (model.nodes.length === 0) return;

    const graph = this._buildGraphFromModel(model);
    const start = model.nodes[0].uuid;
    this._setAllNodeStates(model, 'default');
    this._setAllEdgeStates(model, 'default');

    const visited = new Set();

    const dfs = (u) => {
      const uNode = this._findNode(model, u);
      const vlabel = uNode?.value;

      // Mark the model so the visited frontier is meaningful too.
      model.nodes.forEach((nn) => {
        if (visited.has(nn.uuid)) nn.state = 'visited';
      });
      if (uNode) uNode.state = 'active';
      this.emitCallEnter(0, `dfs(${vlabel})`,
        [{ name: 'u', value: vlabel }],
        [{ name: 'visited', value: `{${[...visited].map((x) => this._findNode(model, x)?.value).join(',')}}` }]);

      visited.add(u);
      if (uNode) uNode.state = 'visited';
      this.emitLineHighlight(1, `visited[${vlabel}] = true`,
        [{ name: 'visited', value: `{${[...visited].map((x) => this._findNode(model, x)?.value).join(',')}}` }]);

      const nbrs = graph.neighbors(u);
      for (const { to: v } of nbrs) {
        const vNode = this._findNode(model, v);
        if (!visited.has(v)) {
          const edge = model.edges.find(
            (e) => (e.from === u && e.to === v) || (e.from === v && e.to === u)
          );
          if (edge) edge.state = 'path';
          this.emitLineHighlight(4, `dfs(${vlabel}) → recurse into ${vNode?.value}`);
          dfs(v);
        } else {
          this.emitLineHighlight(3, `${vNode?.value} already visited → skip`);
        }
      }

      if (uNode) uNode.state = 'visited';
      this.emitCallReturn(5, vlabel, `Return from dfs(${vlabel})`);
    };

    this._recBegin(model, ALGO);
    dfs(start);
  }
}

/* ===========================================================================
 * 4. Exports (global for a no-build, script-tag environment)
 * ======================================================================== */

window.DSA = {
  DSAEngine,
  LinkedListNode,
  BSTNode,
  Graph,
  CPP_SOURCES,
  generateUUID,
  deepClone,
};
