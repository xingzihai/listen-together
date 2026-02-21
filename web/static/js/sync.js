// Clock sync — direct serverTime↔ctxTime anchor for hardware-level playback precision
//
// Architecture: THREE anchors calibrated simultaneously during each ping/pong:
//   1. anchorServerTime (ms) — server's clock at midpoint
//   2. anchorPerfTime (ms)   — performance.now() at midpoint  
//   3. anchorCtxTime (s)     — AudioContext.currentTime at midpoint
//
// All three captured at the same instant, eliminating cross-clock-domain conversion errors.
//
// APIs:
//   getServerTime()  → current server time (ms), via perfTime anchor
//   serverTimeToCtx(serverTimeMs) → ctx.currentTime value, via direct anchor
//
// The key insight: performance.now() and ctx.currentTime use DIFFERENT hardware clocks.
// Converting between them at playback time introduces error that grows with elapsed time.
// By calibrating both against serverTime simultaneously, we get a direct mapping.

class ClockSync {
    constructor() {
        // Triple anchor: all three captured at the same instant
        this.anchorServerTime = 0;  // server time (ms) at anchor moment
        this.anchorPerfTime = 0;    // performance.now() (ms) at anchor moment
        this.anchorCtxTime = 0;     // AudioContext.currentTime (seconds) at anchor moment

        // Legacy compat
        this.offset = 0;
        this.rtt = Infinity;
        this.synced = false;

        // Sample buffer for calibration
        this.samples = [];
        this.maxSamples = 64;

        // Network change detection
        this._lastNetType = null;

        // Initial fast-sync phase
        this._initialCount = 0;
        this._initialTarget = 10;

        // Pending ping state
        this._pending = null;       // performance.now() when ping sent
        this._pendingCtx = 0;       // ctx.currentTime when ping sent
        this._pendingWall = 0;      // Date.now() when ping sent (protocol compat)
    }

    start(ws) {
        this.ws = ws;
        this.samples = [];
        this.synced = false;
        this.rtt = Infinity;
        this._initialCount = 0;
        this._pending = null;

        for (let i = 0; i < this._initialTarget; i++) {
            setTimeout(() => this.ping(), i * 200);
        }
        this._scheduleNext();
    }

    _scheduleNext() {
        if (this._timer) clearTimeout(this._timer);
        let interval;
        if (this._initialCount < this._initialTarget) {
            interval = 200;
        } else if (!this.synced) {
            interval = 300;
        } else {
            interval = 10000;
        }
        this._timer = setTimeout(() => { this.ping(); this._scheduleNext(); }, interval);
    }

