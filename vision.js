/**
 * vision.js  (performance-optimized)
 * ---------------------------------------------------------------------------
 * MediaPipe Computer Vision Layer.
 *
 * PERFORMANCE MODEL
 *   The MediaPipe HandLandmarker runs a WASM inference pass that is *by far*
 *   the most expensive thing on the main thread. Running it on every rAF tick
 *   starves Three.js and trips the "Page Unresponsive" watchdog. So we split
 *   the loop into two cadences:
 *
 *     • DETECTION cadence  — run detectForVideo() only once every
 *       DETECT_EVERY rAF frames (default 3 → ~20 Hz on a 60 Hz display).
 *     • INTERPOLATION cadence — on the skipped frames we do NOT touch the
 *       model. We extrapolate the fingertip from its last measured velocity so
 *       the 3D cursor keeps gliding smoothly instead of stalling.
 *
 *   The webcam is also hard-capped to a 640x480 @ 30fps profile so the browser
 *   never negotiates an expensive HD stream.
 *
 * The normalized event contract (unchanged, so app.js keeps working):
 *   {
 *     present, cursor:{x,y}|null, pinch, pinchStart, pinchEnd,
 *     swipe:'SWIPE_LEFT'|'SWIPE_RIGHT'|null, landmarks|null, fps,
 *     interpolated:boolean   // true on skipped (extrapolated) frames
 *   }
 * ---------------------------------------------------------------------------
 */

'use strict';

