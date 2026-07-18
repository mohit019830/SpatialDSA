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
      stepIndex: -1,
      stepCount: this.algorithmHistory.length,
      playing: false,
    };
  }

  /**
   * Push one immutable snapshot onto the history. This is the ONLY place a
   * step is recorded, guaranteeing every step is a deep clone.
   */
  _record(model, lineIndex, description, algorithm) {
    this.algorithmHistory.push({
      model: deepClone(model),
      lineIndex,
      description,
      algorithm,
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