    stop() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    burst() {
        for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 100);
    }

    ping() {
        if (!this.ws || this.ws.readyState !== 1) return;

        if (this._pending && performance.now() - this._pending > 2000) {
            this._pending = null;
        }
        if (this._pending) return;

        // Capture ALL clocks at the same instant
        // Order matters: ctx first (least volatile), then perf, then wall
        const ctx = window.audioPlayer && window.audioPlayer.ctx;
        this._pendingCtx = ctx ? ctx.currentTime : 0;
        this._pending = performance.now();
        this._pendingWall = Date.now();
        this.ws.send(JSON.stringify({ type: 'ping', clientTime: this._pendingWall }));
    }

    handlePong(msg) {
        if (!this._pending) return;

        // Capture clocks at pong receipt — same order as ping
        const ctx = window.audioPlayer && window.audioPlayer.ctx;
        const ctxNow = ctx ? ctx.currentTime : 0;
        const perfNow = performance.now();
        const rtt = perfNow - this._pending;
        const perfAtSend = this._pending;
        const ctxAtSend = this._pendingCtx;
        this._pending = null;

        // Network change detection
        if (navigator.connection) {
            const net = (navigator.connection.type || '') + '/' + (navigator.connection.effectiveType || '');
            if (this._lastNetType && net !== this._lastNetType) {
                this.samples = [];
                this.synced = false;
                this.rtt = Infinity;
                this._initialCount = 0;
                this._scheduleNext();
            }
            this._lastNetType = net;
        }

        // Reject outliers
        if (rtt > 1000) return;
        if (this.rtt < Infinity && rtt > this.rtt * 2.5) return;

        // Midpoint calculation
        const perfMidpoint = perfAtSend + rtt / 2;
        const serverTimeAtMidpoint = msg.serverTime;

        // ctx midpoint: interpolate between send and receive ctx times
        // ctx.currentTime advances linearly, so linear interpolation is exact
        const ctxMidpoint = ctxAtSend + (ctxNow - ctxAtSend) / 2;

        this.samples.push({
            serverTime: serverTimeAtMidpoint,
            perfTime: perfMidpoint,
            ctxTime: ctxMidpoint,
            rtt: rtt,
            ts: perfNow
        });
        if (this.samples.length > this.maxSamples) this.samples.shift();
        this._initialCount++;

        if (this._initialCount === this._initialTarget) {
            this._scheduleNext();
        }

        // Expire old samples
        const expiry = this.synced ? 60000 : 15000;
        const cutoff = perfNow - expiry;
        this.samples = this.samples.filter(s => s.ts > cutoff);

        if (this.samples.length < 3) {
            this.synced = false;
            this.updateUI();
            return;
        }

        // === Triple anchor calibration via weighted-median filtering ===
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const keepN = Math.max(3, Math.ceil(byRtt.length * 0.7));
        const kept = byRtt.slice(0, keepN);

        // Weighted average of offsets: serverTime-perfTime and serverTime-ctxTime
        let weightSum = 0, perfOffsetSum = 0, ctxOffsetSum = 0;
        for (let i = 0; i < kept.length; i++) {
            const w = 1 / Math.max(kept[i].rtt, 1);
            weightSum += w;
            perfOffsetSum += (kept[i].serverTime - kept[i].perfTime) * w;
            // ctxTime is in seconds, serverTime in ms — store offset in ms for consistency
            ctxOffsetSum += (kept[i].serverTime - kept[i].ctxTime * 1000) * w;
        }
        const bestPerfOffset = perfOffsetSum / weightSum;
        const bestCtxOffset = ctxOffsetSum / weightSum;

        // Anchor point: use best (lowest RTT) sample's times
        const best = kept[0];
        const newAnchorPerf = best.perfTime;
        const newAnchorServer = newAnchorPerf + bestPerfOffset;
        const newAnchorCtx = (newAnchorServer - bestCtxOffset) / 1000; // convert back to seconds

        // Smooth update
        if (this.synced && this.anchorPerfTime > 0) {
            const currentEstimate = this.anchorServerTime + (newAnchorPerf - this.anchorPerfTime);
            const delta = Math.abs(newAnchorServer - currentEstimate);
            if (delta < 5) {
                const blendedServer = 0.7 * currentEstimate + 0.3 * newAnchorServer;
                // Maintain consistent ctx anchor: apply same blend ratio
                const currentCtxEstimate = this.anchorCtxTime + (newAnchorPerf - this.anchorPerfTime) / 1000;
                const blendedCtx = 0.7 * currentCtxEstimate + 0.3 * newAnchorCtx;
                this.anchorServerTime = blendedServer;
                this.anchorPerfTime = newAnchorPerf;
                this.anchorCtxTime = blendedCtx;
            } else {
                this.anchorServerTime = newAnchorServer;
                this.anchorPerfTime = newAnchorPerf;
                this.anchorCtxTime = newAnchorCtx;
            }
        } else {
            this.anchorServerTime = newAnchorServer;
            this.anchorPerfTime = newAnchorPerf;
            this.anchorCtxTime = newAnchorCtx;
        }

        this.rtt = best.rtt;
        this.offset = this.anchorServerTime - this.anchorPerfTime;
        this.synced = true;
        this.updateUI();
    }

    updateUI() {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const off = this.getServerTime() - Date.now();
        const sign = off >= 0 ? '+' : '';
        el.textContent = `RTT: ${Math.round(this.rtt)}ms | Offset: ${sign}${off.toFixed(1)}ms | Samples: ${this.samples.length}`;
    }

    // Get current server time via performance.now() anchor (for non-audio use)
    getServerTime() {
        if (!this.synced || this.anchorPerfTime === 0) {
            return Date.now() + this.offset;
        }
        return this.anchorServerTime + (performance.now() - this.anchorPerfTime);
    }

    // Direct serverTime→ctx.currentTime mapping (for audio scheduling)
    // ONE conversion, no intermediate clock domain
    serverTimeToCtx(serverTimeMs) {
        if (!this.synced || this.anchorCtxTime === 0) {
            // Fallback: use perf-based conversion (less precise)
            const perfTarget = this.anchorPerfTime + (serverTimeMs - this.anchorServerTime);
            const perfNow = performance.now();
            const ctx = window.audioPlayer && window.audioPlayer.ctx;
            const ctxNow = ctx ? ctx.currentTime : 0;
            return ctxNow - (perfNow - perfTarget) / 1000;
        }
        // Direct mapping: no perfTime intermediate
        return this.anchorCtxTime + (serverTimeMs - this.anchorServerTime) / 1000;
    }
}

window.clockSync = new ClockSync();
