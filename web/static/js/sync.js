// Clock sync — NTP-like, weighted-median filtering for robust <10ms precision
class ClockSync {
    constructor() {
        this.offset = 0;
        this.rtt = Infinity;
        this.synced = false;
        this.samples = [];
        this.maxSamples = 64;
        this._lastNetType = null;
        this._initialCount = 0;     // samples collected since start/reset
        this._initialTarget = 10;   // fast-sample until this many collected
    }

    start(ws) {
        this.ws = ws;
        this.samples = [];
        this.synced = false;
        this.rtt = Infinity;
        this._initialCount = 0;
        // Initial burst: 10 rapid pings at 200ms for fast convergence
        for (let i = 0; i < this._initialTarget; i++) setTimeout(() => this.ping(), i * 200);
        this._scheduleNext();
    }

    _scheduleNext() {
        if (this._timer) clearTimeout(this._timer);
        // Initial phase (< 10 samples): 200ms; then steady-state: 5000ms; unsynced fallback: 300ms
        let interval;
        if (this._initialCount < this._initialTarget) {
            interval = 200;
        } else if (!this.synced) {
            interval = 300;
        } else {
            interval = 5000;
        }
        this._timer = setTimeout(() => { this.ping(); this._scheduleNext(); }, interval);
    }

    stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

    // Burst mode: send 8 rapid pings at 100ms for quick re-sync (e.g., after visibility change)
    burst() {
        for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 100);
    }

    ping() {
        if (!this.ws || this.ws.readyState !== 1) return;
        // Clear stale pending ping (pong lost/timeout)
        if (this._pending && performance.now() - this._pending > 2000) {
            this._pending = null;
        }
        if (this._pending) return;
        this._pending = performance.now();
        this._pendingWall = Date.now();
        this.ws.send(JSON.stringify({ type: 'ping', clientTime: this._pendingWall }));
    }

    handlePong(msg) {
        if (!this._pending) return;
        const rtt = performance.now() - this._pending;
        this._pending = null;

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

        if (rtt > 1000) return;
        if (this.rtt < Infinity && rtt > this.rtt * 2.5) return;

        const offset = msg.serverTime - (this._pendingWall + rtt / 2);
        this.samples.push({ offset, rtt, ts: performance.now() });
        if (this.samples.length > this.maxSamples) this.samples.shift();
        this._initialCount++;

        // Detect offset jump > 10ms: accelerate sync frequency
        if (this.synced && this.samples.length > 1) {
            const lastOffset = this.samples[this.samples.length - 2].offset;
            if (Math.abs(offset - lastOffset) > 10) {
                this._scheduleNext();
            }
        }

        // Transition from initial to steady-state when target reached
        if (this._initialCount === this._initialTarget) {
            this._scheduleNext();
        }

        // Expire old samples: 10s when unsynced, 30s when stable
        const expiry = this.synced ? 30000 : 10000;
        const cutoff = performance.now() - expiry;
        this.samples = this.samples.filter(s => s.ts > cutoff);

        if (this.samples.length < 3) { this.synced = false; this.updateUI(); return; }

        // Weighted-median filtering:
        // 1. Sort by RTT
        // 2. Drop top 30% (high-RTT outliers)
        // 3. Weighted average of remaining, weight = 1/RTT
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const keepN = Math.max(3, Math.ceil(byRtt.length * 0.7));
        const kept = byRtt.slice(0, keepN);

        let weightSum = 0, offsetSum = 0;
        for (let i = 0; i < kept.length; i++) {
            const w = 1 / Math.max(kept[i].rtt, 1); // avoid div-by-zero
            weightSum += w;
            offsetSum += kept[i].offset * w;
        }
        const newOffset = offsetSum / weightSum;

        // EMA: small changes (<10ms) blend with 0.7/0.3, large jumps apply immediately
        if (this.synced && Math.abs(newOffset - this.offset) < 10) {
            this.offset = 0.7 * this.offset + 0.3 * newOffset;
        } else {
            this.offset = newOffset;
        }
        this.rtt = byRtt[0].rtt;
        this.synced = true;
        this.updateUI();
    }

    updateUI() {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const sign = this.offset >= 0 ? '+' : '';
        el.textContent = `RTT: ${Math.round(this.rtt)}ms | Offset: ${sign}${this.offset.toFixed(1)}ms | Samples: ${this.samples.length}`;
    }

    getServerTime() { return Date.now() + this.offset; }
}

window.clockSync = new ClockSync();
