/**
 * render3d.js
 * ---------------------------------------------------------------------------
 * Three.js Spatial Graphics Layer.
 *
 * Responsibilities:
 *   - Own the Scene / Camera / Renderer / lights and the animation loop.
 *   - Reconcile the flat engine model (nodes + edges) into 3D meshes, keeping
 *     a uuid->mesh registry so updates are diffs, not full rebuilds.
 *   - Render nodes as glass-morphism spheres carrying canvas-texture labels.
 *   - Render edges as glowing cylinders, with cone arrowheads for directed
 *     pointers (e.g. a linked-list `next`).
 *   - Expose a raycaster-driven "mid-air cursor": given normalized hand X/Y,
 *     return the node currently hovered, and a world point on a working plane
 *     for spawning/dragging in empty space.
 *
 * This module knows nothing about hands, speech, or algorithms. It receives a
 * model and a cursor position and draws them. All color/state semantics live
 * in STATE_COLORS so the engine can stay presentation-agnostic.
 *
 * Depends on THREE being present on window (loaded via CDN <script> before us).
 * ---------------------------------------------------------------------------
 */

'use strict';

(function () {
  if (typeof THREE === 'undefined') {
    console.error('[render3d] THREE is not loaded. Check the CDN <script> order.');
    return;
  }

  /* =========================================================================
   * Palette — maps engine `state` strings to neon colors.
   * ====================================================================== */
  const STATE_COLORS = {
    default: 0x2aa9c9, // muted cyan
    added:   0x00ff9c, // green — "just added to a structure"
    active:  0x00f3ff, // neon cyan — current focus
    compare: 0xffd000, // amber — being compared
    visited: 0xbd00ff, // neon purple — visited / on path build
    path:    0xbd00ff, // neon purple — final path
    removed: 0xff3860, // red — about to be removed
  };
  const EDGE_COLORS = {
    default: 0x2f6d7a,
    active:  0x00f3ff,
    compare: 0xffd000,
    visited: 0xbd00ff,
    path:    0xbd00ff,
    removed: 0xff3860,
    added:   0x00ff9c,
  };

  const NODE_RADIUS = 1.15;
  const LERP = 0.18; // position/scale easing per frame — smooth structural moves

  // Column-major 3x3 identity (matches THREE.Matrix3.elements ordering).
  // Used as the base state for the linear-algebra grid transformer.
  const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  /* =========================================================================
   * SHARED GEOMETRY + MATERIAL CACHE
   *
   * Rule: never `new` a geometry or material inside setModel()/the frame loop.
   * All node/edge meshes reuse these singletons. Per-node color differences are
   * handled by *cloning* only the cheap material (a shallow GPU-program share)
   * or, for edges, by tinting a shared material — see _createEdgeMesh.
   *
   * Populated lazily by _initSharedAssets() once THREE is confirmed present.
   * ====================================================================== */
  const SHARED = {
    ready: false,
    // Geometry singletons (low-poly for performance).
    sphereGeo: null,   // node body (16x16)
    glowGeo: null,     // node glow shell (12x12)
    cylGeo: null,      // edge cylinder (8 radial segs)
    coneGeo: null,     // arrowhead (12 segs)
    ringGeo: null,     // cursor ring
    cursorCoreGeo: null,
    // Material singletons keyed by state (created once, reused everywhere).
    nodeMat: {},       // state -> MeshLambertMaterial
    glowMat: {},       // state -> MeshBasicMaterial (additive)
    cursorRingMat: null,
    cursorRingHoverMat: null,
    cursorCoreMat: null,
  };

  function _initSharedAssets() {
    if (SHARED.ready) return;

    // --- Low-poly geometry (16x16 spheres per the perf budget) -----------
    SHARED.sphereGeo = new THREE.SphereGeometry(NODE_RADIUS, 16, 16);
    SHARED.glowGeo = new THREE.SphereGeometry(NODE_RADIUS * 1.35, 12, 12);
    SHARED.cylGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 8, 1, true);
    SHARED.coneGeo = new THREE.ConeGeometry(0.32, 0.9, 12);
    SHARED.ringGeo = new THREE.TorusGeometry(0.55, 0.06, 8, 24);
    SHARED.cursorCoreGeo = new THREE.SphereGeometry(0.16, 10, 10);

    // --- One material per state. MeshLambertMaterial is far cheaper than
    //     MeshPhysicalMaterial (no transmission/refraction pass) while still
    //     responding to the scene lights for a glassy neon look. --------------
    for (const state of Object.keys(STATE_COLORS)) {
      const color = STATE_COLORS[state];
      SHARED.nodeMat[state] = new THREE.MeshLambertMaterial({
        color,
        emissive: color,
        emissiveIntensity:
          state === 'active' || state === 'compare' ? 0.9 : 0.4,
        transparent: true,
        opacity: 0.9,
      });
      SHARED.glowMat[state] = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: state === 'default' ? 0.12 : 0.25,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
      });
    }

    // Edge materials: one shared cylinder + one shared cone material per state.
    SHARED.edgeMat = {};
    SHARED.coneMat = {};
    for (const state of Object.keys(EDGE_COLORS)) {
      const color = EDGE_COLORS[state];
      SHARED.edgeMat[state] = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: state === 'default' ? 0.55 : 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      SHARED.coneMat[state] = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95, depthWrite: false,
      });
    }

    SHARED.cursorRingMat = new THREE.MeshBasicMaterial({
      color: 0x00f3ff, transparent: true, opacity: 0.9,
    });
    SHARED.cursorRingHoverMat = new THREE.MeshBasicMaterial({
      color: 0x00ff9c, transparent: true, opacity: 0.9,
    });
    SHARED.cursorCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    // --- Recursion visualizer assets (Phase 4) --------------------------
    // Activation-node box (call tree) + flat slab (stack tower). Materials
    // keyed by call-state so a frame swap is a reference change, no alloc.
    SHARED.recNodeGeo = new THREE.BoxGeometry(2.6, 1.3, 0.5);
    // A taller block for the stack tower so a multi-line frame face (signature +
    // args + locals + return slot) is legible.
    SHARED.recBlockGeo = new THREE.BoxGeometry(5.4, 2.6, 0.8);
    const REC_STATE_COLOR = {
      active:   0x00f3ff, // the frame entered this step
      onstack:  0x2aa9c9, // still on the call stack (ancestor)
      return:   0x00ff9c, // returning this step (neon green = resolved)
      returned: 0xbd00ff, // finished / popped
    };
    SHARED.recStateColor = REC_STATE_COLOR;
    SHARED.recNodeMat = {};
    for (const k of Object.keys(REC_STATE_COLOR)) {
      const color = REC_STATE_COLOR[k];
      SHARED.recNodeMat[k] = new THREE.MeshLambertMaterial({
        color,
        emissive: color,
        emissiveIntensity: k === 'active' || k === 'return' ? 0.85 : 0.4,
        transparent: true,
        opacity: k === 'returned' ? 0.55 : 0.9,
      });
    }
    // Glass-morphic stack-block materials: high transmission, low opacity, a
    // soft emissive rim keyed by call-state. MeshPhysicalMaterial gives real
    // refraction so the tower reads like stacked glass slabs.
    SHARED.recGlassMat = {};
    for (const k of Object.keys(REC_STATE_COLOR)) {
      const color = REC_STATE_COLOR[k];
      SHARED.recGlassMat[k] = new THREE.MeshPhysicalMaterial({
        color,
        emissive: color,
        emissiveIntensity: k === 'active' || k === 'return' ? 0.55 : 0.22,
        metalness: 0.0,
        roughness: 0.12,
        transmission: 0.9,
        thickness: 0.8,
        ior: 1.35,
        clearcoat: 1.0,
        clearcoatRoughness: 0.15,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      });
    }
    SHARED.recLinkMat = {
      idle: new THREE.LineBasicMaterial({
        color: 0x2f6d7a, transparent: true, opacity: 0.5, depthWrite: false,
      }),
      active: new THREE.LineBasicMaterial({
        color: 0x00f3ff, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    };
    // Small cone arrowhead marking edge direction (parent → child).
    SHARED.recArrowGeo = new THREE.ConeGeometry(0.28, 0.7, 10);
    SHARED.recArrowMat = {
      idle: new THREE.MeshBasicMaterial({ color: 0x2f6d7a, transparent: true, opacity: 0.6 }),
      active: new THREE.MeshBasicMaterial({
        color: 0x00f3ff, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending,
      }),
    };

    SHARED.ready = true;
  }

  class Renderer3D {
    /**
     * @param {HTMLCanvasElement} canvas
     */
    constructor(canvas) {
      this.canvas = canvas;

      // Build the shared geometry/material singletons exactly once.
      _initSharedAssets();

      // --- Core Three.js objects -----------------------------------------
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x080a0d);
      this.scene.fog = new THREE.FogExp2(0x080a0d, 0.012);

      const { clientWidth: w, clientHeight: h } = canvas;
      this.camera = new THREE.PerspectiveCamera(55, (w || 1) / (h || 1), 0.1, 2000);
      this.camera.position.set(0, 6, 34);
      this.camera.lookAt(0, 0, 0);

      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: false,          // AA disabled — biggest cheap fill-rate win
        alpha: false,
        powerPreference: 'high-performance',
        stencil: false,
        depth: true,
      });
      // Cap DPR at 1.5 so retina panels don't quadruple the fragment count.
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      this.renderer.setSize(w || 1, h || 1, false);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;

      // --- Lighting -------------------------------------------------------
      this.scene.add(new THREE.AmbientLight(0x4060ff, 0.55));
      const key = new THREE.DirectionalLight(0x00f3ff, 1.1);
      key.position.set(10, 18, 14);
      this.scene.add(key);
      const rim = new THREE.DirectionalLight(0xbd00ff, 0.8);
      rim.position.set(-14, -6, -10);
      this.scene.add(rim);
      const point = new THREE.PointLight(0xffffff, 0.6, 120);
      point.position.set(0, 12, 20);
      this.scene.add(point);

      // --- Rotatable field container -------------------------------------
      // Nodes, edges, and the grid live INSIDE this group so one-handed pinch
      // rotation spins the whole data structure (Ultron-orb style) while the
      // lights, cursor reticle, and HUD stay fixed in world space. At identity
      // rotation this is transparent — world space == field space.
      this.field = new THREE.Group();
      this.scene.add(this.field);

      // --- Ground grid for spatial reference ------------------------------
      this.grid = new THREE.GridHelper(120, 60, 0x00f3ff, 0x14313a);
      this.grid.position.y = -10;
      this.grid.material.opacity = 0.25;
      this.grid.material.transparent = true;
      this.field.add(this.grid);

      // --- Registries: uuid -> mesh/group --------------------------------
      this.nodeMeshes = new Map();
      this.edgeMeshes = new Map();

      // --- Raycaster & interaction plane ---------------------------------
      this.raycaster = new THREE.Raycaster();
      this.pointerNDC = new THREE.Vector2(0, 0);
      // A plane parallel to the camera, at z=0, used to project the cursor
      // into world space for spawning/dragging in empty space.
      this.workPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

      // --- Raycast gating state ------------------------------------------
      // We only cast a ray when (a) the cursor moved beyond RAYCAST_DELTA, or
      // (b) pinch state changed. Otherwise we reuse the last hover result.
      this._lastRayNx = -999;
      this._lastRayNy = -999;
      this._lastPinch = false;
      this._lastHovered = null;
      this._lastWorldPoint = new THREE.Vector3();
      this.RAYCAST_DELTA = 0.01;   // normalized-screen movement gate

      // --- Mid-air cursor reticle ----------------------------------------
      this.cursor = this._makeCursor();
      this.scene.add(this.cursor);
      this._cursorActive = false;

      // --- Auto-orbit when idle (gentle showcase motion) -----------------
      this.autoRotate = true;
      this._clock = new THREE.Clock();

      // --- Camera / field motion controllers -----------------------------
      // ZOOM: app.js pushes a target camera-Z via zoomCamera(); the frame loop
      // lerps camera.position toward it (CAM_LERP = 0.1) for buttery dolly.
      this._camTarget = this.camera.position.clone();
      this.CAM_LERP = 0.1;          // coordinate-smoothing factor (spec: 0.1)
      this.CAM_PAN_LIMIT = 60;      // clamp so the field can't be flung off-screen
      this.ZOOM_MIN = 12;           // closest dolly (world units on Z)
      this.ZOOM_MAX = 80;           // farthest dolly

      // ROTATE: one-handed pinch accumulates a rotation target for `field`;
      // the frame loop eases the live rotation toward it (ROT_LERP) so the orb
      // spins with momentum instead of snapping.
      this._rotTarget = new THREE.Euler(0, 0, 0, 'YXZ');
      this.ROT_GAIN = 6.0;          // hand-delta (0..1 screen) → radians
      this.ROT_LERP = 0.12;         // rotation-smoothing factor (momentum feel)

      // TEMP LINK LINE: one reusable 2-vertex glowing line for the edge pointer.
      const linkGeo = new THREE.BufferGeometry();
      linkGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(6), 3)
      );
      // Two materials swapped by reference (never mutated): a cyan "aiming"
      // beam while the tip is in open air, and a hot-green "locked" beam once
      // auto-aim magnetism snaps the tip onto a target node.
      this._linkAimMat = new THREE.LineBasicMaterial({
        color: 0x00f3ff,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this._linkLockMat = new THREE.LineBasicMaterial({
        color: 0x00ff9c,
        transparent: true,
        opacity: 1.0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this._linkLine = new THREE.Line(linkGeo, this._linkAimMat);
      this._linkLine.visible = false;
      this._linkLine.frustumCulled = false;   // endpoints move every frame
      this._linkFrom = null;
      this.field.add(this._linkLine);          // lives in field space

      // Auto-aim magnetism radius (field-local units). When the laser tip comes
      // within this of another node's center, the beam snaps to that node.
      this.MAGNET_RADIUS = 2.0;

      // --- Reusable temporaries (avoid per-frame allocations) ------------
      this._tmpVec3 = new THREE.Vector3();
      this._tmpDir = new THREE.Vector3();
      this._tmpMid = new THREE.Vector3();
      this._tmpQuat = new THREE.Quaternion();
      this._up = new THREE.Vector3(0, 1, 0);

      // --- Linear-algebra mode (3B1B-style grid transformer) -------------
      this._buildLinearAlgebra();

      // --- Recursion visualizer (call tree + stack tower) ----------------
      this._buildRecursion();

      this._running = false;
      this._boundResize = () => this.resize();
      window.addEventListener('resize', this._boundResize);
    }

    /* ---------------------------------------------------------------------
     * Cursor reticle — a glowing ring + core that floats at the fingertip.
     * ------------------------------------------------------------------ */
    _makeCursor() {
      const group = new THREE.Group();
      // Uses shared geometry + materials — no per-instance allocation.
      const ring = new THREE.Mesh(SHARED.ringGeo, SHARED.cursorRingMat);
      group.add(ring);
      group.userData.ring = ring;
      group.add(new THREE.Mesh(SHARED.cursorCoreGeo, SHARED.cursorCoreMat));

      group.visible = false;
      group.renderOrder = 999;
      return group;
    }

    /* ---------------------------------------------------------------------
     * Label texture — renders node value onto a canvas used as a sprite/
     * material map. Cached per (value) so repeated values reuse a texture.
     * ------------------------------------------------------------------ */
    _labelTexture(value) {
      const size = 256;
      const cvs = document.createElement('canvas');
      cvs.width = cvs.height = size;
      const ctx = cvs.getContext('2d');

      ctx.clearRect(0, 0, size, size);
      // Soft radial backing so text stays legible over the glass sphere.
      const grad = ctx.createRadialGradient(
        size / 2, size / 2, 10,
        size / 2, size / 2, size / 2
      );
      grad.addColorStop(0, 'rgba(4,10,14,0.85)');
      grad.addColorStop(1, 'rgba(4,10,14,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = 'bold 120px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#00f3ff';
      ctx.shadowBlur = 24;
      ctx.fillStyle = '#eafcff';
      ctx.fillText(String(value), size / 2, size / 2 + 4);

      const tex = new THREE.CanvasTexture(cvs);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      return tex;
    }

    /* ---------------------------------------------------------------------
     * Build a single node group: glass sphere + billboard label sprite.
     * ------------------------------------------------------------------ */
    _createNodeMesh(node) {
      const group = new THREE.Group();
      group.userData.uuid = node.uuid;
      group.userData.kind = 'node';

      const state = STATE_COLORS[node.state] ? node.state : 'default';
      // Shared low-poly geometry; assign the shared per-state material directly.
      // State changes swap the material reference (see _applyNodeColor) rather
      // than mutating color, so we never touch a shared material's properties.
      const sphere = new THREE.Mesh(SHARED.sphereGeo, SHARED.nodeMat[state]);
      sphere.userData.uuid = node.uuid; // so raycast hits resolve to the node
      sphere.userData.kind = 'node';
      group.add(sphere);
      group.userData.sphere = sphere;

      // Outer glow shell (additive) reuses shared geometry + material.
      const glow = new THREE.Mesh(SHARED.glowGeo, SHARED.glowMat[state]);
      group.add(glow);
      group.userData.glow = glow;

      // Precompute an AABB half-extent (world units) for cheap proximity tests.
      group.userData.aabbHalf = NODE_RADIUS * 1.35;

      // Value label as a camera-facing sprite.
      const tex = this._labelTexture(node.value);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
      );
      sprite.scale.set(2.2, 2.2, 1);
      group.add(sprite);
      group.userData.sprite = sprite;
      group.userData.labelValue = node.value;

      group.position.set(node.position.x, node.position.y, node.position.z);
      // Start small and pop in.
      group.scale.setScalar(0.001);
      group.userData.targetScale = 1;
      group.userData.targetPos = new THREE.Vector3(
        node.position.x, node.position.y, node.position.z
      );
      return group;
    }

    /* ---------------------------------------------------------------------
     * Build an edge group: glowing cylinder + optional cone arrowhead.
     * The geometry is unit-height along +Y and re-oriented each frame.
     * ------------------------------------------------------------------ */
    _createEdgeMesh(edge) {
      const group = new THREE.Group();
      group.userData.uuid = edge.uuid;
      group.userData.kind = 'edge';
      group.userData.from = edge.from;
      group.userData.to = edge.to;
      group.userData.directed = edge.directed;

      const state = EDGE_COLORS[edge.state] ? edge.state : 'default';
      // Shared geometry + shared per-state material (no allocation).
      const cyl = new THREE.Mesh(SHARED.cylGeo, SHARED.edgeMat[state]);
      group.add(cyl);
      group.userData.cyl = cyl;

      if (edge.directed) {
        const cone = new THREE.Mesh(SHARED.coneGeo, SHARED.coneMat[state]);
        group.add(cone);
        group.userData.cone = cone;
      }
      return group;
    }

    /* ---------------------------------------------------------------------
     * Public: reconcile the presented model into the scene.
     * Adds new meshes, removes stale ones, updates state/target positions.
     * ------------------------------------------------------------------ */
    setModel(model) {
      if (!model) return;
      const nodes = model.nodes || [];
      const edges = model.edges || [];

      // --- Nodes: add / update ------------------------------------------
      const seenNodes = new Set();
      for (const node of nodes) {
        seenNodes.add(node.uuid);
        let group = this.nodeMeshes.get(node.uuid);
        if (!group) {
          group = this._createNodeMesh(node);
          this.nodeMeshes.set(node.uuid, group);
          this.field.add(group);
        }
        // Update label only if the value changed (BST delete copies values).
        if (group.userData.labelValue !== node.value) {
          const oldMap = group.userData.sprite.material.map;
          group.userData.sprite.material.map = this._labelTexture(node.value);
          group.userData.sprite.material.needsUpdate = true;
          if (oldMap) oldMap.dispose();
          group.userData.labelValue = node.value;
        }
        // Update target position (lerped in the loop).
        group.userData.targetPos.set(
          node.position.x, node.position.y, node.position.z
        );
        group.userData.targetScale = node.state === 'removed' ? 0.001 : 1;
        this._applyNodeColor(group, node.state);
      }
      // --- Nodes: remove stale ------------------------------------------
      for (const [uuid, group] of this.nodeMeshes) {
        if (!seenNodes.has(uuid)) {
          this._disposeGroup(group);
          this.field.remove(group);
          this.nodeMeshes.delete(uuid);
        }
      }

      // --- Edges: add / update ------------------------------------------
      const seenEdges = new Set();
      for (const edge of edges) {
        seenEdges.add(edge.uuid);
        let group = this.edgeMeshes.get(edge.uuid);
        if (!group || group.userData.directed !== edge.directed) {
          if (group) {
            this._disposeGroup(group);
            this.field.remove(group);
          }
          group = this._createEdgeMesh(edge);
          this.edgeMeshes.set(edge.uuid, group);
          this.field.add(group);
        }
        group.userData.from = edge.from;
        group.userData.to = edge.to;
        this._applyEdgeColor(group, edge.state);
      }
      // --- Edges: remove stale ------------------------------------------
      for (const [uuid, group] of this.edgeMeshes) {
        if (!seenEdges.has(uuid)) {
          this._disposeGroup(group);
          this.field.remove(group);
          this.edgeMeshes.delete(uuid);
        }
      }
    }

    _applyNodeColor(group, state) {
      const key = SHARED.nodeMat[state] ? state : 'default';
      if (group.userData.state === key) return; // no-op if unchanged
      // Swap to the pre-built shared material — no property mutation, no alloc.
      group.userData.sphere.material = SHARED.nodeMat[key];
      group.userData.glow.material = SHARED.glowMat[key];
      group.userData.state = key;
    }

    _applyEdgeColor(group, state) {
      const key = SHARED.edgeMat[state] ? state : 'default';
      if (group.userData.state === key) return;
      group.userData.cyl.material = SHARED.edgeMat[key];
      if (group.userData.cone) group.userData.cone.material = SHARED.coneMat[key];
      group.userData.state = key;
    }

    /* ---------------------------------------------------------------------
     * Position an edge group between its two node meshes. Called per frame
     * so edges follow nodes during drags and lerped structural moves.
     * ------------------------------------------------------------------ */
    _updateEdgeTransform(group) {
      const a = this.nodeMeshes.get(group.userData.from);
      const b = this.nodeMeshes.get(group.userData.to);
      if (!a || !b) {
        group.visible = false;
        return;
      }
      group.visible = true;

      const start = a.position;
      const end = b.position;
      // Reuse preallocated temporaries — zero allocation per frame.
      const dir = this._tmpDir.copy(end).sub(start);
      const len = dir.length();
      if (len < 1e-4) {
        group.visible = false;
        return;
      }

      // Shorten so the cylinder stops at the sphere surfaces.
      const gap = NODE_RADIUS;
      const usable = Math.max(len - gap * 2, 0.01);
      const mid = this._tmpMid.copy(start).addScaledVector(dir, 0.5);
      group.position.copy(mid);

      // Orient +Y cylinder to align with dir (dir normalized in place).
      dir.normalize();
      this._tmpQuat.setFromUnitVectors(this._up, dir);
      group.quaternion.copy(this._tmpQuat);

      const cyl = group.userData.cyl;
      cyl.scale.set(1, usable, 1);
      cyl.position.set(0, 0, 0);

      // Place arrowhead just before the target sphere surface.
      if (group.userData.cone) {
        const cone = group.userData.cone;
        // In the group's local frame, +Y points from start->end.
        const half = usable / 2;
        cone.position.set(0, half - 0.1, 0);
      }
    }

    /* ---------------------------------------------------------------------
     * Raycasting cursor. `nx, ny` are normalized 0..1 from the video frame
     * (already un-mirrored by the caller). Returns hovered node uuid (or null)
     * and a world point on the work plane.
     * ------------------------------------------------------------------ */
    updateCursor(nx, ny, visible, pinch = false, forceHover = false) {
      this._cursorActive = !!visible;
      this.cursor.visible = !!visible;
      if (!visible) {
        this._lastRayNx = -999;
        this._lastRayNy = -999;
        return { hovered: null, worldPoint: null };
      }

      // Convert 0..1 (top-left origin) to NDC -1..1 (bottom-left origin).
      this.pointerNDC.x = nx * 2 - 1;
      this.pointerNDC.y = -(ny * 2 - 1);
      this.raycaster.setFromCamera(this.pointerNDC, this.camera);

      // World point on the z=0 work plane. This is cheap ray/plane math (no
      // geometry traversal), so we always update it for smooth dragging.
      const worldPoint = this._lastWorldPoint;
      this.raycaster.ray.intersectPlane(this.workPlane, worldPoint);
      this.cursor.position.copy(worldPoint);

      // ---- Gate the EXPENSIVE hover raycast ----------------------------
      // Per the perf budget, only cast when BOTH the cursor moved past
      // RAYCAST_DELTA AND the user is pinching. We additionally always cast on
      // the pinch-down edge (pinchChanged → true) so onPinchStart gets an
      // accurate grab target the instant the pinch begins.
      const dx = Math.abs(nx - this._lastRayNx);
      const dy = Math.abs(ny - this._lastRayNy);
      const pinchChanged = pinch !== this._lastPinch;
      const moved = dx > this.RAYCAST_DELTA || dy > this.RAYCAST_DELTA;
      const pinchDown = pinchChanged && pinch;
      // `forceHover` lets the linking pose (two-finger pointer — NOT a pinch)
      // resolve node targets while the user isn't pinching.
      const wantCast = pinch || forceHover;

      if ((moved && wantCast) || pinchDown || (forceHover && !this._lastHovered)) {
        this._lastRayNx = nx;
        this._lastRayNy = ny;
        this._lastHovered = this._hoverTest(worldPoint);

        // Recolor cursor ring by swapping the shared material (no mutation).
        const ring = this.cursor.userData.ring;
        ring.material = this._lastHovered
          ? SHARED.cursorRingHoverMat
          : SHARED.cursorRingMat;
      } else if (!wantCast && this._lastHovered) {
        // Released: drop the hover highlight without paying for a raycast.
        this._lastHovered = null;
        this.cursor.userData.ring.material = SHARED.cursorRingMat;
      }

      // Track pinch every call so edge detection stays correct even on frames
      // we don't raycast.
      this._lastPinch = pinch;

      // The cursor reticle floats at the WORLD point (fixed HUD space). But
      // nodes live inside `field`, which may be rotated — so the point handed
      // back for placement/drag/linking must be converted to FIELD-LOCAL space.
      // worldToLocal mutates in place, hence the clone.
      const localPoint = this.field.worldToLocal(worldPoint.clone());

      return {
        hovered: this._lastHovered,
        worldPoint: localPoint,
      };
    }

    /** Re-arm the gentle idle auto-orbit (called when interaction ends). */
    resumeAutoOrbit() {
      this.autoRotate = true;
    }

    /* ---------------------------------------------------------------------
     * ONE-HANDED PINCH → ROTATE FIELD (Ultron replica). `dnx, dny` are the
     * frame-to-frame hand deltas in normalized screen space. We accumulate
     * them into a rotation TARGET; the frame loop eases the live field toward
     * it (ROT_LERP) so the structure spins with weight/momentum. Horizontal
     * hand motion → yaw (rotation.y); vertical → pitch (rotation.x).
     * ------------------------------------------------------------------ */
    rotateField(dnx, dny) {
      this.autoRotate = false;
      this._rotTarget.y += dnx * this.ROT_GAIN;
      this._rotTarget.x += dny * this.ROT_GAIN;
      // Clamp pitch so the field can't tumble fully upside-down.
      const P = Math.PI / 2;
      this._rotTarget.x = Math.max(-P, Math.min(P, this._rotTarget.x));
    }

    /* ---------------------------------------------------------------------
     * TWO-HANDED PINCH → ZOOM (Ultron replica). `spread` is the signed change
     * in inter-hand distance from vision.js (>0 spreading → zoom IN). We map it
     * to a camera-Z TARGET; the frame loop lerps camera.position.z toward it
     * (CAM_LERP = 0.1) for buttery zoom. Smaller Z = closer = zoomed in.
     * ------------------------------------------------------------------ */
    zoomCamera(spread) {
      this.autoRotate = false;
      const ZOOM_GAIN = 60;                 // world units per unit of hand spread
      this._camTarget.z -= spread * ZOOM_GAIN;
      // Clamp to a sane dolly range so you can't fly through or lose the scene.
      this._camTarget.z = Math.max(this.ZOOM_MIN, Math.min(this.ZOOM_MAX, this._camTarget.z));
    }

    /* ---------------------------------------------------------------------
     * TEMP LINK LINE (two-finger edge pointer). A single reusable glowing Line
     * lives inside `field`; we just move its two vertices and toggle visibility
     * — never allocate per gesture. beginLink anchors vertex 0 at a node,
     * updateLink drags vertex 1 to the field-local cursor, endLink hides it.
     * ------------------------------------------------------------------ */
    beginLink(fromUuid) {
      const group = this.nodeMeshes.get(fromUuid);
      if (!group) return false;
      this._linkFrom = fromUuid;
      const pos = this._linkLine.geometry.attributes.position;
      // Vertex 0 = source node position (field-local).
      pos.setXYZ(0, group.position.x, group.position.y, group.position.z);
      pos.setXYZ(1, group.position.x, group.position.y, group.position.z);
      pos.needsUpdate = true;
      this._linkLine.material = this._linkAimMat;   // start in "aiming" state
      this._linkLine.visible = true;
      return true;
    }

    updateLink(localPoint) {
      if (!this._linkLine.visible || !localPoint) return;
      const group = this.nodeMeshes.get(this._linkFrom);
      const pos = this._linkLine.geometry.attributes.position;
      // Re-anchor vertex 0 each frame in case the source node is still lerping.
      if (group) pos.setXYZ(0, group.position.x, group.position.y, group.position.z);
      pos.setXYZ(1, localPoint.x, localPoint.y, localPoint.z);
      pos.needsUpdate = true;
      // Free-flying tip → aiming beam (magnetism, if any, is applied by the
      // caller via snapLinkTo before/after this).
      this._linkLine.material = this._linkAimMat;
    }

    endLink() {
      this._linkLine.visible = false;
      this._linkFrom = null;
    }

    /* ---------------------------------------------------------------------
     * MOUSE FALLBACK SUPPORT ("Draw & Shoot" laser).
     * These mirror the vision path exactly but take raw pixel coordinates.
     * ------------------------------------------------------------------ */

    /**
     * Cast a ray from a pixel coordinate (clientX/clientY, e.g. a MouseEvent)
     * through the scene. Returns { hovered, worldPoint } where worldPoint is
     * FIELD-LOCAL (matching updateCursor), so it can feed beginLink/updateLink,
     * moveNode, or magnetTarget without any extra conversion.
     */
    raycastScreen(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      // Guard against a zero-size canvas (not yet laid out).
      if (!rect.width || !rect.height) return { hovered: null, worldPoint: null };

      const nx = (clientX - rect.left) / rect.width;
      const ny = (clientY - rect.top) / rect.height;
      this.pointerNDC.x = nx * 2 - 1;
      this.pointerNDC.y = -(ny * 2 - 1);
      this.raycaster.setFromCamera(this.pointerNDC, this.camera);

      // World point on the z=0 work plane, then converted to field-local so it
      // stays correct while the field is rotated.
      const worldPoint = this._lastWorldPoint;
      this.raycaster.ray.intersectPlane(this.workPlane, worldPoint);
      const localPoint = this.field.worldToLocal(worldPoint.clone());

      const hovered = this._hoverTest(worldPoint);
      return { hovered, worldPoint: localPoint };
    }

    /**
     * AUTO-AIM MAGNETISM. Given the source node and the laser tip in FIELD-LOCAL
     * space, return the uuid of the nearest OTHER node whose center is within
     * MAGNET_RADIUS of the tip, or null. Nearest wins when several qualify.
     */
    magnetTarget(fromUuid, tipLocalPoint) {
      if (!tipLocalPoint) return null;
      const r2 = this.MAGNET_RADIUS * this.MAGNET_RADIUS;
      let best = null;
      let bestD2 = r2;
      for (const [uuid, group] of this.nodeMeshes) {
        if (uuid === fromUuid) continue;         // never snap back to the source
        const p = group.position;                // field-local, same space as tip
        const dx = p.x - tipLocalPoint.x;
        const dy = p.y - tipLocalPoint.y;
        const dz = p.z - tipLocalPoint.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= bestD2) { bestD2 = d2; best = uuid; }
      }
      return best;
    }

    /**
     * Pin the laser's free vertex exactly onto a node's center and switch the
     * beam to the hot-green "locked" material. Returns false if the target or
     * source mesh is gone.
     */
    snapLinkTo(uuid) {
      if (!this._linkLine.visible) return false;
      const target = this.nodeMeshes.get(uuid);
      const from = this.nodeMeshes.get(this._linkFrom);
      if (!target) return false;
      const pos = this._linkLine.geometry.attributes.position;
      if (from) pos.setXYZ(0, from.position.x, from.position.y, from.position.z);
      pos.setXYZ(1, target.position.x, target.position.y, target.position.z);
      pos.needsUpdate = true;
      this._linkLine.material = this._linkLockMat;  // locked-on glow
      return true;
    }

    /* ---------------------------------------------------------------------
     * Hover test with a cheap AABB proximity pre-filter.
     *
     * Full mesh raycasting walks every triangle of every sphere. Instead we
     * first reject nodes whose bounding box the ray misses (a few multiplies
     * per node), and only run intersectObjects on the tiny surviving set.
     * ------------------------------------------------------------------ */
    _hoverTest(_worldPoint) {
      const ray = this.raycaster.ray;
      const candidates = [];

      // The ray is in WORLD space; node groups sit inside `field`, so their
      // .position is FIELD-LOCAL. We broad-phase against each node's WORLD
      // position (getWorldPosition into a shared temp — no allocation) so the
      // filter stays correct even when the field is rotated. We use only the
      // ray↔point distance test, which is rotation-independent, and skip the
      // old z=0 plane-proximity shortcut (invalid once the field tilts).
      const wp = this._tmpVec3;
      for (const group of this.nodeMeshes.values()) {
        const sphere = group.userData.sphere;
        if (!sphere) continue;
        group.getWorldPosition(wp);
        const half = group.userData.aabbHalf || NODE_RADIUS;

        // Broad phase: does the ray pass within the node's bounding radius?
        // distanceSqToPoint is a handful of ops vs full triangle casting.
        if (ray.distanceSqToPoint(wp) <= half * half) {
          candidates.push(sphere);
        }
      }

      if (candidates.length === 0) return null;
      // Narrow phase: only the survivors get a precise intersection test.
      // intersectObjects respects world matrices, so rotation is handled.
      const hits = this.raycaster.intersectObjects(candidates, false);
      return hits.length ? hits[0].object.userData.uuid : null;
    }

    /** Project a world position back to normalized 0..1 screen coords. */
    worldToScreen(vec3) {
      const v = vec3.clone().project(this.camera);
      return { x: (v.x + 1) / 2, y: (1 - v.y) / 2 };
    }

    /* ---------------------------------------------------------------------
     * Resource disposal to prevent GPU leaks when nodes/edges are removed.
     * ------------------------------------------------------------------ */
    _disposeGroup(group) {
      // IMPORTANT: node/edge geometry and materials are SHARED singletons —
      // disposing them would corrupt every other mesh. We only dispose the
      // per-node sprite label texture/material, which is uniquely allocated.
      const sprite = group.userData.sprite;
      if (sprite && sprite.material) {
        if (sprite.material.map) sprite.material.map.dispose();
        sprite.material.dispose();
      }
    }

    /* =====================================================================
     * LINEAR ALGEBRA MODE — 3Blue1Brown-style grid transformer
     * ---------------------------------------------------------------------
     * A separate scene layer that visualizes a 3x3 matrix as a spatial
     * transform. We keep a static reference grid + a "live" grid that morphs
     * from identity toward the applied matrix M over a timed lerp, plus three
     * basis-vector arrows (î, ĵ, k̂) that track M's columns. All of it lives
     * in `field` so it inherits the same pinch-rotate / zoom as the data
     * structures. It's hidden until enterLinearMode() is called, and the DS
     * layer (nodes/edges/grid) is hidden while it's active.
     * ================================================================== */
    _buildLinearAlgebra() {
      // Container so we can toggle the whole apparatus + rotate with the field.
      this.laGroup = new THREE.Group();
      this.laGroup.visible = false;
      this.field.add(this.laGroup);

      // Grid extent: lines span [-N, N] on each axis, one line per unit. N is
      // deliberately large (effectively "infinite" for this stage) so that even
      // a big transform (Scale 5×, etc.) or a far zoom-out never reveals the
      // grid's edge — the lattice always fills the viewport.
      this._laN = 200;
      const N = this._laN;
      // Max labels we ever draw per axis direction (pool sizing). The ACTUAL
      // labels shown are chosen per-frame from the zoom level (see _laNiceStep /
      // the relabel pass in _updateLinearAlgebra), so numbers thin out when you
      // zoom out and fill in when you zoom in — always ~8-12 ticks on screen.
      this._laLabelMax = 40;

      // The base (undeformed) lattice points, stored as flat Vector3 list per
      // line so applyMatrix can recompute deformed positions each frame without
      // reallocating. We build two coplanar sets (XY plane) of grid lines —
      // this reads as the classic 2D 3B1B grid while still living in 3D.
      this._laBasePoints = [];   // Array<Vector3> — source lattice (identity)

      const positions = [];
      const pushLine = (ax, ay, bx, by) => {
        this._laBasePoints.push(new THREE.Vector3(ax, ay, 0));
        this._laBasePoints.push(new THREE.Vector3(bx, by, 0));
        positions.push(0, 0, 0, 0, 0, 0); // placeholder, filled by _laWriteGeometry
      };
      // Vertical then horizontal grid lines.
      for (let x = -N; x <= N; x++) pushLine(x, -N, x, N);
      for (let y = -N; y <= N; y++) pushLine(-N, y, N, y);

      // Live (morphing) grid.
      const liveGeo = new THREE.BufferGeometry();
      liveGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(positions), 3)
      );
      const liveMat = new THREE.LineBasicMaterial({
        color: 0x00f3ff,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this._laLiveGrid = new THREE.LineSegments(liveGeo, liveMat);
      this._laLiveGrid.frustumCulled = false;
      this.laGroup.add(this._laLiveGrid);

      // Static reference grid (dim, never moves) so the deformation is legible.
      const refGeo = new THREE.BufferGeometry();
      refGeo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(positions.slice()), 3)
      );
      const refMat = new THREE.LineBasicMaterial({
        color: 0x1b3a44,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      });
      this._laRefGrid = new THREE.LineSegments(refGeo, refMat);
      this._laRefGrid.frustumCulled = false;
      this.laGroup.add(this._laRefGrid);
      // Reference grid is identity forever — fill it once.
      this._laWriteGeometry(this._laRefGrid.geometry, IDENTITY3);

      // Basis-vector arrows: î (x, green), ĵ (y, red), k̂ (z, purple).
      this._laBasis = [
        this._makeBasisArrow(0x00ff9c), // î
        this._makeBasisArrow(0xff3860), // ĵ
        this._makeBasisArrow(0xbd00ff), // k̂
      ];
      this._laBasis.forEach((a) => this.laGroup.add(a));

      // Matrix animation state. `from`/`to` are 9-element column-major arrays
      // (matching THREE.Matrix3.elements); `t` eases 0→1 over LA_LERP_TIME.
      this._laFrom = IDENTITY3.slice();
      this._laTo = IDENTITY3.slice();
      this._laT = 1;                 // 1 == settled (no animation pending)
      this._laDisplayed = IDENTITY3.slice();
      this.LA_LERP_TIME = 2.0;       // seconds for a matrix transition (spec: 2s)
      this._laActive = false;
      this._laGrabbed = null;        // index of basis vector being dragged, or null
      this._laHi = null;             // index of currently highlighted basis arrow
      // All three basis tips (î, ĵ, k̂) are grabbable. Picking is done in screen
      // space (see laPickScreen) so k̂ — which points toward the camera in the
      // tilted view — can be grabbed just like the in-plane vectors.
      this.LA_GRAB_RADIUS = 0.9;     // field-local pick radius (legacy hand path)
      this.LA_PICK_PX = 26;          // screen-space pick radius in pixels (mouse)

      // 3D mode (Part B). `_la3D` toggles between the flat XY plane (default) and
      // a full 3D coordinate cage. User-inserted vectors live in `_laVectors`;
      // each is transformed by the SAME live matrix every frame (displayed = M·v)
      // so applying a matrix animates the vectors alongside the lattice.
      this._la3D = false;
      this._laVectors = [];          // Array<{ id, v:Vector3, arrow:ArrowHelper }>
      this._laVecNextId = 1;
      // A modest three-plane 3D lattice (XY/XZ/YZ) + Z axis, hidden until 3D mode.
      this._laBuild3DGrid();

      // Bright X/Y axes + integer number labels on the STATIC reference frame,
      // so the moving grid can be read against a fixed Cartesian coordinate system.
      this._laBuildAxes();

      // Seed geometry + arrows at identity.
      this._laApplyDisplayed(IDENTITY3.slice());
    }

    /**
     * Build the static Cartesian reference: two bright axis lines (X, Y) through
     * the origin, plus a POOL of reusable number sprites. The pool is positioned
     * + relabeled every frame from the zoom level (see _updateLinearAlgebra), so
     * which coordinates show adapts to the visible viewport — the 3B1B "nice
     * step" behaviour. All parented to laGroup so they toggle + orbit together.
     */
    _laBuildAxes() {
      const N = this._laN;

      // --- Axis lines (slightly brighter than the reference lattice) --------
      // X and Y always; Z is prebuilt but only shown in 3D mode (Part B).
      const axisGeo = new THREE.BufferGeometry();
      axisGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -N, 0, 0, N, 0, 0,   // X axis
        0, -N, 0, 0, N, 0,   // Y axis
      ]), 3));
      const axisMat = new THREE.LineBasicMaterial({
        color: 0x4a6b78, transparent: true, opacity: 0.85, depthWrite: false,
      });
      this._laAxes = new THREE.LineSegments(axisGeo, axisMat);
      this._laAxes.frustumCulled = false;
      this.laGroup.add(this._laAxes);

      // --- Reusable label pool ----------------------------------------------
      // Enough sprites for ~maxLabels ticks per axis (X + Y, both signs) plus a
      // margin. Each carries its own canvas texture so _laSetLabel can rewrite
      // the digits in place (no per-frame allocation).
      this._laLabelPool = [];
      const poolSize = this._laLabelMax * 4 + 4;
      for (let i = 0; i < poolSize; i++) {
        const s = this._laMakeLabel('');
        s.visible = false;
        this.laGroup.add(s);
        this._laLabelPool.push(s);
      }
      // Relabel bookkeeping so we only redraw canvases when the tick set changes.
      this._laLastStep = -1;
      this._laLastRangeKey = '';
    }

    /**
     * A number sprite backed by its OWN canvas + texture so the digits can be
     * rewritten in place via _laSetLabel. Camera-facing; sized in world units.
     */
    _laMakeLabel(text) {
      const cvs = document.createElement('canvas');
      cvs.width = 64; cvs.height = 64;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(cvs), transparent: true,
        depthWrite: false, depthTest: false,
      }));
      sprite.userData.canvas = cvs;
      sprite.userData.text = null;
      sprite.scale.set(0.7, 0.7, 1);
      if (text) this._laSetLabel(sprite, text);
      return sprite;
    }

    /** Rewrite a pooled label sprite's text in place (skips redundant redraws). */
    _laSetLabel(sprite, text) {
      if (sprite.userData.text === text) return;
      sprite.userData.text = text;
      const cvs = sprite.userData.canvas;
      const ctx = cvs.getContext('2d');
      ctx.clearRect(0, 0, 64, 64);
      ctx.fillStyle = '#8fb3c2';
      ctx.font = 'bold 30px "SFMono-Regular", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 32, 34);
      sprite.material.map.needsUpdate = true;
    }

    /**
     * Choose a "nice" tick step (1,2,5,10,20,50,100…) from the current zoom so
     * that ~TARGET ticks fall across the visible half-width. camZ is the camera
     * dolly distance (larger = zoomed out). Returns an integer step ≥ 1.
     */
    _laNiceStep(camZ) {
      // Visible half-extent in world units ≈ camZ * tan(fov/2) * aspect, plus a
      // little slack. We only need it proportional to camZ for step selection.
      const halfWidth = Math.max(2, camZ) * 0.62;   // empirical: fills the panel
      const TARGET = 9;                              // aim for ~9 ticks per side
      const raw = (halfWidth * 2) / TARGET;          // ideal spacing in units
      // Snap raw up to the nearest 1·10^k / 2·10^k / 5·10^k.
      const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
      const frac = raw / pow;
      let nice;
      if (frac <= 1) nice = 1;
      else if (frac <= 2) nice = 2;
      else if (frac <= 5) nice = 5;
      else nice = 10;
      return Math.max(1, Math.round(nice * pow));
    }

    /** Build one basis-vector arrow (unit length along +X; oriented later). */
    _makeBasisArrow(color) {
      const dir = new THREE.Vector3(1, 0, 0);
      const origin = new THREE.Vector3(0, 0, 0);
      const arrow = new THREE.ArrowHelper(dir, origin, 1, color, 0.4, 0.24);
      // Make the shaft a touch brighter/additive so it glows over the grid.
      if (arrow.line && arrow.line.material) {
        arrow.line.material.transparent = true;
        arrow.line.material.opacity = 0.95;
      }
      arrow.frustumCulled = false;
      return arrow;
    }

    /**
     * Write deformed lattice positions into a LineSegments geometry given a
     * column-major 3x3 matrix `m` (9 floats). Each base point p maps to M·p.
     */
    _laWriteGeometry(geometry, m, pts) {
      const attr = geometry.getAttribute('position');
      const arr = attr.array;
      pts = pts || this._laBasePoints;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        // Column-major: col0=(m0,m1,m2), col1=(m3,m4,m5), col2=(m6,m7,m8).
        const x = m[0] * p.x + m[3] * p.y + m[6] * p.z;
        const y = m[1] * p.x + m[4] * p.y + m[7] * p.z;
        const z = m[2] * p.x + m[5] * p.y + m[8] * p.z;
        const o = i * 3;
        arr[o] = x; arr[o + 1] = y; arr[o + 2] = z;
      }
      attr.needsUpdate = true;
    }

    /** Point the three basis arrows along the columns of column-major `m`. */
    _laUpdateBasis(m) {
      const cols = [
        this._tmpVec3.set(m[0], m[1], m[2]).clone(), // î
        this._tmpVec3.set(m[3], m[4], m[5]).clone(), // ĵ
        this._tmpVec3.set(m[6], m[7], m[8]).clone(), // k̂
      ];
      for (let i = 0; i < 3; i++) {
        const v = cols[i];
        const len = v.length();
        if (len > 1e-6) {
          this._laBasis[i].visible = true;
          this._laBasis[i].setDirection(v.clone().normalize());
          this._laBasis[i].setLength(len, Math.min(0.4, len * 0.28), Math.min(0.24, len * 0.16));
        } else {
          // Degenerate (collapsed) column — hide the arrow rather than NaN.
          this._laBasis[i].visible = false;
        }
      }
    }

    /** Push a fully-resolved displayed matrix into geometry + arrows. */
    _laApplyDisplayed(m) {
      this._laDisplayed = m;
      this._laWriteGeometry(this._laLiveGrid.geometry, m);
      this._laUpdateBasis(m);
      // 3D lattice morphs with the same matrix when present + visible.
      if (this._la3DGrid && this._la3DGrid.visible) {
        this._laWriteGeometry(this._la3DGrid.geometry, m, this._la3DBasePoints);
      }
      // Re-point every user vector to M·v (column-major mapping, same as grid).
      for (const rec of this._laVectors) {
        const p = rec.v;
        const x = m[0] * p.x + m[3] * p.y + m[6] * p.z;
        const y = m[1] * p.x + m[4] * p.y + m[7] * p.z;
        const z = m[2] * p.x + m[5] * p.y + m[8] * p.z;
        const dir = this._tmpVec3.set(x, y, z);
        const len = dir.length();
        if (len > 1e-6) {
          rec.arrow.visible = true;
          rec.arrow.setDirection(dir.clone().normalize());
          rec.arrow.setLength(len, Math.min(0.5, len * 0.22), Math.min(0.3, len * 0.14));
        } else {
          rec.arrow.visible = false;
        }
      }
    }

    /**
     * Build the 3D coordinate cage: three families of grid lines on the XY, XZ
     * and YZ planes plus a Z axis, kept modest in extent so the line count stays
     * cheap. Hidden until setLinearDimension('3d'). Morphs via _laWriteGeometry
     * against `_la3DBasePoints` (same column-major transform as the 2D lattice).
     */
    _laBuild3DGrid() {
      // Smaller than the 2D "infinite" plane — a readable boxed cage.
      const M = 8;
      this._la3DBasePoints = [];
      const positions = [];
      const seg = (ax, ay, az, bx, by, bz) => {
        this._la3DBasePoints.push(new THREE.Vector3(ax, ay, az));
        this._la3DBasePoints.push(new THREE.Vector3(bx, by, bz));
        positions.push(0, 0, 0, 0, 0, 0);
      };
      for (let i = -M; i <= M; i++) {
        seg(i, -M, 0, i, M, 0); seg(-M, i, 0, M, i, 0); // XY plane
        seg(i, 0, -M, i, 0, M); seg(-M, 0, i, M, 0, i); // XZ plane
        seg(0, i, -M, 0, i, M); seg(0, -M, i, 0, M, i); // YZ plane
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x0f6b7a, transparent: true, opacity: 0.28,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      this._la3DGrid = new THREE.LineSegments(geo, mat);
      this._la3DGrid.frustumCulled = false;
      this._la3DGrid.visible = false;
      this.laGroup.add(this._la3DGrid);

      // Z axis line (X and Y already exist in _laBuildAxes).
      const zGeo = new THREE.BufferGeometry();
      zGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        0, 0, -this._laN, 0, 0, this._laN,
      ]), 3));
      this._laZAxis = new THREE.LineSegments(zGeo, new THREE.LineBasicMaterial({
        color: 0x4a6b78, transparent: true, opacity: 0.85, depthWrite: false,
      }));
      this._laZAxis.frustumCulled = false;
      this._laZAxis.visible = false;
      this.laGroup.add(this._laZAxis);
    }

    /**
     * Switch between the flat 2D plane and the full 3D cage. In 3D the flat
     * lattice is hidden in favour of the three-plane cage + Z axis, and the
     * camera pulls back to a livelier orbit tilt so depth reads clearly.
     */
    setLinearDimension(mode) {
      const three = mode === '3d';
      this._la3D = three;
      this._la3DGrid.visible = three;
      this._laZAxis.visible = three;
      // In 3D, dim the "infinite" flat plane so the cage doesn't fight it; the
      // live+ref flat grids are the 2D stage, so hide them in 3D.
      this._laLiveGrid.visible = !three;
      this._laRefGrid.visible = !three;
      // Force a relabel (Z ticks appear/disappear) and re-apply current matrix.
      this._laLastRangeKey = '';
      if (three) {
        this.field.rotation.set(-0.6, 0.7, 0, 'YXZ');
        this._rotTarget.set(-0.6, 0.7, 0, 'YXZ');
      } else {
        this.field.rotation.set(-0.35, 0.45, 0, 'YXZ');
        this._rotTarget.set(-0.35, 0.45, 0, 'YXZ');
      }
      this._laApplyDisplayed(this._laDisplayed.slice());
    }

    /** Colour ramp for successive user vectors (cycles). */
    _laVecColor(i) {
      const ramp = [0xffd166, 0x06d6a0, 0xef476f, 0x118ab2, 0xf78c6b, 0x9b5de5];
      return ramp[i % ramp.length];
    }

    /**
     * Add a user vector (x,y,z). Returns its id. The arrow is immediately placed
     * under the current displayed matrix (so it animates in if a transform is
     * active). Reuses the basis-arrow factory for a consistent look.
     */
    laAddVector(x, y, z) {
      const color = this._laVecColor(this._laVecNextId - 1);
      const arrow = this._makeBasisArrow(color);
      this.laGroup.add(arrow);
      const rec = { id: this._laVecNextId++, v: new THREE.Vector3(x, y, z), arrow };
      this._laVectors.push(rec);
      // Position it against whatever is currently displayed.
      this._laApplyDisplayed(this._laDisplayed.slice());
      return { id: rec.id, color };
    }

    /** Remove a user vector by id. */
    laRemoveVector(id) {
      const i = this._laVectors.findIndex((r) => r.id === id);
      if (i === -1) return;
      const [rec] = this._laVectors.splice(i, 1);
      this.laGroup.remove(rec.arrow);
      if (rec.arrow.dispose) rec.arrow.dispose();
    }

    /** Remove all user vectors (called on exit/reset). */
    laClearVectors() {
      for (const rec of this._laVectors) {
        this.laGroup.remove(rec.arrow);
        if (rec.arrow.dispose) rec.arrow.dispose();
      }
      this._laVectors = [];
    }

    /**
     * Enter linear-algebra mode: hide the data-structure layer, show the grid
     * transformer, and reset to identity. Auto-orbit is disabled so the user
     * can read the transform head-on (they can still pinch-rotate).
     */
    enterLinearMode() {
      this._laActive = true;
      this.laGroup.visible = true;
      // Hide DS layer (nodes, edges, ground grid, link line) for a clean stage.
      for (const g of this.nodeMeshes.values()) g.visible = false;
      for (const g of this.edgeMeshes.values()) g.visible = false;
      this.grid.visible = false;
      this._linkLine.visible = false;
      // Tilt to a gentle 3/4 view (not dead head-on) so the purple k̂ vector
      // visibly sticks out of the z=0 plane and can be grabbed; the XY grid +
      // numbers stay readable in perspective. User can still pinch/drag to orbit.
      this.autoRotate = false;
      this._camTarget.set(0, 2, 24);
      this.field.rotation.set(-0.35, 0.45, 0, 'YXZ');
      this._rotTarget.set(-0.35, 0.45, 0, 'YXZ');
      this.resetMatrix(true);
      // Always start in 2D; the UI toggle drives 3D.
      if (this._la3D) this.setLinearDimension('2d');
    }

    /** Leave linear-algebra mode and restore the data-structure layer. */
    exitLinearMode() {
      this._laActive = false;
      this.laGroup.visible = false;
      this.laClearVectors();
      for (const g of this.nodeMeshes.values()) g.visible = true;
      for (const g of this.edgeMeshes.values()) g.visible = true;
      this.grid.visible = true;
    }

    /**
     * Animate toward a new transform. `elements` is a column-major 9-float
     * array (THREE.Matrix3 order). The live grid + arrows lerp from whatever
     * is currently displayed to `elements` over LA_LERP_TIME seconds.
     */
    applyMatrix(elements) {
      if (!elements || elements.length !== 9) return;
      this._laFrom = this._laDisplayed.slice();
      this._laTo = elements.slice();
      this._laT = 0;               // kick off the animated transition
      this._laClockLast = this._clock.getElapsedTime();
    }

    /** Snap (or animate) back to the identity transform. */
    resetMatrix(immediate = false) {
      if (immediate) {
        this._laFrom = IDENTITY3.slice();
        this._laTo = IDENTITY3.slice();
        this._laT = 1;
        this._laApplyDisplayed(IDENTITY3.slice());
      } else {
        this.applyMatrix(IDENTITY3.slice());
      }
    }

    /** Per-frame linear-algebra tween (called from _frame while active). */
    _updateLinearAlgebra(t) {
      if (!this._laActive) return;

      // Zoom-adaptive coordinate labels run EVERY frame (zoom can change even
      // when the matrix tween is settled), before the early-out below.
      this._laRelabel();

      if (this._laT >= 1) return;
      // Advance eased parameter by real elapsed delta.
      const last = this._laClockLast === undefined ? t : this._laClockLast;
      const dt = Math.max(0, t - last);
      this._laClockLast = t;
      this._laT = Math.min(1, this._laT + dt / this.LA_LERP_TIME);
      // Smoothstep for a gentle ease-in-out.
      const e = this._laT * this._laT * (3 - 2 * this._laT);
      const from = this._laFrom, to = this._laTo;
      const cur = this._laDisplayed;
      for (let i = 0; i < 9; i++) cur[i] = from[i] + (to[i] - from[i]) * e;
      this._laApplyDisplayed(cur);
    }

    /**
     * Reposition + relabel the pooled number sprites from the current zoom. Picks
     * a nice step, lays labels at multiples of it across the visible range on the
     * X and Y axes (and Z when in 3D mode), hides the unused pool tail. Canvas
     * redraws only happen when the step or visible range actually changed.
     */
    _laRelabel() {
      const pool = this._laLabelPool;
      if (!pool || !pool.length) return;

      const camZ = this.camera.position.z;
      const step = this._laNiceStep(camZ);
      // Visible half-extent in world units (matches _laNiceStep's model), capped
      // to the lattice bound so we never place labels past the grid.
      const half = Math.min(this._laN, Math.max(step * 2, camZ * 0.62));
      const kMax = Math.floor(half / step);
      const rangeKey = step + ':' + kMax + ':' + (this._la3D ? '3' : '2');

      // Nothing changed since last frame → skip the whole rebuild.
      if (rangeKey === this._laLastRangeKey) return;
      this._laLastRangeKey = rangeKey;
      this._laLastStep = step;

      const OFF = 0.42 * (step >= 10 ? 1.4 : 1);   // small offset from the axis
      let p = 0;
      const place = (text, x, y, z) => {
        if (p >= pool.length) return;
        const s = pool[p++];
        this._laSetLabel(s, text);
        s.position.set(x, y, z || 0);
        s.visible = true;
      };

      // Origin marker.
      place('0', -OFF, -OFF, 0);
      // X and Y ticks at multiples of step (skip 0 — handled above).
      for (let k = 1; k <= kMax; k++) {
        const v = k * step;
        place(String(v), v, -OFF, 0);
        place(String(-v), -v, -OFF, 0);
        place(String(v), -OFF, v, 0);
        place(String(-v), -OFF, v * -1, 0);
      }
      // Z ticks only in 3D mode.
      if (this._la3D) {
        for (let k = 1; k <= kMax; k++) {
          const v = k * step;
          place(String(v), -OFF, 0, v);
          place(String(-v), -OFF, 0, -v);
        }
      }
      // Hide the unused tail.
      for (; p < pool.length; p++) pool[p].visible = false;
    }

    /* ---------------------------------------------------------------------
     * DIRECT MANIPULATION — grab a basis-vector tip and drag it (3B1B-style).
     * Both hand-pinch and mouse route through these. Points are FIELD-LOCAL
     * (same space updateCursor/raycastScreen already return), matching the
     * basis tips which live at the columns of the displayed matrix.
     * ------------------------------------------------------------------ */

    /**
     * Return the index (0=î, 1=ĵ) of the nearest grabbable basis tip within
     * LA_GRAB_RADIUS of `localPoint`, or null. Used for hover + grab arming.
     */
    laBasisPick(localPoint) {
      if (!this._laActive || !localPoint) return null;
      const m = this._laDisplayed;
      let best = null;
      let bestD2 = this.LA_GRAB_RADIUS * this.LA_GRAB_RADIUS;
      for (let i = 0; i < 2; i++) {
        const tx = m[i * 3], ty = m[i * 3 + 1], tz = m[i * 3 + 2];
        const dx = tx - localPoint.x;
        const dy = ty - localPoint.y;
        const dz = tz - localPoint.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= bestD2) { bestD2 = d2; best = i; }
      }
      return best;
    }

    /**
     * Screen-space pick: project all THREE basis tips (î, ĵ, k̂) to pixels and
     * return the index of the nearest within LA_PICK_PX, or null. Unlike
     * laBasisPick (which measures distance on the flat z=0 plane and so can't
     * see k̂ once it points toward the camera), this works for every arrow in
     * the tilted 3D view because it compares actual on-screen positions.
     */
    laPickScreen(clientX, clientY) {
      if (!this._laActive) return null;
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      const m = this._laDisplayed;
      const PICK = this.LA_PICK_PX || 26;
      let best = null;
      let bestD2 = PICK * PICK;
      for (let i = 0; i < 3; i++) {
        // Basis tip is field-local at column i of the displayed matrix.
        const tip = this._tmpVec3.set(m[i * 3], m[i * 3 + 1], m[i * 3 + 2]);
        const world = this.field.localToWorld(tip.clone());
        world.project(this.camera);                 // → NDC
        // Behind the camera → skip.
        if (world.z > 1) continue;
        const sx = (world.x * 0.5 + 0.5) * rect.width;
        const sy = (-world.y * 0.5 + 0.5) * rect.height;
        const dx = sx - px, dy = sy - py;
        const d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) { bestD2 = d2; best = i; }
      }
      return best;
    }

    /**
     * Screen-space drag of the grabbed basis tip. Casts the cursor ray into the
     * scene and intersects the correct plane for the grabbed axis, then rewrites
     * that matrix column (field-local) and refreshes the grid. Returns the new
     * column-major matrix (for the UI to mirror), or null.
     *
     *   î / ĵ  → constrained to the grid's own plane (the field-local z=0 plane,
     *            expressed in world space so it stays correct when the view is
     *            tilted or orbited). Keeps the two in-plane vectors in-plane.
     *   k̂      → a camera-facing plane through the origin, giving full 3D reach
     *            so the purple arrow can be pulled out of / into the plane.
     */
    laDragScreen(clientX, clientY) {
      const i = this._laGrabbed;
      if (i === null || i === undefined) return null;
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;

      this.pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNDC.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      this.raycaster.setFromCamera(this.pointerNDC, this.camera);

      // Field origin in world space, and the field's local +Z axis in world.
      const originW = this.field.localToWorld(this._tmpVec3.set(0, 0, 0).clone());
      let normalW;
      if (i === 2) {
        // k̂: face the camera so depth is reachable.
        normalW = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      } else {
        // î/ĵ: the grid plane. Field-local +Z transformed to world (rotation
        // only), so a tilted/orbited field still constrains the drag correctly.
        normalW = new THREE.Vector3(0, 0, 1)
          .applyQuaternion(this.field.getWorldQuaternion(new THREE.Quaternion()))
          .normalize();
      }
      const plane = this._laDragPlane || (this._laDragPlane = new THREE.Plane());
      plane.setFromNormalAndCoplanarPoint(normalW, originW);

      const hitW = this._laDragHit || (this._laDragHit = new THREE.Vector3());
      if (!this.raycaster.ray.intersectPlane(plane, hitW)) return null;

      // World hit → field-local, which is the space the matrix columns live in.
      const local = this.field.worldToLocal(hitW.clone());
      const m = this._laDisplayed;
      m[i * 3] = local.x;
      m[i * 3 + 1] = local.y;
      m[i * 3 + 2] = (i === 2) ? local.z : 0;   // î/ĵ pinned to the plane
      this._laFrom = m.slice();
      this._laTo = m.slice();
      this._laApplyDisplayed(m);
      return m.slice();
    }

    /** Highlight (or clear) the basis arrow the cursor is hovering/holding. */
    laHighlightBasis(index) {
      if (this._laHi === index) return;
      this._laHi = index;
      const HI = [0x6effe0, 0xff7da0, 0xd98cff];   // brightened î/ĵ/k̂ tints
      const BASE = [0x00ff9c, 0xff3860, 0xbd00ff];
      for (let i = 0; i < 3; i++) {
        this._laBasis[i].setColor(i === index ? HI[i] : BASE[i]);
      }
    }

    /** Begin dragging basis vector `index`. Freezes any running tween. */
    laGrabBasis(index) {
      if (index === null || index === undefined) return false;
      this._laGrabbed = index;
      // Settle the tween onto the current displayed matrix so the drag starts
      // exactly where the arrow visually is (no snap).
      this._laFrom = this._laDisplayed.slice();
      this._laTo = this._laDisplayed.slice();
      this._laT = 1;
      this.laHighlightBasis(index);
      return true;
    }

    /**
     * Drag the grabbed basis tip to `localPoint`, rewriting that column of the
     * matrix and refreshing the grid immediately (no animation). Returns the
     * updated column-major matrix so the UI form can mirror it, or null.
     */
    laDragBasisTo(localPoint) {
      const i = this._laGrabbed;
      if (i === null || i === undefined || !localPoint) return null;
      const m = this._laDisplayed;
      m[i * 3] = localPoint.x;
      m[i * 3 + 1] = localPoint.y;
      m[i * 3 + 2] = 0;                  // keep the drag in the z=0 grid plane
      // Keep from/to pinned to the live matrix so no tween fights the drag.
      this._laFrom = m.slice();
      this._laTo = m.slice();
      this._laApplyDisplayed(m);
      return m.slice();
    }

    /** Release the grabbed basis vector. Returns the final matrix, or null. */
    laReleaseBasis() {
      if (this._laGrabbed === null || this._laGrabbed === undefined) return null;
      const m = this._laDisplayed.slice();
      this._laGrabbed = null;
      this.laHighlightBasis(null);
      return m;
    }

    /** Is a basis vector currently being dragged? */
    get laIsGrabbing() {
      return this._laGrabbed !== null && this._laGrabbed !== undefined;
    }

    /* =====================================================================
     * RECURSION VISUALIZER (Phase 4)
     *
     * Two coordinated views of the SAME call state, driven by the engine's
     * per-step `frame` snapshot (see dsaEngine `_recFrame`):
     *
     *   • CALL-TREE  — every call becomes an activation node placed by
     *     (depth → y, sibling order → x); parent→child links light up as the
     *     recursion descends and dim on return. Lives in `field`, so it
     *     inherits pinch-rotate / zoom like the data structures.
     *
     *   • STACK-TOWER — the live call stack as a vertical stack of labeled
     *     blocks, screen-anchored to the right so it reads like a real stack
     *     frame diagram. Pushes on `call`, pops (fades) on `return`.
     *
     * Both reuse pooled meshes/sprites — nothing is allocated per step.
     * The DS layer (nodes/edges/grid) is hidden while recursion mode is on.
     * ================================================================== */
    _buildRecursion() {
      // --- CALL-TREE group (rotates with the field) ----------------------
      this._recTreeGroup = new THREE.Group();
      this._recTreeGroup.visible = false;
      this.field.add(this._recTreeGroup);

      // --- STACK-TOWER group (screen-anchored: child of camera) ----------
      // Parenting to the camera keeps the tower fixed on-screen regardless of
      // field rotation / camera dolly, giving it that HUD-diagram feel.
      this._recStackGroup = new THREE.Group();
      this._recStackGroup.visible = false;
      this.camera.add(this._recStackGroup);
      // Ensure the camera is in the scene graph so its child renders.
      if (!this.camera.parent) this.scene.add(this.camera);
      // Park the tower toward the right of the view, a fixed distance ahead.
      // `_recStackBaseY` is the resting y of the tower's foot; deep-recursion
      // fit slides/scales the group around this base.
      this._recStackBasePos = new THREE.Vector3(8.5, -8.0, -22);
      this._recStackGroup.position.copy(this._recStackBasePos);
      this._recStackFitScale = 1;    // lerp target for deep-recursion scaling
      this._recStackFitY = 0;        // lerp target extra y-shift

      // Pools (grown on demand, hidden when unused — never freed).
      this._recNodePool = [];   // activation-node meshes for the tree
      this._recLinkPool = [];   // parent→child lines for the tree
      this._recArrowPool = [];  // directed-edge arrowheads for the tree
      this._recBlockPool = [];  // stack-frame blocks for the tower

      // Single return-value bubble sprite (travels an edge on return). Pooled
      // as one because only one return resolves per step.
      this._recBubble = new THREE.Sprite(
        new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false })
      );
      this._recBubble.scale.set(2.4, 1.2, 1);
      this._recBubble.visible = false;
      this._recTreeGroup.add(this._recBubble);
      this._recBubbleAnim = null;    // {fromX,fromY,toX,toY,text,start,dur}

      // Transient stack flourish (push slide-in / pop slide-off ghost).
      this._recStackAnim = null;     // {kind:'push'|'pop', start, dur, ...}

      this._recActive = false;
      this._recMode = 'tree';   // 'tree' | 'stack'
      this._recLastStepIndex = -1;
      this._recPrevFrame = null;

      // Layout constants.
      this.REC_X_SPACING = 3.4;
      this.REC_Y_SPACING = 4.2;
      this.REC_BLOCK_H = 2.9;   // stack block height + gap (block geo is 2.6)
      this.REC_TREE_TOP_Y = 8;  // y of the root row before fit-scaling
      this.REC_ANIM_MS = 520;   // flourish duration
    }

    /**
     * A small labeled activation node: a rounded box + a billboard text label.
     * Reused from a pool. `_recLabelTexture` caches per-string canvases.
     */
    _makeRecNode() {
      const group = new THREE.Group();
      const box = new THREE.Mesh(SHARED.recNodeGeo, SHARED.recNodeMat.active.clone());
      group.add(box);
      group.userData.box = box;

      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ transparent: true, depthWrite: false, depthTest: false })
      );
      sprite.scale.set(3.0, 1.5, 1);
      sprite.position.set(0, 0, 0.35);
      group.add(sprite);
      group.userData.sprite = sprite;
      group.userData.labelKey = null;
      group.visible = false;
      this._recTreeGroup.add(group);
      return group;
    }

    /**
     * A stack-frame block for the tower: a glass-morphic BoxGeometry with a
     * multi-line face plane (signature + args + locals + return slot) sitting on
     * the +z face so it reads head-on. Pooled.
     */
    _makeRecBlock() {
      const group = new THREE.Group();
      const box = new THREE.Mesh(SHARED.recBlockGeo, SHARED.recGlassMat.active.clone());
      group.add(box);
      group.userData.box = box;

      // Face plane carries the multi-line canvas texture, parked just proud of
      // the block's front (+z) face.
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(5.0, 2.3),
        new THREE.MeshBasicMaterial({
          transparent: true, depthWrite: false, opacity: 0.98,
        })
      );
      face.position.set(0, 0, 0.42);
      group.add(face);
      group.userData.face = face;
      group.userData.labelKey = null;
      group.visible = false;
      this._recStackGroup.add(group);
      return group;
    }

    /** A thin line connecting two tree points. Pooled. */
    _makeRecLink() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, SHARED.recLinkMat.idle.clone());
      line.frustumCulled = false;
      line.visible = false;
      this._recTreeGroup.add(line);
      return line;
    }

    /** A cone arrowhead marking edge direction (parent → child). Pooled. */
    _makeRecArrow() {
      const arrow = new THREE.Mesh(SHARED.recArrowGeo, SHARED.recArrowMat.idle);
      arrow.visible = false;
      this._recTreeGroup.add(arrow);
      return arrow;
    }

    /** Canvas label texture for recursion tree nodes, cached by text. */
    _recLabelTexture(text) {
      if (!this._recLabelCache) this._recLabelCache = new Map();
      if (this._recLabelCache.has(text)) return this._recLabelCache.get(text);
      const w = 256, h = 128;
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const ctx = cvs.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      ctx.font = 'bold 44px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = '#00f3ff';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#eafcff';
      ctx.fillText(text, w / 2, h / 2 + 2);
      const tex = new THREE.CanvasTexture(cvs);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this._recLabelCache.set(text, tex);
      return tex;
    }

    /**
     * Multi-line stack-frame face texture: function signature, arguments, local
     * variables, and a return slot — the "OS stack frame" teaching abstraction.
     * Cached by a composite key so repeated faces reuse one canvas.
     */
    _recBlockTexture(f, accent) {
      if (!this._recBlockCache) this._recBlockCache = new Map();
      const argStr = (f.args || []).map((a) => `${a.name}=${a.value}`).join(', ');
      const localStr = (f.locals || []).map((l) => `${l.name}=${l.value}`).join('  ');
      const retStr = f.result !== null && f.result !== undefined ? String(f.result) : '·';
      const key = `${accent}|${f.label}|${argStr}|${localStr}|${retStr}`;
      if (this._recBlockCache.has(key)) return this._recBlockCache.get(key);

      const w = 512, h = 240;
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const ctx = cvs.getContext('2d');
      ctx.clearRect(0, 0, w, h);

      // Panel backdrop for legibility over the transparent glass block.
      ctx.fillStyle = 'rgba(6, 20, 28, 0.55)';
      this._roundRect(ctx, 6, 6, w - 12, h - 12, 16);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = accent;
      ctx.stroke();

      ctx.textBaseline = 'middle';
      // Signature (function + params).
      ctx.textAlign = 'left';
      ctx.font = 'bold 40px "Consolas", "SFMono-Regular", monospace';
      ctx.fillStyle = '#eafcff';
      ctx.fillText(f.label, 28, 46);

      // Args line.
      ctx.font = '26px "Consolas", monospace';
      ctx.fillStyle = '#9fe8ff';
      ctx.fillText(`args: ${argStr || '—'}`, 28, 96);

      // Locals line(s).
      ctx.fillStyle = '#c9b8ff';
      ctx.fillText(`local: ${localStr || '—'}`, 28, 138);

      // Return slot.
      ctx.font = 'bold 30px "Consolas", monospace';
      ctx.fillStyle = accent;
      ctx.fillText(`return: ${retStr}`, 28, 190);

      const tex = new THREE.CanvasTexture(cvs);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      this._recBlockCache.set(key, tex);
      return tex;
    }

    /** Rounded-rect path helper for canvas faces. */
    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /** Set a pooled tree node's label sprite, reusing cached textures. */
    _recSetLabel(group, text) {
      if (group.userData.labelKey === text) return;
      group.userData.sprite.material.map = this._recLabelTexture(text);
      group.userData.sprite.material.needsUpdate = true;
      group.userData.labelKey = text;
    }

    /** Set a pooled stack block's multi-line face texture. */
    _recSetBlockFace(group, f, accentHex) {
      const key = `${accentHex}|${f.label}|${(f.args || []).map((a) => a.name + a.value).join()}` +
        `|${(f.locals || []).map((l) => l.name + l.value).join()}|${f.result}`;
      if (group.userData.labelKey === key) return;
      group.userData.face.material.map = this._recBlockTexture(f, accentHex);
      group.userData.face.material.needsUpdate = true;
      group.userData.labelKey = key;
    }

    /**
     * Enter recursion mode. Hides the DS layer + grid, parks the camera to a
     * head-on view, and shows whichever recursion sub-view is selected.
     */
    enterRecursionMode(mode) {
      if (!this._recTreeGroup) this._buildRecursion();
      this._recActive = true;
      this._recMode = mode === 'stack' ? 'stack' : 'tree';
      // Fresh entry: no prior frame, so the first render plays no flourish.
      this._recLastStepIndex = -1;
      this._recPrevFrame = null;
      this._recBubbleAnim = null;
      this._recStackAnim = null;

      for (const g of this.nodeMeshes.values()) g.visible = false;
      for (const g of this.edgeMeshes.values()) g.visible = false;
      this.grid.visible = false;
      this._linkLine.visible = false;
      if (this.laGroup) this.laGroup.visible = false;

      // Head-on parked camera; no auto-orbit so the diagram stays readable.
      this.autoRotate = false;
      this._camTarget.set(0, 0, 40);
      this.field.rotation.set(0, 0, 0);
      this._rotTarget.set(0, 0, 0, 'YXZ');

      this._applyRecMode();
    }

    /** Switch between 'tree' and 'stack' sub-views without leaving the mode. */
    setRecursionMode(mode) {
      this._recMode = mode === 'stack' ? 'stack' : 'tree';
      if (this._recActive) this._applyRecMode();
    }

    _applyRecMode() {
      const treeOn = this._recMode === 'tree';
      this._recTreeGroup.visible = treeOn;
      this._recStackGroup.visible = !treeOn;
      // Re-render the last frame into the now-visible view (no flourish: a view
      // toggle is not a trace step).
      if (this._recLastFrame) {
        this._recBubbleAnim = null;
        this._recStackAnim = null;
        if (treeOn) this._renderCallTree(this._recLastFrame);
        else this._renderStackTower(this._recLastFrame);
      }
    }

    /** Leave recursion mode and restore the data-structure layer. */
    exitRecursionMode() {
      this._recActive = false;
      if (this._recTreeGroup) this._recTreeGroup.visible = false;
      if (this._recStackGroup) this._recStackGroup.visible = false;
      for (const g of this.nodeMeshes.values()) g.visible = true;
      for (const g of this.edgeMeshes.values()) g.visible = true;
      this.grid.visible = true;
    }

    /* -------------------------------------------------------------------
     * CUSTOM C++ SANDBOX overlay
     * -------------------------------------------------------------------
     * A sandbox run can emit BOTH graph nodes/edges AND a call stack. Plain
     * recursion mode hides the DS layer; the sandbox instead keeps nodes,
     * edges, and grid fully visible and overlays ONLY the camera-parented
     * stack tower on top. Because the tower is a child of the camera it stays
     * pinned to the corner of the screen while the graph orbits underneath.
     * ---------------------------------------------------------------- */
    enterSandboxMode() {
      if (!this._recTreeGroup) this._buildRecursion();
      this._sandboxActive = true;
      this._recActive = false;      // NOT recursion mode — DS layer stays live
      // Sandbox shows the CALL TREE (recursionvisualizer.com-style branching
      // graph) as the primary view on the field, PLUS the stack tower as a
      // pinned HUD overlay. Both render every frame (see renderFrame).
      this._recMode = 'tree';
      this._recLastStepIndex = -1;
      this._recPrevFrame = null;
      this._recLastFrame = null;
      this._recBubbleAnim = null;
      this._recStackAnim = null;

      // A pure mathematical recursion (fib, coin change, subset sum) draws no
      // input graph, so the call tree owns the field. Any auto-setup graph nodes
      // stay visible too; they simply coexist. Both the tree group and the tower
      // group are shown; the tower is camera-pinned so it never overlaps the tree.
      for (const g of this.nodeMeshes.values()) g.visible = true;
      for (const g of this.edgeMeshes.values()) g.visible = true;
      this.grid.visible = true;
      this._recTreeGroup.visible = true;
      this._recStackGroup.visible = true;

      // Head-on framing so the branching tree reads clearly; the user can still
      // pinch/drag to orbit. The tree auto-fits its own scale (see _renderCallTree).
      this.autoRotate = false;
      this._camTarget.set(0, 3, 40);
    }

    /** Leave sandbox overlay: hide the tower, DS layer already visible. */
    exitSandboxMode() {
      this._sandboxActive = false;
      if (this._recStackGroup) this._recStackGroup.visible = false;
      if (this._recTreeGroup) this._recTreeGroup.visible = false;
      this._recNodePool && this._recNodePool.forEach((g) => (g.visible = false));
      this._recBlockPool && this._recBlockPool.forEach((b) => (b.visible = false));
      if (this._recBubble) this._recBubble.visible = false;
    }

    /**
     * Render a single call-frame snapshot (from the engine). The snapshot is the
     * authoritative state: it is applied instantly and idempotently, so trace
     * back/forward/jump all work by simply handing the current step's `frame`
     * here. `stepIndex` (optional) lets the renderer derive the step DIRECTION
     * and fire the matching transient flourish (bubble travel, block slide) —
     * animations never hold state, they only decorate the transition.
     */
    renderFrame(frame, stepIndex) {
      if (!this._recTreeGroup) this._buildRecursion();

      // Derive step direction + transition events for flourishes.
      const idx = typeof stepIndex === 'number' ? stepIndex : this._recLastStepIndex + 1;
      const dir = this._recLastStepIndex < 0 ? 0 : Math.sign(idx - this._recLastStepIndex);
      const prev = this._recPrevFrame;

      this._recLastFrame = frame || null;

      if (!frame) {
        this._recNodePool.forEach((g) => (g.visible = false));
        this._recLinkPool.forEach((l) => (l.visible = false));
        this._recArrowPool.forEach((a) => (a.visible = false));
        this._recBlockPool.forEach((b) => (b.visible = false));
        this._recBubble.visible = false;
        this._recBubbleAnim = null;
        this._recStackAnim = null;
        this._recPrevFrame = null;
        this._recLastStepIndex = idx;
        return;
      }

      // A new step interrupts any in-flight flourish (snap to end); the fresh
      // flourish is scheduled below from the diff + direction.
      this._recScheduleFlourish(frame, prev, dir);

      // Sandbox shows BOTH: the call tree (recursionvisualizer-style call graph)
      // on the field AND the stack tower as a camera-pinned HUD. Recursion mode
      // shows exactly one, per _recMode.
      if (this._sandboxActive) {
        this._renderCallTree(frame);
        this._renderStackTower(frame);
      } else if (this._recMode === 'tree') {
        this._renderCallTree(frame);
      } else {
        this._renderStackTower(frame);
      }

      this._recPrevFrame = frame;
      this._recLastStepIndex = idx;
    }

    /**
     * Decide which transient flourish (if any) accompanies the transition into
     * `frame` from `prev`, given step `dir`. Forward over a return → bubble up +
     * pop slide-off; backward over a return → bubble down + push slide-on;
     * forward over a callEnter → push slide-in; backward over a callEnter → pop.
     */
    _recScheduleFlourish(frame, prev, dir) {
      this._recBubbleAnim = null;
      this._recStackAnim = null;
      if (!dir) return;                    // first paint, no transition

      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const dur = this.REC_ANIM_MS;

      // Forward INTO a return frame: the activeId frame just resolved.
      if (dir > 0 && frame.event === 'return') {
        this._recBubbleAnim = { node: frame.activeId, value: frame.returnValue, up: true, start: now, dur };
        this._recStackAnim = { kind: 'pop', frame: this._recFindNode(frame, frame.activeId), start: now, dur };
      } else if (dir < 0 && prev && prev.event === 'return') {
        // Backward, undoing a return: value travels back down, block slides on.
        this._recBubbleAnim = { node: prev.activeId, value: prev.returnValue, up: false, start: now, dur };
        this._recStackAnim = { kind: 'unpop', frame: this._recFindNode(prev, prev.activeId), start: now, dur };
      } else if (dir > 0 && frame.event === 'callEnter') {
        this._recStackAnim = { kind: 'push', start: now, dur };
      } else if (dir < 0 && prev && prev.event === 'callEnter') {
        this._recStackAnim = { kind: 'unpush', frame: this._recFindNode(prev, prev.activeId), start: now, dur };
      }
    }

    _recFindNode(frame, id) {
      return frame.nodes.find((n) => n.id === id) || null;
    }

    /* Lay the call tree out by depth (y) and sibling order (x). We compute a
     * horizontal slot for each node by counting siblings per depth so the tree
     * spreads without overlap; then center each depth row. */
    _renderCallTree(frame) {
      const nodes = frame.nodes;
      // Assign an x-slot per node: order of appearance within its depth.
      const perDepth = new Map();      // depth -> count so far
      const slot = new Map();          // id -> slot index
      const depthCount = new Map();    // depth -> total at that depth
      let maxDepth = 0;
      for (const n of nodes) {
        depthCount.set(n.depth, (depthCount.get(n.depth) || 0) + 1);
        if (n.depth > maxDepth) maxDepth = n.depth;
      }
      for (const n of nodes) {
        const s = perDepth.get(n.depth) || 0;
        slot.set(n.id, s);
        perDepth.set(n.depth, s + 1);
      }

      const pos = new Map();           // id -> {x,y}
      let maxRow = 1;
      for (const n of nodes) {
        const total = depthCount.get(n.depth);
        if (total > maxRow) maxRow = total;
        const s = slot.get(n.id);
        const x = (s - (total - 1) / 2) * this.REC_X_SPACING;
        const y = this.REC_TREE_TOP_Y - n.depth * this.REC_Y_SPACING;
        pos.set(n.id, { x, y });
      }
      this._recTreePos = pos;          // stash for bubble animation

      // Depth-aware fit: scale the tree group so the whole graph stays framed.
      // Visible half-extents at the parked camera (z=40) are ~ ±20 x / ±14 y.
      const treeW = maxRow * this.REC_X_SPACING;
      const treeH = (maxDepth + 1) * this.REC_Y_SPACING;
      const fit = Math.min(1, 38 / Math.max(treeW, 1), 26 / Math.max(treeH, 1));
      this._recTreeFitScale = fit;

      // Draw links + arrowheads first (parent→child), then nodes on top.
      let li = 0, ai = 0;
      for (const n of nodes) {
        if (n.parentId === null || n.parentId === undefined) continue;
        const p = pos.get(n.parentId);
        const c = pos.get(n.id);
        if (!p || !c) continue;
        const line = this._recLinkPool[li] || (this._recLinkPool[li] = this._makeRecLink());
        li++;
        const attr = line.geometry.getAttribute('position');
        attr.setXYZ(0, p.x, p.y, 0);
        attr.setXYZ(1, c.x, c.y, 0);
        attr.needsUpdate = true;
        // A link on the active path (child on the stack) glows; else dims.
        const onStack = frame.stack.some((f) => f.id === n.id);
        line.material = onStack ? SHARED.recLinkMat.active : SHARED.recLinkMat.idle;
        line.visible = true;

        // Arrowhead: sit near the child end, pointing parent→child.
        const arrow = this._recArrowPool[ai] || (this._recArrowPool[ai] = this._makeRecArrow());
        ai++;
        const dx = c.x - p.x, dy = c.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        // Park the cone short of the child box (box half-height ≈ 0.65).
        arrow.position.set(c.x - ux * 1.15, c.y - uy * 1.15, 0);
        // Cone points +y by default; rotate to align with (ux,uy).
        arrow.rotation.z = Math.atan2(uy, ux) - Math.PI / 2;
        arrow.material = onStack ? SHARED.recArrowMat.active : SHARED.recArrowMat.idle;
        arrow.visible = true;
      }
      for (; li < this._recLinkPool.length; li++) this._recLinkPool[li].visible = false;
      for (; ai < this._recArrowPool.length; ai++) this._recArrowPool[ai].visible = false;

      // Nodes.
      let ni = 0;
      for (const n of nodes) {
        const g = this._recNodePool[ni] || (this._recNodePool[ni] = this._makeRecNode());
        ni++;
        const p = pos.get(n.id);
        g.position.set(p.x, p.y, 0);
        const label = n.result !== null && n.result !== undefined && n.status === 'returned'
          ? `${n.label}=${n.result}`
          : n.label;
        this._recSetLabel(g, label);
        // Color: the frame returning THIS step goes neon-green (resolved); the
        // active frame is cyan; on-stack ancestors dim-cyan; other returned
        // frames purple.
        let matKey;
        if (n.id === frame.activeId && frame.event === 'return') matKey = 'return';
        else if (n.id === frame.activeId) matKey = 'active';
        else if (frame.stack.some((f) => f.id === n.id)) matKey = 'onstack';
        else if (n.status === 'returned') matKey = 'returned';
        else matKey = 'onstack';
        g.userData.box.material = SHARED.recNodeMat[matKey] || SHARED.recNodeMat.active;
        g.visible = true;
      }
      for (; ni < this._recNodePool.length; ni++) this._recNodePool[ni].visible = false;

      // Prime the return bubble endpoints now that positions are known.
      const ba = this._recBubbleAnim;
      if (ba) {
        const child = pos.get(ba.node);
        const nodeObj = this._recFindNode(frame, ba.node);
        const parent = nodeObj ? pos.get(nodeObj.parentId) : null;
        if (child && parent) {
          ba.fromX = ba.up ? child.x : parent.x;
          ba.fromY = ba.up ? child.y : parent.y;
          ba.toX = ba.up ? parent.x : child.x;
          ba.toY = ba.up ? parent.y : child.y;
        } else {
          this._recBubbleAnim = null;   // endpoints missing (shouldn't happen)
        }
      }
    }

    /* Render the live call stack as a tower of glass blocks growing upward.
     * The top (active) frame is highlighted; a return step flashes and the
     * returning frame slides off as a transient ghost (see _updateRecursion).
     * Each block face shows signature + args + locals + return slot. */
    _renderStackTower(frame) {
      const stack = frame.stack;
      const H = this.REC_BLOCK_H;
      let bi = 0;
      for (let i = 0; i < stack.length; i++) {
        const f = stack[i];
        const b = this._recBlockPool[bi] || (this._recBlockPool[bi] = this._makeRecBlock());
        bi++;
        b.position.set(0, i * H, 0);
        const isTop = i === stack.length - 1;
        const matKey = isTop ? 'active' : 'onstack';
        // Recolor the block's OWN cloned material (never point at the shared
        // one) so per-block opacity/flash animation can't bleed across blocks.
        this._recApplyBlockState(b, matKey);
        this._recSetBlockFace(b, f, this._recAccentHex(matKey));
        b.userData.restY = i * H;
        b.userData.slotTop = isTop;
        b.userData.matKey = matKey;
        b.visible = true;
      }
      for (; bi < this._recBlockPool.length; bi++) this._recBlockPool[bi].visible = false;

      // Deep-recursion fit: if the tower is taller than the visible band, scale
      // it down and shift so the top stays in view. Lerped in _updateRecursion.
      const towerH = Math.max(stack.length, 1) * H;
      const VISIBLE_H = 20;
      this._recStackFitScale = Math.min(1, VISIBLE_H / towerH);
      this._recStackFitY = 0;

      // The pop/unpop ghost block reuses one dedicated slot beyond the live set.
      this._recGhostSlotY = stack.length * H;
    }

    _recAccentHex(matKey) {
      const c = (SHARED.recStateColor && SHARED.recStateColor[matKey]) || 0x00f3ff;
      return '#' + c.toString(16).padStart(6, '0');
    }

    /**
     * Per-frame recursion animation tick. Eases the depth-aware fit (tree scale,
     * tower scale + shift so the top stays in view) and drives the two transient
     * flourishes (return-value bubble travelling an edge; stack push/pop slide).
     * All flourishes are time-boxed and self-clearing — state lives in the
     * snapshot, never here.
     */
    _updateRecursion(t) {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const LERP = 0.12;
      const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

      // --- Tree: ease group scale toward the depth-aware fit ---------------
      // Runs whenever the tree group is on-screen — that's recursion 'tree' mode
      // OR a sandbox run (which shows the tree on the field AND the tower HUD).
      const treeShown = this._recTreeGroup && this._recTreeGroup.visible;
      if (treeShown && this._recTreeFitScale) {
        const cur = this._recTreeGroup.scale.x;
        const s = cur + (this._recTreeFitScale - cur) * LERP;
        this._recTreeGroup.scale.setScalar(s);

        // Return-value bubble travel along the parent↔child edge.
        const ba = this._recBubbleAnim;
        if (ba && ba.fromX !== undefined) {
          const u = Math.min(1, (now - ba.start) / ba.dur);
          const e = easeInOut(u);
          this._recBubble.position.set(
            ba.fromX + (ba.toX - ba.fromX) * e,
            ba.fromY + (ba.toY - ba.fromY) * e,
            0.6
          );
          this._recSetBubble(ba.value);
          this._recBubble.visible = true;
          if (u >= 1) { this._recBubbleAnim = null; this._recBubble.visible = false; }
        } else if (!ba) {
          this._recBubble.visible = false;
        }
      } else {
        this._recBubble.visible = false;
      }

      // --- Stack: ease group scale/shift so the top stays framed ----------
      // Runs whenever the tower is visible: recursion 'stack' mode OR sandbox
      // (which shows tree + tower together).
      if (this._recMode === 'stack' || this._sandboxActive) {
        const g = this._recStackGroup;
        const targetS = this._recStackFitScale || 1;
        const s = g.scale.x + (targetS - g.scale.x) * LERP;
        g.scale.setScalar(s);
        // Keep the tower foot anchored at its base; scaling shrinks upward.
        const by = this._recStackBasePos.y + (this._recStackFitY || 0);
        g.position.y += (by - g.position.y) * LERP;

        // Push / pop slide flourish. The snapshot has already been applied by
        // _renderStackTower — the top block is at its rest slot. We only nudge
        // that block's transform/opacity for the duration of the flourish, then
        // let it settle. (The popped/pushed frame IS the current top block: on a
        // forward return the returning frame has left the stack, so its ghost is
        // synthesised from the pool slot just above; on push the new top is the
        // arrival.)
        const sa = this._recStackAnim;
        const top = this._recTopBlock();
        if (sa && top) {
          const u = Math.min(1, (now - sa.start) / sa.dur);
          const e = easeInOut(u);
          const H = this.REC_BLOCK_H;
          const restY = top.userData.restY || 0;

          if (sa.kind === 'push') {
            // New top arrives: rise into its slot from one block-height below.
            top.position.y = restY - (1 - e) * H;
            this._recSetBlockOpacity(top, e);
          } else if (sa.kind === 'unpush') {
            // Reverse of push: sink out below its slot + fade.
            top.position.y = restY - e * H;
            this._recSetBlockOpacity(top, 1 - e);
          } else if (sa.kind === 'pop' || sa.kind === 'unpop') {
            // Flash the current top (the frame beneath the one that left/returns)
            // to signal a return value was generated, then hold position.
            const f = 0.5 + 0.5 * Math.sin(u * Math.PI * 4);
            this._recSetBlockEmissive(top, 0.55 + f * 0.7);
            this._recSetBlockOpacity(top, 1);
            top.position.y = restY;
          }
          if (u >= 1) {
            // Settle: rest position, full opacity, base emissive.
            top.position.y = restY;
            this._recSetBlockOpacity(top, 1);
            this._recSetBlockEmissive(top, top.userData.matKey === 'onstack' ? 0.22 : 0.55);
            this._recStackAnim = null;
          }
        } else if (!sa && top) {
          // Idle: ensure the top block sits settled (guards against a flourish
          // that was interrupted mid-way by a fast scrub).
          this._recSetBlockOpacity(top, 1);
        }
      }
    }

    /** Recolor a block to a call-state, animating on its OWN cloned material. */
    _recApplyBlockState(block, matKey) {
      const src = SHARED.recGlassMat[matKey] || SHARED.recGlassMat.active;
      const m = block.userData.box.material;
      m.color.copy(src.color);
      m.emissive.copy(src.emissive);
      m.emissiveIntensity = src.emissiveIntensity;
      m.opacity = src.opacity;
    }

    _recTopBlock() {
      let top = null;
      for (const b of this._recBlockPool) if (b.visible) top = b;
      return top;
    }

    _recSetBlockOpacity(block, o) {
      const clamped = Math.max(0, Math.min(1, o));
      if (block.userData.box) block.userData.box.material.opacity = 0.42 * clamped;
      if (block.userData.face) block.userData.face.material.opacity = clamped;
    }

    _recSetBlockEmissive(block, v) {
      const m = block.userData.box && block.userData.box.material;
      if (m && 'emissiveIntensity' in m) m.emissiveIntensity = v;
    }

    /** The travelling return-value bubble label. Cached via _recLabelTexture. */
    _recSetBubble(value) {
      const text = `⤴ ${value}`;
      if (this._recBubble.userData.key === text) return;
      this._recBubble.material.map = this._recLabelTexture(text);
      this._recBubble.material.needsUpdate = true;
      this._recBubble.userData.key = text;
    }

    /* ---------------------------------------------------------------------
     * Animation loop.
     * ------------------------------------------------------------------ */
    start() {
      if (this._running) return;
      this._running = true;
      const loop = () => {
        if (!this._running) return;
        this._frame();
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }

    stop() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
    }

    _frame() {
      const t = this._clock.getElapsedTime();

      // Linear-algebra mode owns the stage: advance the matrix tween, ease the
      // camera/field, and skip the (hidden) data-structure bookkeeping.
      if (this._laActive) {
        this._updateLinearAlgebra(t);
        this.camera.position.lerp(this._camTarget, this.CAM_LERP);
        this.camera.lookAt(0, 0, 0);
        this.field.rotation.x +=
          (this._rotTarget.x - this.field.rotation.x) * this.ROT_LERP;
        this.field.rotation.y +=
          (this._rotTarget.y - this.field.rotation.y) * this.ROT_LERP;
        this.renderer.render(this.scene, this.camera);
        return;
      }

      // Recursion mode owns the stage: ease camera/field (pinch-rotate still
      // works for the call tree), skip DS bookkeeping. The stack tower rides
      // the camera, so it stays anchored regardless of rotation.
      if (this._recActive) {
        this._updateRecursion(t);
        this.camera.position.lerp(this._camTarget, this.CAM_LERP);
        this.camera.lookAt(0, 0, 0);
        this.field.rotation.x +=
          (this._rotTarget.x - this.field.rotation.x) * this.ROT_LERP;
        this.field.rotation.y +=
          (this._rotTarget.y - this.field.rotation.y) * this.ROT_LERP;
        this.renderer.render(this.scene, this.camera);
        return;
      }

      // Sandbox overlay: the DS layer renders normally (below), but the camera-
      // parented stack tower still needs its per-frame flourish animation ticked.
      if (this._sandboxActive) this._updateRecursion(t);

      // Lerp node transforms toward targets for smooth structural motion.
      for (const group of this.nodeMeshes.values()) {
        group.position.lerp(group.userData.targetPos, LERP);
        const s = group.scale.x + (group.userData.targetScale - group.scale.x) * LERP;
        group.scale.setScalar(s);
        // Subtle idle bob so glass spheres feel alive.
        const sphere = group.userData.sphere;
        if (sphere) sphere.rotation.y = t * 0.4;
      }

      // Re-seat edges after nodes moved.
      for (const group of this.edgeMeshes.values()) {
        this._updateEdgeTransform(group);
      }

      // Animate cursor ring spin + pulse.
      if (this._cursorActive) {
        this.cursor.children[0].rotation.z = t * 2.0;
        const pulse = 1 + Math.sin(t * 6) * 0.08;
        this.cursor.scale.setScalar(pulse);
      }

      // --- Camera + field motion -----------------------------------------
      if (this.autoRotate && !this._cursorActive) {
        // Idle showcase orbit. Keep the interaction targets synced to the live
        // transforms so grabbing rotate/zoom later never snaps.
        const r = 34;
        this.camera.position.x = Math.sin(t * 0.08) * r;
        this.camera.position.z = Math.cos(t * 0.08) * r;
        this.camera.position.y = 6 + Math.sin(t * 0.15) * 2;
        this.camera.lookAt(0, 0, 0);
        this._camTarget.copy(this.camera.position);
        this._rotTarget.x = this.field.rotation.x;
        this._rotTarget.y = this.field.rotation.y;
      } else if (!this.autoRotate) {
        // ZOOM: ease camera toward the dolly target (0.1 lerp), keep it aimed
        // at origin. X/Y stay put — zoom is pure Z dolly.
        this.camera.position.lerp(this._camTarget, this.CAM_LERP);
        this.camera.lookAt(0, 0, 0);

        // ROTATE: ease the field toward its rotation target for momentum.
        this.field.rotation.x +=
          (this._rotTarget.x - this.field.rotation.x) * this.ROT_LERP;
        this.field.rotation.y +=
          (this._rotTarget.y - this.field.rotation.y) * this.ROT_LERP;
      }

      this.renderer.render(this.scene, this.camera);
    }

    resize() {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
    }

    dispose() {
      this.stop();
      window.removeEventListener('resize', this._boundResize);
      for (const g of this.nodeMeshes.values()) this._disposeGroup(g);
      for (const g of this.edgeMeshes.values()) this._disposeGroup(g);
      this.nodeMeshes.clear();
      this.edgeMeshes.clear();
      this.renderer.dispose();
    }
  }

  window.Render3D = { Renderer3D, STATE_COLORS };
})();
