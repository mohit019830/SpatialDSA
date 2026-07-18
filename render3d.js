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

      // --- Ground grid for spatial reference ------------------------------
      this.grid = new THREE.GridHelper(120, 60, 0x00f3ff, 0x14313a);
      this.grid.position.y = -10;
      this.grid.material.opacity = 0.25;
      this.grid.material.transparent = true;
      this.scene.add(this.grid);

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

      // --- Camera pan controller -----------------------------------------
      // When the user pinches empty space and drags, app.js calls panCamera()
      // to push a target camera position. The frame loop lerps the live camera
      // toward this target (CAM_LERP) so the whole field slides smoothly rather
      // than snapping. Seeded from the initial camera placement.
      this._camTarget = this.camera.position.clone();
      this.CAM_LERP = 0.1;          // coordinate-smoothing factor
      this.CAM_PAN_LIMIT = 60;      // clamp so the field can't be flung off-screen

      // --- Reusable temporaries (avoid per-frame allocations) ------------
      this._tmpVec3 = new THREE.Vector3();
      this._tmpDir = new THREE.Vector3();
      this._tmpMid = new THREE.Vector3();
      this._tmpQuat = new THREE.Quaternion();
      this._up = new THREE.Vector3(0, 1, 0);

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
          this.scene.add(group);
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
          this.scene.remove(group);
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
            this.scene.remove(group);
          }
          group = this._createEdgeMesh(edge);
          this.edgeMeshes.set(edge.uuid, group);
          this.scene.add(group);
        }
        group.userData.from = edge.from;
        group.userData.to = edge.to;
        this._applyEdgeColor(group, edge.state);
      }
      // --- Edges: remove stale ------------------------------------------
      for (const [uuid, group] of this.edgeMeshes) {
        if (!seenEdges.has(uuid)) {
          this._disposeGroup(group);
          this.scene.remove(group);
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
    updateCursor(nx, ny, visible, pinch = false) {
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

      if ((moved && pinch) || pinchDown) {
        this._lastRayNx = nx;
        this._lastRayNy = ny;
        this._lastHovered = this._hoverTest(worldPoint);

        // Recolor cursor ring by swapping the shared material (no mutation).
        const ring = this.cursor.userData.ring;
        ring.material = this._lastHovered
          ? SHARED.cursorRingHoverMat
          : SHARED.cursorRingMat;
      } else if (!pinch && this._lastHovered) {
        // Released: drop the hover highlight without paying for a raycast.
        this._lastHovered = null;
        this.cursor.userData.ring.material = SHARED.cursorRingMat;
      }

      // Track pinch every call so edge detection stays correct even on frames
      // we don't raycast.
      this._lastPinch = pinch;

      return {
        hovered: this._lastHovered,
        worldPoint: worldPoint.clone(),
      };
    }

    /* ---------------------------------------------------------------------
     * Camera pan (Path B). `dnx, dny` are the frame-to-frame hand deltas in
     * normalized screen space; we translate them into a camera-position target
     * that the frame loop lerps toward (see CAM_LERP). Panning disables the
     * idle auto-orbit so the two don't fight over the camera.
     * ------------------------------------------------------------------ */
    panCamera(dnx, dny) {
      this.autoRotate = false;

      // Scale normalized deltas to world units. Horizontal hand motion slides
      // the field on X; vertical motion slides it on Y (inverted so dragging
      // up moves the camera up, i.e. the scene appears to move down).
      const SCALE = 60;
      this._camTarget.x -= dnx * SCALE;
      this._camTarget.y += dny * SCALE;

      // Clamp so the structure can't be lost off-screen.
      const L = this.CAM_PAN_LIMIT;
      this._camTarget.x = Math.max(-L, Math.min(L, this._camTarget.x));
      this._camTarget.y = Math.max(-L, Math.min(L, this._camTarget.y));
    }

    /** Re-arm the gentle idle auto-orbit (called when interaction ends). */
    resumeAutoOrbit() {
      this.autoRotate = true;
    }

    /* ---------------------------------------------------------------------
     * Hover test with a cheap AABB proximity pre-filter.
     *
     * Full mesh raycasting walks every triangle of every sphere. Instead we
     * first reject nodes whose bounding box the ray misses (a few multiplies
     * per node), and only run intersectObjects on the tiny surviving set.
     * ------------------------------------------------------------------ */
    _hoverTest(worldPoint) {
      const ray = this.raycaster.ray;
      const candidates = [];

      for (const group of this.nodeMeshes.values()) {
        const sphere = group.userData.sphere;
        if (!sphere) continue;
        const p = group.position;
        const half = group.userData.aabbHalf || NODE_RADIUS;

        // (1) Broad phase A: on the z=0 work plane the cursor lives at
        //     worldPoint; if the node is nowhere near it, skip immediately.
        const pdx = p.x - worldPoint.x;
        const pdy = p.y - worldPoint.y;
        if (pdx * pdx + pdy * pdy > (half * 2.5) * (half * 2.5)) continue;

        // (2) Broad phase B: AABB — does the ray pass within the node's box?
        //     distanceSqToPoint is a handful of ops vs full triangle casting.
        if (ray.distanceSqToPoint(p) <= half * half) {
          candidates.push(sphere);
        }
      }

      if (candidates.length === 0) return null;
      // Narrow phase: only the survivors get a precise intersection test.
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

      // Camera: either the gentle idle auto-orbit, or a user-driven pan that
      // lerps toward the target set by panCamera().
      if (this.autoRotate && !this._cursorActive) {
        const r = 34;
        this.camera.position.x = Math.sin(t * 0.08) * r;
        this.camera.position.z = Math.cos(t * 0.08) * r;
        this.camera.position.y = 6 + Math.sin(t * 0.15) * 2;
        this.camera.lookAt(0, 0, 0);
        // Keep the pan target synced so grabbing the camera later doesn't jump.
        this._camTarget.copy(this.camera.position);
      } else if (!this.autoRotate) {
        // Data hysteresis: ease the live camera toward the pan target (0.1),
        // so the field glides rather than snapping frame-to-frame.
        this.camera.position.lerp(this._camTarget, this.CAM_LERP);
        this.camera.lookAt(0, 0, 0);
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
