/**
 * speech.js
 * ---------------------------------------------------------------------------
 * Web Speech API Voice Layer.
 *
 * Provides hands-free macro commands so the user isn't forced to gesture for
 * everything (gesture fatigue is real). We use the native SpeechRecognition
 * with a *strict intent map* — each spoken phrase is normalized and matched
 * against a small vocabulary, and anything else is ignored. This keeps false
 * positives low even with continuous listening.
 *
 * Intent map (phrase -> intent):
 *   "execute" / "run" / "run algorithm"   -> EXECUTE   (play the whole trace)
 *   "forward" / "next" / "step"           -> FORWARD   (SWIPE_RIGHT / next line)
 *   "back" / "previous" / "undo"          -> BACK      (SWIPE_LEFT / pop step)
 *   "clear" / "reset"                     -> CLEAR     (flush scene)
 *
 * The engine emits `{ intent, transcript, confidence }` through onCommand and
 * pushes `listening | processing | error | idle` through onStatus so the HUD
 * can render a live indicator. Recognition auto-restarts on end so continuous
 * mode survives the browser's periodic silence timeouts.
 * ---------------------------------------------------------------------------
 */

'use strict';

(function () {
  /**
   * Ordered intent rules. Each rule has a set of trigger words; we match by
   * word-boundary inclusion so "next step please" still maps to FORWARD.
   * Order matters only for overlap resolution (none overlap here).
   */
  const INTENT_RULES = [
    { intent: 'EXECUTE', triggers: ['execute', 'run algorithm', 'run', 'go'] },
    { intent: 'FORWARD', triggers: ['forward', 'next', 'step', 'advance'] },
    { intent: 'BACK',    triggers: ['back', 'previous', 'undo', 'reverse'] },
    { intent: 'CLEAR',   triggers: ['clear', 'reset', 'wipe'] },
  ];

  class SpeechEngine {
    /**
     * @param {Object} opts
     * @param {(cmd:{intent:string,transcript:string,confidence:number})=>void} opts.onCommand
     * @param {(state:string, detail?:string)=>void} [opts.onStatus]
     */
    constructor({ onCommand, onStatus } = {}) {
      this.onCommand = onCommand || (() => {});
      this.onStatus = onStatus || (() => {});

      this.recognition = null;
      this.supported = false;
      this.enabled = false;      // user intends to be listening
      this._restarting = false;

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        this.onStatus('error', 'SpeechRecognition unsupported in this browser.');
        return;
      }
      this.supported = true;

      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = 'en-US';
      rec.maxAlternatives = 3;

      rec.onstart = () => this.onStatus('listening', 'Listening…');
      rec.onaudiostart = () => this.onStatus('listening', 'Listening…');

      rec.onresult = (event) => this._handleResult(event);

      rec.onerror = (event) => {
        // 'no-speech' and 'aborted' are benign in continuous mode.
        if (event.error === 'no-speech' || event.error === 'aborted') {
          this.onStatus('listening', 'Listening…');
          return;
        }
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this.enabled = false;
          this.onStatus('error', 'Microphone permission denied.');
          return;
        }
        console.warn('[speech] recognition error:', event.error);
        this.onStatus('error', `Speech error: ${event.error}`);
      };

      rec.onend = () => {
        // Auto-restart to keep continuous mode alive through silence timeouts.
        if (this.enabled && !this._restarting) {
          this._restarting = true;
          setTimeout(() => {
            this._restarting = false;
            if (this.enabled) {
              try {
                rec.start();
              } catch (err) {
                // start() throws if already started; safe to ignore.
                console.debug('[speech] restart skipped:', err && err.message);
              }
            }
          }, 250);
        } else if (!this.enabled) {
          this.onStatus('idle', 'Voice off.');
        }
      };

      this.recognition = rec;
    }

    /* ---------------------------------------------------------------------
     * Public control.
     * ------------------------------------------------------------------ */
    start() {
      if (!this.supported) {
        this.onStatus('error', 'Voice unavailable.');
        return;
      }
      this.enabled = true;
      try {
        this.recognition.start();
      } catch (err) {
        // Calling start() while already running throws InvalidStateError.
        console.debug('[speech] start ignored:', err && err.message);
      }
    }

    stop() {
      this.enabled = false;
      if (this.recognition) {
        try {
          this.recognition.stop();
        } catch (_e) {
          /* ignore */
        }
      }
      this.onStatus('idle', 'Voice off.');
    }

    toggle() {
      if (this.enabled) this.stop();
      else this.start();
      return this.enabled;
    }

    /* ---------------------------------------------------------------------
     * Result handling + strict intent matching.
     * ------------------------------------------------------------------ */
    _handleResult(event) {
      this.onStatus('processing', 'Processing…');

      // Walk the newest final results; check all alternatives for a match.
      for (let r = event.resultIndex; r < event.results.length; r++) {
        const result = event.results[r];
        if (!result.isFinal) continue;

        for (let a = 0; a < result.length; a++) {
          const alt = result[a];
          const transcript = (alt.transcript || '').toLowerCase().trim();
          const intent = this._matchIntent(transcript);
          if (intent) {
            this.onStatus('listening', `✓ ${intent.toLowerCase()}`);
            this.onCommand({
              intent,
              transcript,
              confidence: alt.confidence || 0,
            });
            return; // one command per utterance
          }
        }
      }

      // No intent matched — return to listening quietly.
      this.onStatus('listening', 'Listening…');
    }

    /**
     * Strict matching: the transcript must contain a trigger phrase as a whole
     * word / phrase. Longer trigger phrases are tested first within a rule.
     * @returns {string|null} intent name or null
     */
    _matchIntent(transcript) {
      if (!transcript) return null;
      const padded = ` ${transcript} `;
      for (const rule of INTENT_RULES) {
        // Test longer triggers first to prefer "run algorithm" over "run".
        const triggers = [...rule.triggers].sort((a, b) => b.length - a.length);
        for (const phrase of triggers) {
          if (padded.includes(` ${phrase} `)) return rule.intent;
        }
      }
      return null;
    }
  }

  window.Speech = { SpeechEngine, INTENT_RULES };
})();
