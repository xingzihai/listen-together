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
        // Aggressive: 150ms when unsynced, 300ms always after synced
        const interval = !this.synced ? 150 : 300;
        this._timer = setTimeout(() => { this.ping(); this._scheduleNext(); }, interval);
    }

    stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

    ping() {
        if (!this.ws || this.ws.readyState !== 1 || this._pending) return;
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
            }
            this._lastNetType = net;
        }

        if (rtt > 1000) return;
        if (this.rtt < Infinity && rtt > this.rtt * 2.5) return;

        const offset = msg.serverTime - (this._pendingWall + rtt / 2);
        this.samples.push({ offset, rtt, ts: performance.now() });
        if (this.samples.length > this.maxSamples) this.samples.shift();

        // Expire old samples (10s — only keep very fresh data)
        const cutoff = performance.now() - 10000;
        this.samples = this.samples.filter(s => s.ts > cutoff);

        if (this.samples.length < 3) { this.synced = false; this.updateUI(); return; }

        // Use average offset from the 3 lowest-RTT samples
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const topN = Math.min(3, byRtt.length);
        let sum = 0;
        for (let i = 0; i < topN; i++) sum += byRtt[i].offset;
        const newOffset = sum / topN;

        // Tight EMA: small changes (<10ms) blend aggressively, large jumps apply immediately
        if (this.synced && Math.abs(newOffset - this.offset) < 10) {
            this.offset = 0.9 * this.offset + 0.1 * newOffset;
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
