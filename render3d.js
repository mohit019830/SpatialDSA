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

      // Grid extent: lines span [-N, N] on each axis, one line per unit.
      this._laN = 6;
      const N = this._laN;

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

      // Seed geometry + arrows at identity.
      this._laApplyDisplayed(IDENTITY3.slice());
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
    _laWriteGeometry(geometry, m) {
      const attr = geometry.getAttribute('position');
      const arr = attr.array;
      const pts = this._laBasePoints;
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
      // Face the grid: park the camera on +Z looking at origin, stop orbiting.
      this.autoRotate = false;
      this._camTarget.set(0, 2, 24);
      this.field.rotation.set(0, 0, 0);
      this._rotTarget.set(0, 0, 0, 'YXZ');
      this.resetMatrix(true);
    }

    /** Leave linear-algebra mode and restore the data-structure layer. */
    exitLinearMode() {
      this._laActive = false;
      this.laGroup.visible = false;
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
      if (!this._laActive || this._laT >= 1) return;
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
