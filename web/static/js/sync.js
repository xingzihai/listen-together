// Clock sync — NTP-like, using Date.now() consistently
// Keep it simple: Date.now() for wall clock, performance.now() only for RTT measurement
class ClockSync {
    constructor() {
        this.offset = 0;       // server_time - Date.now() (ms)
        this.rtt = Infinity;
        this.synced = false;
        this.samples = [];
        this.maxSamples = 48;
        this._lastNetType = null;
    }

    start(ws) {
        this.ws = ws;
        this.samples = [];
        this.synced = false;
        this.rtt = Infinity;
        // Burst 8 pings for fast initial sync
        for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 60);
        this._scheduleNext();
    }

    _scheduleNext() {
        if (this._timer) clearTimeout(this._timer);
        const interval = !this.synced ? 200 : (this.rtt > 150 ? 500 : 1000);
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

        // Network change detection — flush samples
        if (navigator.connection) {
            const net = (navigator.connection.type || '') + '/' + (navigator.connection.effectiveType || '');
            if (this._lastNetType && net !== this._lastNetType) {
                this.samples = [];
                this.synced = false;
                this.rtt = Infinity;
            }
            this._lastNetType = net;
        }

        if (rtt > 2000) return;
        if (this.rtt < Infinity && rtt > this.rtt * 3) return;

        // offset = serverTime - (clientSendTime + rtt/2)
        const offset = msg.serverTime - (this._pendingWall + rtt / 2);

        this.samples.push({ offset, rtt, ts: performance.now() });
        if (this.samples.length > this.maxSamples) this.samples.shift();

        // Expire old samples (30s)
        const cutoff = performance.now() - 30000;
        this.samples = this.samples.filter(s => s.ts > cutoff);

        if (this.samples.length < 3) { this.synced = false; this.updateUI(); return; }

        // Use average offset from the 3 lowest-RTT samples — most accurate & stable
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const topN = Math.min(3, byRtt.length);
        let sum = 0;
        for (let i = 0; i < topN; i++) sum += byRtt[i].offset;
        const newOffset = sum / topN;
        // EMA smoothing: small changes (<20ms) blend gradually, large jumps apply immediately
        if (this.synced && Math.abs(newOffset - this.offset) < 20) {
            this.offset = 0.7 * this.offset + 0.3 * newOffset;
        } else {
            this.offset = newOffset;
        }
        this.rtt = best[0].rtt;
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
