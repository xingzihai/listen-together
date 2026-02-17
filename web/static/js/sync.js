class ClockSync {
    constructor() {
        this.offset = 0; this.rtt = 0; this.synced = false;
        this.samples = []; this.maxSamples = 30;
    }

    start(ws) {
        this.ws = ws;
        // Burst 5 pings quickly for fast initial sync
        for (let i = 0; i < 5; i++) setTimeout(() => this.ping(), i * 100);
        this.interval = setInterval(() => this.ping(), 500); // 2x per second
    }

    stop() { if (this.interval) { clearInterval(this.interval); this.interval = null; } }

    ping() {
        if (!this.ws || this.ws.readyState !== 1 || this._pendingPing) return;
        const clientTime = performance.now();
        this._pendingPing = clientTime;
        this._pendingWall = Date.now();
        this.ws.send(JSON.stringify({ type: 'ping', clientTime: this._pendingWall }));
    }

    handlePong(msg) {
        if (!this._pendingPing || msg.clientTime !== this._pendingWall) return;
        const now = performance.now();
        const rtt = now - this._pendingPing;
        this._pendingPing = null;
        this._pendingWall = null;

        // Discard outliers (RTT > 500ms likely network hiccup)
        if (rtt > 500) return;

        const serverTime = msg.serverTime;
        const offset = serverTime + rtt / 2 - Date.now();

        this.samples.push({ offset, rtt, ts: now });
        if (this.samples.length > this.maxSamples) this.samples.shift();

        // Use median of best 10 by RTT for stability
        const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        const best = sorted.slice(0, Math.min(10, sorted.length));

        // Median offset (more robust than mean against outliers)
        const offsets = best.map(x => x.offset).sort((a, b) => a - b);
        const mid = Math.floor(offsets.length / 2);
        this.offset = offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
        this.rtt = best.reduce((s, x) => s + x.rtt, 0) / best.length;
        this.synced = this.samples.length >= 3;

        this.updateUI();
    }

    updateUI() {
        const el = document.getElementById('syncStatus');
        if (el) {
            const sign = this.offset >= 0 ? '+' : '';
            el.textContent = `RTT: ${Math.round(this.rtt)}ms | Offset: ${sign}${this.offset.toFixed(1)}ms | Samples: ${this.samples.length}`;
        }
    }

    serverToLocal(serverTime) { return serverTime - this.offset; }
    getServerTime() { return Date.now() + this.offset; }
}

window.clockSync = new ClockSync();
