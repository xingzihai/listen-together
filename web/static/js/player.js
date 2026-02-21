class AudioPlayer {
    constructor() {
        this.ctx = null; this.gainNode = null; this.segments = []; this.buffers = new Map();
        this.sources = []; this.isPlaying = false; this.startTime = 0; this.startOffset = 0;
        this.lastPosition = 0; this.duration = 0; this.segmentTime = 5; this.roomCode = '';
        this.serverPlayTime = 0; this.serverPlayPosition = 0;
        this.onBuffering = null;
        this._trackSegBase = null;
        this._quality = localStorage.getItem('lt_quality') || 'medium';
        this._actualQuality = 'medium';
        this._upgrading = false;
        this._qualities = [];
        this._ownerID = null;
        this._audioID = null;
        this.onQualityChange = null;
        // Lookahead scheduler state
        this._lookaheadTimer = null;
        this._nextSegIdx = 0;       // next segment to schedule
        this._nextSegTime = 0;      // AudioContext time for next segment
        // Server-authority sync: simple drift detection + hard reset
        this._driftCount = 0;           // consecutive over-threshold count
        this._lastResetTime = 0;        // last forced reset timestamp (performance.now())
        this._DRIFT_THRESHOLD = 0.15;   // 150ms
        this._DRIFT_COUNT_LIMIT = 3;    // 3 consecutive triggers reset
        this._RESET_COOLDOWN = 5000;    // 5s cooldown after reset
        this._lastDrift = 0;            // latest drift from syncTick (seconds, positive=ahead)
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.gainNode = this.ctx.createGain();
            this.gainNode.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        // Hardware output latency — applied to scheduling for cross-device sync
        this._outputLatency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
        console.log(`[sync] outputLatency: ${(this._outputLatency*1000).toFixed(1)}ms`);
    }

    async loadAudio(audioInfo, roomCode) {
        this.stop();
        this.segments = audioInfo.segments || [];
        this.duration = audioInfo.duration || 0;
        this.segmentTime = audioInfo.segmentTime || 5;
        this.roomCode = roomCode;
        this.buffers.clear();
        this._qualities = audioInfo.qualities || [];
        this._ownerID = audioInfo.ownerID || null;
        this._audioID = audioInfo.audioID || null;
        this._audioUUID = audioInfo.audioUUID || null;
        this._upgrading = false;
        if (this._qualities.length > 0) {
            const preferred = this._quality;
            const initialQ = this._qualities.includes(preferred) ? preferred
                : this._qualities.includes('medium') ? 'medium'
                : this._qualities[this._qualities.length - 1];
            this._actualQuality = initialQ;
            await this._loadQualitySegments(initialQ);
        } else {
            this._actualQuality = 'medium';
        }
        if (this.onQualityChange) this.onQualityChange(this._actualQuality, false);
        if (this.segments.length > 0) await this.preloadSegments(0, 1);
        if (this.segments.length > 1) this.preloadSegments(1, 4);
    }

    async _loadQualitySegments(quality) {
        if (!this._audioID || !this._ownerID) return;
        try {
            const res = await fetch(`/api/library/files/${this._audioID}/segments/${quality}/`, {credentials:'include'});
            if (!res.ok) return;
            const data = await res.json();
            this.segments = data.segments || [];
            this.segmentTime = data.segment_time || 5;
            this.duration = data.duration || this.duration;
            if (data.owner_id) this._ownerID = data.owner_id;
            if (data.audio_uuid) this._audioUUID = data.audio_uuid;
        } catch (e) { console.error('loadQualitySegments:', e); }
    }

    async setQuality(quality) {
        this._quality = quality;
        localStorage.setItem('lt_quality', quality);
        if (quality === this._actualQuality && this.segments.length > 0) return;
        await this._upgradeQuality(quality);
    }
    getQuality() { return this._quality; }
    getActualQuality() { return this._actualQuality; }
    getQualities() { return this._qualities; }

    async _upgradeQuality(targetQuality) {
        if (this._upgrading) return;
        if (targetQuality === this._actualQuality) return;
        if (!this._audioID || !this._ownerID) return;
        this._upgrading = true;
        if (this.onQualityChange) this.onQualityChange(this._actualQuality, true);
        try {
            const res = await fetch(`/api/library/files/${this._audioID}/segments/${targetQuality}/`, {credentials:'include'});
            if (!res.ok) throw new Error('upgrade segments fetch failed: ' + res.status);
            const data = await res.json();
            const newSegments = data.segments || [];
            const newSegTime = data.segment_time || this.segmentTime;
            const newAudioUUID = data.audio_uuid || this._audioUUID;
            if (!newSegments.length) throw new Error('no segments for target quality');
            const newBuffers = new Map();
            for (let i = 0; i < newSegments.length; i++) {
                if (!this._upgrading) return;
                const url = `/api/library/segments/${this._ownerID}/${newAudioUUID}/${targetQuality}/${newSegments[i]}`;
                let arrayBuf = await window.audioCache.get(url);
                if (!arrayBuf) {
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try {
                            const r = await fetch(url, {credentials:'include'});
                            if (!r.ok) throw new Error(`HTTP ${r.status}`);
                            arrayBuf = await r.arrayBuffer();
                            break;
                        } catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 300)); }
                    }
                    window.audioCache.put(url, arrayBuf.slice(0));
                }
                const buffer = await this.ctx.decodeAudioData(arrayBuf);
                newBuffers.set(i, buffer);
            }
            if (!this._upgrading) return;
            if (this.isPlaying) {
                const curPos = this.getCurrentTime();
                const curSegEnd = (Math.floor(curPos / this.segmentTime) + 1) * this.segmentTime;
                const waitMs = Math.max(0, (curSegEnd - curPos) * 1000);
                if (waitMs > 50) await new Promise(r => setTimeout(r, waitMs));
                if (!this._upgrading || !this.isPlaying) return;
            }
            const resumePos = this.isPlaying ? this.getCurrentTime() : this.lastPosition;
            const wasPlaying = this.isPlaying;
            this.stop();
            this.segments = newSegments;
            this.segmentTime = newSegTime;
            this._audioUUID = newAudioUUID;
            this.buffers = newBuffers;
            this._actualQuality = targetQuality;
            if (data.duration) this.duration = data.duration;
            if (wasPlaying) {
                this.isPlaying = true;
                this.startOffset = resumePos;
                this.startTime = this.ctx.currentTime;
                this._driftCount = 0;
                // Update sync anchors
                this.serverPlayTime = window.clockSync.getServerTime();
                this.serverPlayPosition = resumePos;
                this._startLookahead(resumePos, this.ctx.currentTime);
            }
        } catch (e) { console.error('_upgradeQuality failed:', e);
        } finally { this._upgrading = false; if (this.onQualityChange) this.onQualityChange(this._actualQuality, false); }
    }

    _getSegmentURL(idx) {
        if (this._ownerID && this._audioID)
            return `/api/library/segments/${this._ownerID}/${this._audioUUID}/${this._actualQuality}/${this.segments[idx]}`;
        const base = this._trackSegBase || `/api/segments/${this.roomCode}/`;
        return base + this.segments[idx];
    }

    async preloadSegments(startIdx, count) {
        const end = Math.min(startIdx + count, this.segments.length);
        const promises = [];
        for (let i = startIdx; i < end; i++) { if (!this.buffers.has(i)) promises.push(this.loadSegment(i)); }
        await Promise.all(promises);
    }

    async loadSegment(idx) {
        if (this.buffers.has(idx)) return this.buffers.get(idx);
        const url = this._getSegmentURL(idx);
        let data = await window.audioCache.get(url);
        if (!data) {
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const res = await fetch(url, {credentials:'include'});
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    data = await res.arrayBuffer(); break;
                } catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 300)); }
            }
            window.audioCache.put(url, data.slice(0));
        }
        const buffer = await this.ctx.decodeAudioData(data);
        // Trim FLAC block-alignment padding: ensure each segment is exactly segmentTime
        const isLast = (idx === this.segments.length - 1);
        const expectedSamples = Math.round(this.segmentTime * buffer.sampleRate);
        if (!isLast && buffer.length > expectedSamples) {
            const trimmed = this.ctx.createBuffer(buffer.numberOfChannels, expectedSamples, buffer.sampleRate);
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
                trimmed.getChannelData(ch).set(buffer.getChannelData(ch).subarray(0, expectedSamples));
            }
            this.buffers.set(idx, trimmed);
            return trimmed;
        }
        this.buffers.set(idx, buffer);
        return buffer;
    }

    // === Core: playAtPosition ===
    async playAtPosition(position, serverTime, scheduledAt) {
        this.init();

        // C2: Preload target segments BEFORE stopping current playback
        // preloadSegments only fills this.buffers Map, doesn't affect playing sources
        const prePosition = position || 0;
        const segIdx = Math.floor(prePosition / this.segmentTime);
        if (!this.buffers.has(segIdx)) {
            if (this.onBuffering) this.onBuffering(true);
            await this.preloadSegments(segIdx, 2);
            if (this.onBuffering) this.onBuffering(false);
        }

        // Now stop old playback (segments already cached)
        this.stop();
        this.isPlaying = true;
        this._driftCount = 0;

        // Wait for ClockSync to have at least 3 samples (max 800ms wait)
        if (!window.clockSync.synced) {
            const syncStart = performance.now();
            while (!window.clockSync.synced && performance.now() - syncStart < 800) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (!window.clockSync.synced) console.warn('[sync] clock not synced, proceeding anyway');
        }

        this.serverPlayTime = scheduledAt || serverTime || window.clockSync.getServerTime();
        this.serverPlayPosition = position || 0;

        // Capture ctx↔wall clock relationship ONCE before any async work
        // Use both performance.now() and Date.now() at the same instant to avoid clock domain mixing
        const ctxSnap = this.ctx.currentTime;
        const perfSnap = performance.now();
        const dateSnap = Date.now();
        const latency = this._outputLatency || 0; // hardware output latency in seconds

        // Segments already preloaded above (before stop), no need to preload again
        if (!this.isPlaying) return;

        // Convert elapsed perf time to ctx time (single clock domain, no Date.now mixing)
        const ctxNow = ctxSnap + (performance.now() - perfSnap) / 1000;

        // Try hardware-level scheduling if scheduledAt is still in the future
        if (scheduledAt) {
            // Use dateSnap (captured at same instant as perfSnap) to stay in one clock domain
            const localScheduled = scheduledAt - window.clockSync.offset;
            const waitMs = localScheduled - dateSnap - (performance.now() - perfSnap);
            if (waitMs > 2 && waitMs < 3000) {
                // Schedule segment earlier by outputLatency so sound reaches ears on time
                // But keep startTime as the logical anchor (without latency offset)
                // so getCurrentTime() position tracking stays correct
                const ctxTarget = ctxNow + waitMs / 1000;
                const scheduleTarget = ctxTarget - latency;
                this.startOffset = this.serverPlayPosition;
                this.startTime = ctxTarget; // logical anchor, no latency bias
                this._startLookahead(this.serverPlayPosition, scheduleTarget);
                console.log(`[sync] scheduled play: wait=${waitMs.toFixed(0)}ms, outputLatency=${(latency*1000).toFixed(1)}ms`);
                return;
            }
        }
        // Fallback: calculate how much time has passed since scheduledAt/serverTime
        const now = window.clockSync.getServerTime();
        const elapsed = Math.max(0, (now - this.serverPlayTime) / 1000);
        const actualPos = this.serverPlayPosition + elapsed;
        this.startOffset = actualPos;
        // Schedule earlier by outputLatency, but keep startTime as logical anchor
        this.startTime = ctxNow; // logical anchor, no latency bias
        // Ensure schedule target is not in the past
        const schedFallback = Math.max(ctxNow - latency, this.ctx.currentTime);
        this._startLookahead(actualPos, schedFallback);
    }

    // === Lookahead Scheduler ===
    // Instead of scheduling all segments at once, schedule 2-3 ahead
    // and use setInterval to keep feeding the queue.
    // Drift correction adjusts _nextSegTime for the NEXT segment — zero glitch.
    _startLookahead(position, ctxStartTime) {
        this._stopLookahead();
        const segIdx = Math.floor(position / this.segmentTime);
        const segOffset = position % this.segmentTime;
        this._nextSegIdx = segIdx;
        this._nextSegTime = ctxStartTime;
        this._firstSegOffset = segOffset;
        this._isFirstSeg = true;
        // Schedule first 2 segments immediately
        this._scheduleAhead();
        // Then check every 200ms to keep the queue fed
        this._lookaheadTimer = setInterval(() => this._scheduleAhead(), 200);
    }

    _stopLookahead() {
        if (this._lookaheadTimer) { clearInterval(this._lookaheadTimer); this._lookaheadTimer = null; }
    }

    async _scheduleAhead() {
        if (!this.isPlaying || this._scheduling) return;
        this._scheduling = true;
        try {
        const LOOKAHEAD = this._actualQuality === 'lossless' ? 3.0 : 1.5;
        const preloadCount = 3;
        while (this._nextSegIdx < this.segments.length &&
               this._nextSegTime < this.ctx.currentTime + LOOKAHEAD) {
            const i = this._nextSegIdx;
            if (!this.buffers.has(i)) {
                if (this.onBuffering) this.onBuffering(true);
                await this.loadSegment(i);
                if (this.onBuffering) this.onBuffering(false);
                if (!this.isPlaying) return;
            }
            const buffer = this.buffers.get(i);
            if (!buffer) break;
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            const segGain = this.ctx.createGain();
            segGain.connect(this.gainNode);
            source.connect(segGain);
            const off = this._isFirstSeg ? this._firstSegOffset : 0;
            const dur = buffer.duration - off;
            const t = this._nextSegTime;
            // D1: Segment boundary micro-adjustment for small persistent drift
            // Only apply to non-first segments; correct 50% of drift per segment to avoid overshoot
            let schedTime = t;
            if (!this._isFirstSeg && i > 0) {
                const ld = this._lastDrift;
                if (Math.abs(ld) > 0.03 && Math.abs(ld) < this._DRIFT_THRESHOLD) {
                    schedTime = t - ld * 0.5; // ahead→delay, behind→advance
                }
            }
            // Crossfade: 3ms fade-in at start, 3ms fade-out at end to eliminate clicks
            const fadeTime = 0.003;
            if (!this._isFirstSeg && i > 0) {
                segGain.gain.setValueAtTime(0, schedTime);
                segGain.gain.linearRampToValueAtTime(1, schedTime + fadeTime);
            }
            if (i < this.segments.length - 1) {
                const fadeOutStart = schedTime + dur - fadeTime;
                segGain.gain.setValueAtTime(1, fadeOutStart);
                segGain.gain.linearRampToValueAtTime(0, schedTime + dur);
            }
            source.start(schedTime, off);
            source.onended = () => {
                const idx = this.sources.indexOf(source);
                if (idx > -1) this.sources.splice(idx, 1);
            };
            this.sources.push(source);
            this._nextSegTime = t + dur;
            this._nextSegIdx = i + 1;
            this._isFirstSeg = false;
            if (i + 1 < this.segments.length) this.preloadSegments(i + 1, preloadCount);
        }
        } finally { this._scheduling = false; }
    }

    stop() {
        if (this.isPlaying) this.lastPosition = this.getCurrentTime();
        this.isPlaying = false;
        this._stopLookahead();
        this._upgrading = false;
        this._scheduling = false;
        this._driftCount = 0;
        // Fade out to avoid click/pop, then stop sources
        if (this.gainNode && this.ctx) {
            const now = this.ctx.currentTime;
            this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
            this.gainNode.gain.linearRampToValueAtTime(0, now + 0.005);
        }
        const oldSources = this.sources;
        this.sources = [];
        setTimeout(() => {
            oldSources.forEach(s => { try { s.stop(); s.disconnect(); } catch {} });
            if (this.gainNode) this.gainNode.gain.value = 1.0;
        }, 10);
    }

    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.lastPosition || this.startOffset || 0;
        const elapsed = this.ctx.currentTime - this.startTime;
        let pos = this.startOffset + Math.max(0, elapsed);
        if (this.duration > 0 && pos > this.duration) pos = this.duration;
        return pos;
    }

    setVolume(v) { if (this.gainNode) this.gainNode.gain.value = v; }
}

window.audioPlayer = new AudioPlayer();
