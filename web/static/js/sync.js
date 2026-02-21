// Clock sync — performance.now() anchor model for microsecond-stable server time
//
// Core idea: calibrate a (anchorServerTime, anchorPerfTime) pair via NTP-like ping-pong.
// Between calibrations, derive server time as:
//   serverTime = anchorServerTime + (performance.now() - anchorPerfTime)
//
// performance.now() is monotonic, microsecond-precision, immune to NTP jumps and sleep.
// This eliminates Date.now() instability as a drift source.

class ClockSync {
    constructor() {
        // Anchor pair: the foundation of all server time calculations
        this.anchorServerTime = 0;  // server time (ms) at anchor moment
        this.anchorPerfTime = 0;    // performance.now() (ms) at anchor moment

        // Legacy compat (some code reads .offset)
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

        // Pending ping state — use performance.now() exclusively
        this._pending = null;       // performance.now() when ping sent
        this._pendingWall = 0;      // Date.now() when ping sent (for server protocol compat)
    }

    start(ws) {
        this.ws = ws;
        this.samples = [];
        this.synced = false;
        this.rtt = Infinity;
        this._initialCount = 0;
        this._pending = null;

        // Initial burst: 10 rapid pings at 200ms for fast convergence
        for (let i = 0; i < this._initialTarget; i++) {
            setTimeout(() => this.ping(), i * 200);
        }
        this._scheduleNext();
    }

    _scheduleNext() {
        if (this._timer) clearTimeout(this._timer);
        let interval;
        if (this._initialCount < this._initialTarget) {
            interval = 200;     // fast phase: 200ms
        } else if (!this.synced) {
            interval = 300;     // not yet synced: 300ms
        } else {
            interval = 10000;   // steady state: 10s (anchor is stable between calibrations)
        }
        this._timer = setTimeout(() => { this.ping(); this._scheduleNext(); }, interval);
    }

    stop() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    // Burst mode: 8 rapid pings for quick re-calibration (visibility restore, network change)
    burst() {
        for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 100);
    }

    ping() {
        if (!this.ws || this.ws.readyState !== 1) return;

        // Clear stale pending ping (pong lost/timeout > 2s)
        if (this._pending && performance.now() - this._pending > 2000) {
            this._pending = null;
        }
        if (this._pending) return;

        // Record both clocks at the same instant
        this._pending = performance.now();
        this._pendingWall = Date.now();
        this.ws.send(JSON.stringify({ type: 'ping', clientTime: this._pendingWall }));
    }

    handlePong(msg) {
        if (!this._pending) return;

        const perfNow = performance.now();
        const rtt = perfNow - this._pending;
        const perfAtSend = this._pending;
        this._pending = null;

        // Network change detection — reset samples on network switch
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

        // Reject outliers: RTT > 1s or > 2.5x best known RTT
        if (rtt > 1000) return;
        if (this.rtt < Infinity && rtt > this.rtt * 2.5) return;

        // Calculate server time at the midpoint of the ping-pong exchange
        // midpoint in performance.now() domain = perfAtSend + rtt/2
        const perfMidpoint = perfAtSend + rtt / 2;
        const serverTimeAtMidpoint = msg.serverTime; // server stamped its time at ~midpoint

        this.samples.push({
            serverTime: serverTimeAtMidpoint,
            perfTime: perfMidpoint,
            rtt: rtt,
            ts: perfNow
        });
        if (this.samples.length > this.maxSamples) this.samples.shift();
        this._initialCount++;

        // Transition from initial to steady-state
        if (this._initialCount === this._initialTarget) {
            this._scheduleNext();
        }

        // Expire old samples: 15s when unsynced, 60s when stable
        const expiry = this.synced ? 60000 : 15000;
        const cutoff = perfNow - expiry;
        this.samples = this.samples.filter(s => s.ts > cutoff);

        if (this.samples.length < 3) {
            this.synced = false;
            this.updateUI();
            return;
        }

        // === Anchor calibration via weighted-median filtering ===
        // 1. Sort by RTT (lower RTT = more symmetric = more accurate)
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);

        // 2. Keep best 70% (drop high-RTT outliers)
        const keepN = Math.max(3, Math.ceil(byRtt.length * 0.7));
        const kept = byRtt.slice(0, keepN);

        // 3. Weighted average: weight = 1/RTT (lower RTT = higher weight)
        //    Calculate the offset = serverTime - perfTime for each sample
        //    Then derive anchor from weighted average offset
        let weightSum = 0, offsetSum = 0;
        for (let i = 0; i < kept.length; i++) {
            const w = 1 / Math.max(kept[i].rtt, 1);
            const sampleOffset = kept[i].serverTime - kept[i].perfTime;
            weightSum += w;
            offsetSum += sampleOffset * w;
        }
        const bestOffset = offsetSum / weightSum; // serverTime = perfTime + bestOffset

        // 4. Set anchor: pick the best (lowest RTT) sample's perfTime as anchor point
        //    Then calculate anchorServerTime from the weighted offset
        const bestSample = kept[0]; // lowest RTT
        const newAnchorPerf = bestSample.perfTime;
        const newAnchorServer = newAnchorPerf + bestOffset;

        // 5. Smooth update: small changes (<5ms) blend via EMA, large jumps apply immediately
        if (this.synced && this.anchorPerfTime > 0) {
            const currentEstimate = this.anchorServerTime + (newAnchorPerf - this.anchorPerfTime);
            const delta = Math.abs(newAnchorServer - currentEstimate);
            if (delta < 5) {
                // Small drift: blend 70/30 to avoid jitter
                const blendedServer = 0.7 * currentEstimate + 0.3 * newAnchorServer;
                this.anchorServerTime = blendedServer;
                this.anchorPerfTime = newAnchorPerf;
            } else {
                // Large jump: apply immediately
                this.anchorServerTime = newAnchorServer;
                this.anchorPerfTime = newAnchorPerf;
            }
        } else {
            // First calibration
            this.anchorServerTime = newAnchorServer;
            this.anchorPerfTime = newAnchorPerf;
        }

        // Update legacy fields
        this.rtt = bestSample.rtt;
        this.offset = this.anchorServerTime - this.anchorPerfTime; // compat: offset ≈ serverTime - perfTime
        this.synced = true;
        this.updateUI();
    }

    updateUI() {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const off = this.getServerTime() - Date.now(); // display offset relative to wall clock
        const sign = off >= 0 ? '+' : '';
        el.textContent = `RTT: ${Math.round(this.rtt)}ms | Offset: ${sign}${off.toFixed(1)}ms | Samples: ${this.samples.length}`;
    }

    // Core API: get current server time using performance.now() anchor
    // Monotonic, microsecond-stable, immune to NTP/sleep jumps
    getServerTime() {
        if (!this.synced || this.anchorPerfTime === 0) {
            // Fallback before first calibration: use Date.now() + offset
            return Date.now() + this.offset;
        }
        return this.anchorServerTime + (performance.now() - this.anchorPerfTime);
    }
}

window.clockSync = new ClockSync();
