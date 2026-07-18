/**
 * vision.js
 * ---------------------------------------------------------------------------
 * MediaPipe Computer Vision Layer.
 *
 * Owns the webcam stream and the MediaPipe HandLandmarker. On every video
 * frame it:
 *   1. Detects up to one hand (21 3D landmarks).
 *   2. Computes a debounced PINCH state via 3D Euclidean distance between the
 *      THUMB_TIP (4) and INDEX_FINGER_TIP (8) with hysteresis.
 *   3. Runs a SWIPE recognizer over a short ring buffer of hand-center X/Y.
 *   4. Draws telemetry (landmarks + skeleton + pinch readout) to an overlay.
 *   5. Emits a normalized event object through the `onFrame` callback.
 *
 * Everything downstream (render3d, app) consumes only the normalized event:
 *
 *   {
 *     present:  boolean,               // is a hand visible this frame
 *     cursor:   { x, y } | null,       // index tip, 0..1, ALREADY MIRRORED
 *     pinch:    boolean,               // debounced pinch state
 *     pinchStart / pinchEnd: boolean,  // edge events (true for one frame)
 *     swipe:    'SWIPE_LEFT'|'SWIPE_RIGHT'|null,
 *     landmarks: Array|null,           // raw 21 landmarks (mirrored x)
 *     fps:      number,
 *   }
 *
 * The MediaPipe Tasks Vision module is imported dynamically from a CDN so this
 * file can live in a plain <script> without a build step.
 * ---------------------------------------------------------------------------
 */

'use strict';

(function () {
  // Landmark indices we care about (MediaPipe Hand topology).
  const THUMB_TIP = 4;
  const INDEX_TIP = 8;

  // Connections for drawing the hand skeleton overlay.
  const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],            // thumb
    [0, 5], [5, 6], [6, 7], [7, 8],            // index
    [5, 9], [9, 10], [10, 11], [11, 12],       // middle
    [9, 13], [13, 14], [14, 15], [15, 16],     // ring
    [13, 17], [17, 18], [18, 19], [19, 20],    // pinky
    [0, 17],                                   // palm base
  ];

  // Pinch hysteresis thresholds (normalized 3D distance).
  const PINCH_ON = 0.045;
  const PINCH_OFF = 0.07;

  // Swipe recognizer tuning.
  const SWIPE_WINDOW = 6;      // frames tracked in the ring buffer
  const SWIPE_DX = 0.22;       // min normalized horizontal travel
  const SWIPE_MAX_DY = 0.12;   // max vertical variance to still count as horizontal
  const SWIPE_COOLDOWN_MS = 650;

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
      this.octx = overlay.getContext('2d');
      this.onFrame = onFrame || (() => {});
      this.onStatus = onStatus || (() => {});

      this.landmarker = null;
      this.running = false;
      this._rafId = null;
      this._lastVideoTime = -1;

      // Debounced pinch state + edge flags.
      this._pinch = false;

      // Swipe ring buffer of { x, y, t }.
      this._track = [];
      this._lastSwipeAt = 0;

      // FPS smoothing.
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
        // Dynamic import keeps us build-free while using the ES module bundle.
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
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
      // Match the overlay's backing store to the video's intrinsic size.
      const w = this.video.videoWidth || 640;
      const h = this.video.videoHeight || 480;
      if (this.overlay.width !== w) this.overlay.width = w;
      if (this.overlay.height !== h) this.overlay.height = h;
    }

    /* ---------------------------------------------------------------------
     * Detection loop.
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
        this._detect();
      } catch (err) {
        console.error('[vision] detect error:', err);
      }
      this._rafId = requestAnimationFrame(this._boundLoop);
    }

    _detect() {
      if (this.video.readyState < 2) return; // not enough data yet

      // FPS (EMA).
      const now = performance.now();
      const dt = now - this._lastT;
      this._lastT = now;
      if (dt > 0) this._fps = this._fps * 0.9 + (1000 / dt) * 0.1;

      // Only run the model on fresh frames.
      if (this.video.currentTime === this._lastVideoTime) {
        this._rafId = requestAnimationFrame(this._boundLoop);
        return;
      }
      this._lastVideoTime = this.video.currentTime;

      const result = this.landmarker.detectForVideo(this.video, now);
      this._syncOverlaySize();

      const hasHand = result && result.landmarks && result.landmarks.length > 0;
      if (!hasHand) {
        this._pinch = false;
        this._track.length = 0;
        this._clearOverlay();
        this.onFrame({
          present: false,
          cursor: null,
          pinch: false,
          pinchStart: false,
          pinchEnd: false,
          swipe: null,
          landmarks: null,
          fps: Math.round(this._fps),
        });
        return;
      }

      // Mirror X so on-screen motion matches the user (selfie view).
      const raw = result.landmarks[0];
      const lm = raw.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));

      // ---- Pinch: 3D Euclidean distance with hysteresis ----------------
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

      // ---- Swipe recognizer --------------------------------------------
      const center = this._handCenter(lm);
      this._track.push({ x: center.x, y: center.y, t: now });
      if (this._track.length > SWIPE_WINDOW) this._track.shift();
      const swipe = this._detectSwipe(now);

      // ---- Telemetry overlay -------------------------------------------
      this._drawOverlay(lm, d, this._pinch);

      // The cursor is the index fingertip.
      this.onFrame({
        present: true,
        cursor: { x: i.x, y: i.y },
        pinch: this._pinch,
        pinchStart,
        pinchEnd,
        swipe,
        landmarks: lm,
        fps: Math.round(this._fps),
      });
    }

    _handCenter(lm) {
      // Palm-ish center: average of wrist(0), index MCP(5), pinky MCP(17).
      const a = lm[0], b = lm[5], c = lm[17];
      return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    }

    _detectSwipe(now) {
      if (this._track.length < SWIPE_WINDOW) return null;
      if (now - this._lastSwipeAt < SWIPE_COOLDOWN_MS) return null;

      const xs = this._track.map((p) => p.x);
      const ys = this._track.map((p) => p.y);
      const dx = xs[xs.length - 1] - xs[0];

      // Vertical variance must stay low to qualify as a horizontal swipe.
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      const dyRange = yMax - yMin;

      if (Math.abs(dx) > SWIPE_DX && dyRange < SWIPE_MAX_DY) {
        this._lastSwipeAt = now;
        this._track.length = 0; // consume the gesture
        // Cursor x is already mirrored, so +dx = moving right on screen.
        return dx > 0 ? 'SWIPE_RIGHT' : 'SWIPE_LEFT';
      }
      return null;
    }

    /* ---------------------------------------------------------------------
     * Overlay drawing (telemetry debug frames).
     * ------------------------------------------------------------------ */
    _clearOverlay() {
      this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    _drawOverlay(lm, dist, pinch) {
      const { width: W, height: H } = this.overlay;
      const ctx = this.octx;
      ctx.clearRect(0, 0, W, H);

      // Connections.
      ctx.lineWidth = 2;
      ctx.strokeStyle = pinch ? '#00ff9c' : '#00f3ff';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = lm[a], pb = lm[b];
        ctx.moveTo(pa.x * W, pa.y * H);
        ctx.lineTo(pb.x * W, pb.y * H);
      }
      ctx.stroke();

      // Landmarks.
      for (let k = 0; k < lm.length; k++) {
        const p = lm[k];
        const isKey = k === THUMB_TIP || k === INDEX_TIP;
        ctx.beginPath();
        ctx.arc(p.x * W, p.y * H, isKey ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = isKey ? '#bd00ff' : '#e6faff';
        ctx.fill();
      }

      // Pinch distance readout + connecting line between tips.
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
