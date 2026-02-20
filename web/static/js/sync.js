// Clock sync — NTP-like, aggressive tuning for <10ms precision
class ClockSync {
    constructor() {
        this.offset = 0;
        this.rtt = Infinity;
        this.synced = false;
        this.samples = [];
        this.maxSamples = 64;
        this._lastNetType = null;
    }

    start(ws) {
        this.ws = ws;
        this.samples = [];
        this.synced = false;
        this.rtt = Infinity;
        // Burst 16 pings for fast initial sync
        for (let i = 0; i < 16; i++) setTimeout(() => this.ping(), i * 40);
        this._scheduleNext();
    }

    _scheduleNext() {
        if (this._timer) clearTimeout(this._timer);
        // Adaptive frequency: 150ms unsynced, 300ms normal, 2000ms when stable
        let interval = !this.synced ? 150 : 300;
        if (this.synced && this._isStable()) interval = 2000;
        this._timer = setTimeout(() => { this.ping(); this._scheduleNext(); }, interval);
    }

    // Check if recent offsets are stable (all changes < 3ms)
    _isStable() {
        if (this.samples.length < 5) return false;
        const recent = this.samples.slice(-5);
        for (let i = 1; i < recent.length; i++) {
            if (Math.abs(recent[i].offset - recent[i-1].offset) > 3) return false;
        }
        return true;
    }

    stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

    // Burst mode: send 8 rapid pings for quick re-sync (e.g., after visibility change)
    burst() {
        for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 50);
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
                // Network change: accelerate back to 300ms
                this._scheduleNext();
            }
            this._lastNetType = net;
        }

        if (rtt > 1000) return;
        if (this.rtt < Infinity && rtt > this.rtt * 2.5) return;

        const offset = msg.serverTime - (this._pendingWall + rtt / 2);
        this.samples.push({ offset, rtt, ts: performance.now() });
        if (this.samples.length > this.maxSamples) this.samples.shift();

        // Detect offset jump > 10ms: accelerate sync frequency
        if (this.synced && this.samples.length > 1) {
            const lastOffset = this.samples[this.samples.length - 2].offset;
            if (Math.abs(offset - lastOffset) > 10) {
                this._scheduleNext(); // Reset to faster interval
            }
        }

        // Expire old samples: 10s when unsynced (need fresh data), 30s when stable
        const expiry = (this.synced && this._isStable()) ? 30000 : 10000;
        const cutoff = performance.now() - expiry;
        this.samples = this.samples.filter(s => s.ts > cutoff);

        if (this.samples.length < 3) { this.synced = false; this.updateUI(); return; }

        // Use average offset from the 3 lowest-RTT samples
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const topN = Math.min(3, byRtt.length);
        let sum = 0;
        for (let i = 0; i < topN; i++) sum += byRtt[i].offset;
        const newOffset = sum / topN;

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
