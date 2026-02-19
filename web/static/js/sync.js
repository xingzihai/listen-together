// Clock sync — NTP-like with AudioContext precision + median filtering (Snapcast-style)
class ClockSync {
    constructor() {
        this.offset = 0;
        this.rtt = Infinity;
        this.synced = false;
        this.samples = [];
        this.maxSamples = 64;
        this._lastNetType = null;
        this._audioCtx = null;
        this._offsetBuffer = [];  // For median filtering
    }

    // Set AudioContext for high-precision timing
    setAudioContext(ctx) {
        this._audioCtx = ctx;
    }

    // Get current time in ms using AudioContext (for drift measurement)
    now() {
        if (this._audioCtx) {
            const ts = this._audioCtx.getOutputTimestamp?.();
            return (ts?.contextTime ?? this._audioCtx.currentTime) * 1000;
        }
        return performance.now();
    }

    // Internal: get high-precision local time for sync calculations
    _getLocalTime() {
        if (this._audioCtx) {
            const ts = this._audioCtx.getOutputTimestamp?.();
            if (ts?.performanceTime !== undefined) {
                // Map AudioContext time to wall clock
                const audioNow = (ts.contextTime ?? this._audioCtx.currentTime) * 1000;
                const perfNow = ts.performanceTime;
                return Date.now() - (performance.now() - perfNow);
            }
        }
        return Date.now();
    }

    start(ws) {
        this.ws = ws;
        this.samples = [];
        this._offsetBuffer = [];
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
        if (this._offsetBuffer.length < 10) return false;
        const recent = this._offsetBuffer.slice(-10);
        const sorted = [...recent].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        // Stable if all recent samples within 3ms of median
        return recent.every(o => Math.abs(o - median) < 3);
    }

    stop() { 
        if (this._timer) { 
            clearTimeout(this._timer); 
            this._timer = null; 
        }
        this._pending = null;
    }

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
        this._pendingAudio = this.now();  // Record AudioContext time too
        this.ws.send(JSON.stringify({ type: 'ping', clientTime: this._pendingWall }));
    }

    handlePong(msg) {
        if (!this._pending) return;
        const rtt = performance.now() - this._pending;
        this._pending = null;

        // Network change detection
        if (navigator.connection) {
            const net = (navigator.connection.type || '') + '/' + (navigator.connection.effectiveType || '');
            if (this._lastNetType && net !== this._lastNetType) {
                this.samples = [];
                this._offsetBuffer = [];
                this.synced = false;
                this.rtt = Infinity;
                this._scheduleNext();
            }
            this._lastNetType = net;
        }

        // RTT sanity checks
        if (rtt > 1000) return;
        if (this.rtt < Infinity && rtt > this.rtt * 2.5) return;

        // Calculate offset using wall clock (server uses wall clock)
        const offset = msg.serverTime - (this._pendingWall + rtt / 2);
        this.samples.push({ offset, rtt, ts: performance.now() });
        if (this.samples.length > this.maxSamples) this.samples.shift();

        // Detect offset jump > 10ms: accelerate sync frequency
        if (this.synced && this._offsetBuffer.length > 0) {
            const lastOffset = this._offsetBuffer[this._offsetBuffer.length - 1];
            if (Math.abs(offset - lastOffset) > 10) {
                this._scheduleNext();
            }
        }

        // Expire old samples (10s)
        const cutoff = performance.now() - 10000;
        this.samples = this.samples.filter(s => s.ts > cutoff);

        if (this.samples.length < 3) { 
            this.synced = false; 
            this.updateUI(); 
            return; 
        }

        // Median filtering (Snapcast-style): keep last 100 offsets
        this._offsetBuffer.push(offset);
        if (this._offsetBuffer.length > 100) this._offsetBuffer.shift();

        // Calculate median offset
        const sorted = [...this._offsetBuffer].sort((a, b) => a - b);
        const medianOffset = sorted[Math.floor(sorted.length / 2)];

        // Update offset
        this.offset = medianOffset;

        // RTT: use minimum from recent samples
        const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        this.rtt = byRtt[0].rtt;
        this.synced = true;
        this.updateUI();
    }

    updateUI() {
        const el = document.getElementById('syncStatus');
        if (!el) return;
        const sign = this.offset >= 0 ? '+' : '';
        el.textContent = `RTT: ${Math.round(this.rtt)}ms | Offset: ${sign}${this.offset.toFixed(1)}ms | Samples: ${this._offsetBuffer.length}`;
    }

    // Returns server time (wall clock based, for compatibility)
    getServerTime() { 
        return Date.now() + this.offset; 
    }
}

window.clockSync = new ClockSync();
