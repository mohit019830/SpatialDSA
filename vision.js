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
  const INDEX_TIP = 8;

  // Hand skeleton connections for the telemetry overlay.
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20],
    [0, 17],
  ];

  // Pinch hysteresis thresholds (normalized 3D distance).
  const PINCH_ON = 0.045;
  const PINCH_OFF = 0.07;

  // Swipe recognizer tuning.
  const SWIPE_WINDOW = 6;
  const SWIPE_DX = 0.22;
  const SWIPE_MAX_DY = 0.12;
  const SWIPE_COOLDOWN_MS = 650;

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

      // Debounced pinch state.
      this._pinch = false;

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
          numHands: 1,
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

      const hasHand = result && result.landmarks && result.landmarks.length > 0;
      if (!hasHand) {
        this._present = false;
        this._pinch = false;
        this._track.length = 0;
        this._lastReal = null;
        this._prevReal = null;
        this._lastLandmarks = null;
        this._clearOverlay();
        this.onFrame(this._event(false, null, false, false, null, false));
        return;
      }

      // Mirror X so on-screen motion matches the user (selfie view).
      const lm = result.landmarks[0].map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
      this._lastLandmarks = lm;

      // ---- Pinch: 3D Euclidean distance with hysteresis -----------------
      const t = lm[THUMB_TIP];
      const i = lm[INDEX_TIP];
      const d = Math.sqrt(
        (i.x - t.x) ** 2 + (i.y - t.y) ** 2 + (i.z - t.z) ** 2
      );
      const wasPinch = this._pinch;
      if (!this._pinch && d < PINCH_ON) this._pinch = true;
      else if (this._pinch && d > PINCH_OFF) this._pinch = false;
      const pinchStart = !wasPinch && this._pinch;
      const pinchEnd = wasPinch && !this._pinch;

      // ---- Swipe recognizer ---------------------------------------------
      const center = this._handCenter(lm);
      this._track.push({ x: center.x, y: center.y, t: now });
      if (this._track.length > SWIPE_WINDOW) this._track.shift();
      const swipe = this._detectSwipe(now);

      // ---- Record measured fingertip samples for extrapolation ----------
      this._present = true;
      this._prevReal = this._lastReal;
      this._lastReal = { x: i.x, y: i.y, t: now };

      // ---- Telemetry overlay (only on detection frames) -----------------
      this._drawOverlay(lm, d, this._pinch);

      this.onFrame(
        this._event(true, { x: i.x, y: i.y }, this._pinch, false, swipe, false, {
          pinchStart,
          pinchEnd,
          landmarks: lm,
        })
      );
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

      // Carry the debounced pinch state forward; edges only fire on real frames.
      this.onFrame(this._event(true, cursor, this._pinch, true, null, true));
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
        swipe: swipe || null,
        landmarks: extra.landmarks || null,
        fps: Math.round(this._fps),
        interpolated: !!interpolated,
      };
    }

    _clamp(v, m) { return v > m ? m : v < -m ? -m : v; }
    _clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    _handCenter(lm) {
      const a = lm[0], b = lm[5], c = lm[17];
      return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    }

    _detectSwipe(now) {
      if (this._track.length < SWIPE_WINDOW) return null;
      if (now - this._lastSwipeAt < SWIPE_COOLDOWN_MS) return null;

      const xs = this._track.map((p) => p.x);
      const ys = this._track.map((p) => p.y);
      const dx = xs[xs.length - 1] - xs[0];
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      const dyRange = yMax - yMin;

      if (Math.abs(dx) > SWIPE_DX && dyRange < SWIPE_MAX_DY) {
        this._lastSwipeAt = now;
        this._track.length = 0;
        return dx > 0 ? 'SWIPE_RIGHT' : 'SWIPE_LEFT';
      }
      return null;
    }

    /* ---------------------------------------------------------------------
     * Overlay drawing (telemetry) — only invoked on detection frames.
     * ------------------------------------------------------------------ */
    _clearOverlay() {
      this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    _drawOverlay(lm, dist, pinch) {
      const { width: W, height: H } = this.overlay;
      const ctx = this.octx;
      ctx.clearRect(0, 0, W, H);

      ctx.lineWidth = 2;
      ctx.strokeStyle = pinch ? '#00ff9c' : '#00f3ff';
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
      ctx.fillText(`d=${dist.toFixed(3)} ${pinch ? 'PINCH' : ''}`, 8, 20);
      ctx.fillText(`fps ${Math.round(this._fps)}`, 8, 38);
    }
  }

  window.Vision = { VisionEngine };
})();