(function () {
  // Landmark indices we care about (MediaPipe Hand topology).
  const THUMB_TIP = 4;
  const INDEX_TIP = 8;      // index fingertip
  const INDEX_PIP = 6;      // index proximal-interphalangeal joint
  const MIDDLE_TIP = 12;    // middle fingertip
  const MIDDLE_PIP = 10;    // middle PIP joint
  const RING_TIP = 16;
  const RING_PIP = 14;
  const PINKY_TIP = 20;
  const PINKY_PIP = 18;

  // Hand skeleton connections for the telemetry overlay.
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  // Pinch SPLIT-THRESHOLD hysteresis (normalized 3D distance).
  //   START  a pinch / draw:    d < PINCH_START   (deliberate, tight)
  //   MAINTAIN while moving:     d < PINCH_RELEASE (wide band — the fix for
  //                                                 mid-flight edge drops)
  //   RELEASE / drop:            d > PINCH_RELEASE
  // The gap between START and RELEASE is what stops the pinch from flickering
  // off while you drag a node or draw an edge across the scene.
  const PINCH_START = 0.025;
  const PINCH_RELEASE = 0.055;

  // Double-pinch timing gate. Two discrete pinch-down edges closer together
  // than this (ms) count as a "double pinch" — the node-creation trigger.
  const DOUBLE_PINCH_MS = 300;

  // Two-handed ZOOM (Ultron replica). Each hand must be independently pinched
  // (tight thumb-index distance) for the dual-pinch zoom gesture to engage.
  const ZOOM_PINCH = 0.03;         // per-hand thumb↔index distance to count as pinched

  // LINKING POSE (two-finger pointer for edge connection). Index + middle
  // extended, ring + pinky curled. Extended = tip is ABOVE its PIP joint in the
  // image (smaller y). CURL_MARGIN adds a small deadband so a half-bent finger
  // doesn't flip the pose state per frame.
  const CURL_MARGIN = 0.02;

  // Velocity-based swipe (frame-velocity ring buffer over the index fingertip).
  // Instead of requiring a big absolute sweep, we fire on a *sharp flick*: high
  // horizontal velocity across a short travel while vertical wobble stays low.
  const SWIPE_BUFFER = 8;            // frames of fingertip history to keep
  const SWIPE_VELOCITY = 0.0012;     // normalized-x per ms — the "sharp" gate
  const SWIPE_MIN_DX = 0.10;         // min horizontal travel (~10 cm hand flick)
  const SWIPE_MAX_DY = 0.10;         // max vertical variance to still count
  const SWIPE_COOLDOWN_MS = 450;     // min gap between swipes

  /* ------------------------------------------------------------------ *
   * THROTTLING: run the model once every N rAF frames.                  *
   * ------------------------------------------------------------------ */
  const DETECT_EVERY = 3;          // 1 detection per 3 frames (~20 Hz @ 60 fps)
  const MAX_EXTRAP_STEP = 0.045;   // clamp per-frame extrapolation (0..1 space)

  class VisionEngine {
    /**
     * @param {Object} opts
     * @param {HTMLVideoElement} opts.video
     * @param {HTMLCanvasElement} opts.overlay
     * @param {(evt:Object)=>void} opts.onFrame
     * @param {(state:string, detail?:string)=>void} [opts.onStatus]
     */
    constructor({ video, overlay, onFrame, onStatus }) {
      this.video = video;
      this.overlay = overlay;
      // `desynchronized` lets the 2D overlay present off the main compositor path.
      this.octx = overlay.getContext('2d', { desynchronized: true, alpha: true });
      this.onFrame = onFrame || (() => {});
      this.onStatus = onStatus || (() => {});

      this.landmarker = null;
      this.running = false;
      this._rafId = null;
      this._lastVideoTime = -1;

      // Frame throttling counter.
      this._frameCount = 0;

      // Debounced pinch state (primary hand).
      this._pinch = false;
      // Double-pinch timing gate: time of the last pinch-DOWN edge.
      this._lastPinchTime = 0;
      this._pinchCount = 0;

      // Two-handed zoom: baseline inter-hand distance captured on the first
      // frame both hands are pinched. null when zoom mode is inactive.
      this._zoomBase = null;

      // Linking pose latch (index+middle extended, ring+pinky curled).
      this._linking = false;

      // Presence + interpolation state.
      this._present = false;
      // Last two *measured* fingertip samples for velocity extrapolation.
      this._lastReal = null;   // { x, y, t }
      this._prevReal = null;   // { x, y, t }
      this._lastLandmarks = null;

      // Swipe ring buffer of { x, y, t }.
      this._track = [];
      this._lastSwipeAt = 0;

      // FPS smoothing (loop cadence — reflects UI smoothness).
      this._fps = 0;
      this._lastT = performance.now();

      this._boundLoop = this._loop.bind(this);
    }

    /* ---------------------------------------------------------------------
     * Initialization: load the WASM bundle + model, then open the webcam.
     * ------------------------------------------------------------------ */
    async init() {
      this.onStatus('loading', 'Loading vision model…');
      try {
        const vision = await import(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs'
        );
        const { HandLandmarker, FilesetResolver } = vision;

        const filesetResolver = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        );

        this.landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });
      } catch (err) {
        console.error('[vision] model init failed:', err);
        this.onStatus('error', 'Vision model failed to load.');
        throw err;
      }

      await this._startCamera();
    }

    async _startCamera() {
      this.onStatus('loading', 'Requesting camera…');
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.onStatus('error', 'getUserMedia unsupported in this browser.');
        throw new Error('getUserMedia unsupported');
      }
      try {
        // HARD-CAPPED high-performance profile: 640x480 @ 30fps. `max` prevents
        // the browser from negotiating an expensive HD/60fps stream.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640, max: 640 },
            height: { ideal: 480, max: 480 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: 'user',
          },
          audio: false,
        });
        this.video.srcObject = stream;
        await new Promise((resolve, reject) => {
          this.video.onloadedmetadata = () => resolve();
          this.video.onerror = () => reject(new Error('video element error'));
        });
        await this.video.play();
        this._syncOverlaySize();
        this.onStatus('ready', 'Vision online.');
      } catch (err) {
        console.error('[vision] camera failed:', err);
        this.onStatus('error', 'Camera access denied or unavailable.');
        throw err;
      }
    }

    _syncOverlaySize() {
      const w = this.video.videoWidth || 640;
      const h = this.video.videoHeight || 480;
      if (this.overlay.width !== w) this.overlay.width = w;
      if (this.overlay.height !== h) this.overlay.height = h;
    }

    /* ---------------------------------------------------------------------
     * Loop control.
     * ------------------------------------------------------------------ */
    start() {
      if (this.running) return;
      if (!this.landmarker) {
        console.warn('[vision] start() before init(); ignoring.');
        return;
      }
      this.running = true;
      this._rafId = requestAnimationFrame(this._boundLoop);
    }

    stop() {
      this.running = false;
      if (this._rafId) cancelAnimationFrame(this._rafId);
      const stream = this.video.srcObject;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }

    _loop() {
      if (!this.running) return;
      try {
        this._tick();
      } catch (err) {
        console.error('[vision] tick error:', err);
      }
      this._rafId = requestAnimationFrame(this._boundLoop);
    }

    /* ---------------------------------------------------------------------
     * One rAF tick. Decides between a heavy DETECTION frame and a light
     * INTERPOLATION frame based on the throttle counter.
     * ------------------------------------------------------------------ */
    _tick() {
      if (this.video.readyState < 2) return; // not enough data yet

      // FPS (EMA of loop cadence).
      const now = performance.now();
      const dt = now - this._lastT;
      this._lastT = now;
      if (dt > 0) this._fps = this._fps * 0.9 + (1000 / dt) * 0.1;

      this._frameCount += 1;

      // Only run the model on the throttled cadence AND only on a fresh video
      // frame (currentTime advances). Everything else interpolates.
      const detectDue = this._frameCount % DETECT_EVERY === 0;
      const freshFrame = this.video.currentTime !== this._lastVideoTime;

      if (detectDue && freshFrame) {
        this._lastVideoTime = this.video.currentTime;
        this._runDetection(now);
      } else {
        this._emitInterpolated(now);
      }
    }

    /* ---------------------------------------------------------------------
     * HEAVY path — actual MediaPipe inference. Runs ~20x/sec.
     * ------------------------------------------------------------------ */
    _runDetection(now) {
      const result = this.landmarker.detectForVideo(this.video, now);
      this._syncOverlaySize();

      const handCount = result && result.landmarks ? result.landmarks.length : 0;
      if (handCount === 0) {
        this._present = false;
        this._pinch = false;
        this._pinchCount = 0;
        this._zoomBase = null;
        this._linking = false;
        this._track.length = 0;
        this._lastReal = null;
        this._prevReal = null;
        this._lastLandmarks = null;
        this._clearOverlay();
        this.onFrame(this._event(false, null, false, false, null, false));
        return;
      }

      // Mirror X on every detected hand so on-screen motion matches the user
      // (selfie view). hands[0] is treated as the PRIMARY (cursor) hand.
      const hands = result.landmarks.map((h) =>
        h.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }))
      );
      const lm = hands[0];
      this._lastLandmarks = lm;

      /* ================================================================== *
       * TWO-HANDED PINCH → ZOOM (highest-priority path).                    *
       * Both hands pinched → emit a smoothed zoom scalar and skip the       *
       * single-hand rotate/link machinery for this frame.                  *
       * ================================================================== */
      if (handCount === 2) {
        const zoom = this._detectZoom(hands);
        if (zoom !== null) {
          // Zoom owns the frame: reset single-hand latches so releasing the
          // second hand doesn't leave a stale pinch/link armed.
          this._pinch = false;
          this._linking = false;
          this._track.length = 0;
          this._drawOverlayDual(hands);
          this.onFrame(
            this._event(true, null, false, false, null, false, { zoom, landmarks: lm })
          );
          return;
        }
      } else {
        // Dropped back to one (or zero) hands — clear any zoom baseline.
        this._zoomBase = null;
      }

      // ---- Pinch: 3D Euclidean distance with SPLIT-THRESHOLD hysteresis --
      // Starting a pinch requires a deliberately tight distance (PINCH_START),
      // but once engaged we only release past the much wider PINCH_RELEASE.
      // That wide "maintain" band is what keeps an edge-draw or node-drag alive
      // when the fingers drift slightly apart mid-gesture.
      const t = lm[THUMB_TIP];
      const i = lm[INDEX_TIP];
      const d = Math.sqrt(
        (i.x - t.x) ** 2 + (i.y - t.y) ** 2 + (i.z - t.z) ** 2
      );
      const wasPinch = this._pinch;
      if (!this._pinch && d < PINCH_START) this._pinch = true;
      else if (this._pinch && d > PINCH_RELEASE) this._pinch = false;
      const pinchStart = !wasPinch && this._pinch;
      const pinchEnd = wasPinch && !this._pinch;

      // ---- Double-pinch timing gate -------------------------------------
      // On each pinch-DOWN edge, compare against the previous pinch-down. Two
      // within DOUBLE_PINCH_MS = a double pinch (node-create trigger). The flag
      // is transient: it rides on exactly the frame of the second pinch-down.
      let doublePinch = false;
      if (pinchStart) {
        const gap = now - this._lastPinchTime;
        if (this._pinchCount > 0 && gap < DOUBLE_PINCH_MS) {
          doublePinch = true;
          this._pinchCount = 0;          // consume the pair
        } else {
          this._pinchCount = 1;          // arm; this is the first of a potential pair
        }
        this._lastPinchTime = now;
      }

      // ---- Swipe recognizer: index-fingertip velocity ring buffer -------
      this._track.push({ x: i.x, y: i.y, t: now });
      if (this._track.length > SWIPE_BUFFER) this._track.shift();
      const swipe = this._detectSwipe(now);

      // ---- Linking pose (index+middle extended, ring+pinky curled) ------
      // Latched with a margin so a half-curl doesn't chatter. We surface the
      // rising/falling edges so app.js can start / commit the temp edge line.
      const wasLinking = this._linking;
      this._linking = this._detectLinkingPose(lm);
      const linkStart = !wasLinking && this._linking;
      const linkEnd = wasLinking && !this._linking;

      // ---- Record measured fingertip samples for extrapolation ----------
      this._present = true;
      this._prevReal = this._lastReal;
      this._lastReal = { x: i.x, y: i.y, t: now };

      // ---- Telemetry overlay (only on detection frames) -----------------
      this._drawOverlay(lm, d, this._pinch, this._linking);

      this.onFrame(
        this._event(true, { x: i.x, y: i.y }, this._pinch, false, swipe, false, {
          pinchStart,
          pinchEnd,
          doublePinch,
          linking: this._linking,
          linkStart,
          linkEnd,
          landmarks: lm,
        })
      );
    }

    /* ---------------------------------------------------------------------
     * TWO-HANDED ZOOM detector. Returns a smoothing-ready zoom scalar:
     *   > 0  hands spreading  → zoom IN
     *   < 0  hands closing    → zoom OUT
     * or null when the dual-pinch is not active. The scalar is the signed
     * delta of the current inter-hand distance vs the captured baseline; the
     * 0.1 camera lerp lives in render3d, keeping this module transform-free.
     * ------------------------------------------------------------------ */
    _detectZoom(hands) {
      const aPinch = this._handPinchDist(hands[0]) < ZOOM_PINCH;
      const bPinch = this._handPinchDist(hands[1]) < ZOOM_PINCH;
      if (!(aPinch && bPinch)) {
        this._zoomBase = null;
        return null;
      }

      // Pinch centroid of each hand (midpoint of thumb+index tips), full 3D.
      const ca = this._pinchPoint(hands[0]);
      const cb = this._pinchPoint(hands[1]);
      const dist = Math.sqrt(
        (ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2 + (ca.z - cb.z) ** 2
      );

      if (this._zoomBase === null) {
        // First frame of the dual-pinch: capture baseline, no movement yet.
        this._zoomBase = dist;
        return 0;
      }
      return dist - this._zoomBase;   // signed spread; render3d applies the lerp
    }

    /** Thumb↔index 3D distance for an arbitrary hand's landmark array. */
    _handPinchDist(h) {
      const t = h[THUMB_TIP], i = h[INDEX_TIP];
      return Math.sqrt((i.x - t.x) ** 2 + (i.y - t.y) ** 2 + (i.z - t.z) ** 2);
    }

    /** Midpoint of thumb + index tips — the "pinch coordinate" of a hand. */
    _pinchPoint(h) {
      const t = h[THUMB_TIP], i = h[INDEX_TIP];
      return { x: (t.x + i.x) / 2, y: (t.y + i.y) / 2, z: (t.z + i.z) / 2 };
    }

    /* ---------------------------------------------------------------------
     * LINKING POSE: index + middle EXTENDED, ring + pinky CURLED.
     * A finger is "extended" when its tip sits above (smaller y) its PIP joint,
     * "curled" when the tip drops below the PIP. CURL_MARGIN is a deadband.
     * ------------------------------------------------------------------ */
    _detectLinkingPose(h) {
      const idxExt = h[INDEX_TIP].y < h[INDEX_PIP].y - CURL_MARGIN;
      const midExt = h[MIDDLE_TIP].y < h[MIDDLE_PIP].y - CURL_MARGIN;
      const ringCurl = h[RING_TIP].y > h[RING_PIP].y + CURL_MARGIN;
      const pinkyCurl = h[PINKY_TIP].y > h[PINKY_PIP].y + CURL_MARGIN;
      return idxExt && midExt && ringCurl && pinkyCurl;
    }

    /* ---------------------------------------------------------------------
     * LIGHT path — no inference. Extrapolate the fingertip so the cursor
     * keeps moving smoothly between detections. Never emits edge events.
     * ------------------------------------------------------------------ */
    _emitInterpolated(now) {
      if (!this._present || !this._lastReal) {
        // Nothing to interpolate — emit a cheap "no hand" frame.
        this.onFrame(this._event(false, null, this._pinch, false, null, true));
        return;
      }

      let cursor;
      if (this._prevReal) {
        // Velocity from the last two measured samples.
        const span = Math.max(this._lastReal.t - this._prevReal.t, 1);
        const vx = (this._lastReal.x - this._prevReal.x) / span;
        const vy = (this._lastReal.y - this._prevReal.y) / span;
        const elapsed = now - this._lastReal.t;
        let px = this._lastReal.x + vx * elapsed;
        let py = this._lastReal.y + vy * elapsed;
        // Clamp the predicted step so a fast/erratic sample can't fling the cursor.
        px = this._lastReal.x + this._clamp(px - this._lastReal.x, MAX_EXTRAP_STEP);
        py = this._lastReal.y + this._clamp(py - this._lastReal.y, MAX_EXTRAP_STEP);
        cursor = { x: this._clamp01(px), y: this._clamp01(py) };
      } else {
        // Only one sample so far — hold position.
        cursor = { x: this._lastReal.x, y: this._lastReal.y };
      }

      // Carry debounced pinch + linking state forward; edges only fire on real
      // frames. The interpolated cursor still moves the temp link line smoothly.
      this.onFrame(
        this._event(true, cursor, this._pinch, true, null, true, {
          linking: this._linking,
        })
      );
    }

    /* ---------------------------------------------------------------------
     * Event factory — keeps the emitted shape in exactly one place.
     * ------------------------------------------------------------------ */
    _event(present, cursor, pinch, _interpFlag, swipe, interpolated, extra = {}) {
      return {
        present,
        cursor,
        pinch,
        pinchStart: extra.pinchStart || false,
        pinchEnd: extra.pinchEnd || false,
        doublePinch: extra.doublePinch || false,
        // Linking-pose (two-finger edge pointer).
        linking: extra.linking || false,
        linkStart: extra.linkStart || false,
        linkEnd: extra.linkEnd || false,
        // Two-handed zoom scalar (signed inter-hand spread) or null.
        zoom: typeof extra.zoom === 'number' ? extra.zoom : null,
        swipe: swipe || null,
        landmarks: extra.landmarks || null,
        fps: Math.round(this._fps),
        interpolated: !!interpolated,
      };
    }

    _clamp(v, m) { return v > m ? m : v < -m ? -m : v; }
    _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    /* ---------------------------------------------------------------------
     * VELOCITY-BASED INSTANT SWIPE.
     *
     * Rather than waiting for a large absolute sweep to accumulate, we measure
     * the horizontal velocity of the index fingertip across the ring buffer:
     *
     *     velocity = (x_now - x_8_frames_ago) / (t_now - t_8_frames_ago)
     *
     * A sharp flick clears SWIPE_VELOCITY almost instantly, so a short (~10 cm)
     * quick motion triggers — while a slow drag never will. We still gate on a
     * minimum travel (rejects jitter) and low vertical variance (rejects
     * diagonal / vertical motion).
     * ------------------------------------------------------------------ */
    _detectSwipe(now) {
      if (this._track.length < SWIPE_BUFFER) return null;
      if (now - this._lastSwipeAt < SWIPE_COOLDOWN_MS) return null;

      const first = this._track[0];
      const last = this._track[this._track.length - 1];

      const dx = last.x - first.x;                     // signed horizontal travel
      const dt = Math.max(last.t - first.t, 1);        // ms across the buffer
      const velocity = dx / dt;                        // normalized-x per ms

      // Vertical variance across the whole buffer must stay low.
      let yMin = Infinity, yMax = -Infinity;
      for (const p of this._track) {
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
      const dyRange = yMax - yMin;

      if (
        Math.abs(velocity) > SWIPE_VELOCITY &&
        Math.abs(dx) > SWIPE_MIN_DX &&
        dyRange < SWIPE_MAX_DY
      ) {
        this._lastSwipeAt = now;
        this._track.length = 0;              // consume the buffer so it can't re-fire
        return velocity > 0 ? 'SWIPE_RIGHT' : 'SWIPE_LEFT';
      }
      return null;
    }

    /* ---------------------------------------------------------------------
     * Overlay drawing (telemetry) — only invoked on detection frames.
     * ------------------------------------------------------------------ */
    _clearOverlay() {
      this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    _drawOverlay(lm, dist, pinch, linking = false) {
      const { width: W, height: H } = this.overlay;
      const ctx = this.octx;
      ctx.clearRect(0, 0, W, H);

      ctx.lineWidth = 2;
      ctx.strokeStyle = linking ? '#ffd000' : pinch ? '#00ff9c' : '#00f3ff';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a], pb = lm[b];
        ctx.moveTo(pa.x * W, pa.y * H);
        ctx.lineTo(pb.x * W, pb.y * H);
      }
      ctx.stroke();

      for (let k = 0; k < lm.length; k++) {
        const p = lm[k];
        const isKey = k === THUMB_TIP || k === INDEX_TIP;
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, isKey ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = isKey ? '#bd00ff' : '#e6faff';
        ctx.fill();
      }

      const t = lm[THUMB_TIP], i = lm[INDEX_TIP];
      ctx.strokeStyle = pinch ? '#00ff9c' : '#ffd000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(t.x * W, t.y * H);
      ctx.lineTo(i.x * W, i.y * H);
      ctx.stroke();

      ctx.fillStyle = '#e6faff';
      ctx.font = '14px monospace';
      const tag = linking ? 'LINK' : pinch ? 'PINCH' : '';
      ctx.fillText(`d=${dist.toFixed(3)} ${tag}`, 8, 20);
      ctx.fillText(`fps ${Math.round(this._fps)}`, 8, 38);
    }

    /* ---------------------------------------------------------------------
     * Dual-hand overlay for zoom mode: draw both skeletons + the tension line
     * between the two pinch points so the zoom gesture reads clearly.
     * ------------------------------------------------------------------ */
    _drawOverlayDual(hands) {
      const { width: W, height: H } = this.overlay;
      const ctx = this.octx;
      ctx.clearRect(0, 0, W, H);

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#bd00ff';
      ctx.beginPath();
      for (const h of hands) {
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(h[a].x * W, h[a].y * H);
          ctx.lineTo(h[b].x * W, h[b].y * H);
        }
      }
      ctx.stroke();

      // Tension line between the two pinch centroids.
      const ca = this._pinchPoint(hands[0]);
      const cb = this._pinchPoint(hands[1]);
      ctx.strokeStyle = '#00ff9c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ca.x * W, ca.y * H);
      ctx.lineTo(cb.x * W, cb.y * H);
      ctx.stroke();

      ctx.fillStyle = '#e6faff';
      ctx.font = '14px monospace';
      ctx.fillText('ZOOM', 8, 20);
      ctx.fillText(`fps ${Math.round(this._fps)}`, 8, 38);
    }
  }

  window.Vision = { VisionEngine };
})();
