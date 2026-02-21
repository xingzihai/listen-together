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
        this._driftOffset = 0;      // accumulated soft drift correction (seconds)
        this._pendingDriftCorrection = 0; // pending correction waiting for segment schedule
        this._softCorrectionTotal = 0; // total soft correction for UI display (seconds)
        this._lastResync = 0;
        this._resyncGen = 0;        // generation counter: incremented on each playAtPosition
        // playbackRate correction state
        this._rateCorrectingUntil = 0; // ctx.currentTime when rate correction ends
        this._rateCorrectionTimer = null;
        this._currentPlaybackRate = 1.0; // current playbackRate for new sources
        this._rateStartTime = 0;      // ctx.currentTime when rate correction started
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
                this._driftOffset = 0;
                this._pendingDriftCorrection = 0;
                // Update sync anchors so correctDrift doesn't see a false jump
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
        this.init(); this.stop();
        this.isPlaying = true;
        this._driftOffset = 0;
        this._softCorrectionTotal = 0;
        this._pendingDriftCorrection = 0;
        this._resyncGen++;
        this._rateStartTime = 0;

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

        const segIdx = Math.floor(this.serverPlayPosition / this.segmentTime);
        if (!this.buffers.has(segIdx)) {
            if (this.onBuffering) this.onBuffering(true);
            await this.preloadSegments(segIdx, 2);
            if (this.onBuffering) this.onBuffering(false);
        }
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
        // Check if rate correction period has ended (backup for setTimeout throttling)
        if (this._currentPlaybackRate !== 1.0 && this._rateCorrectingUntil && this.ctx.currentTime >= this._rateCorrectingUntil) {
            const actualRateTime = this.ctx.currentTime - this._rateStartTime;
            const extraPlayed = actualRateTime * (this._currentPlaybackRate - 1.0);
            this.startOffset += extraPlayed;
            this._currentPlaybackRate = 1.0;
            this._rateStartTime = 0;
            this.sources.forEach(source => {
                if (source.playbackRate) source.playbackRate.value = 1.0;
            });
            this._rateCorrectingUntil = 0;
            console.log('[sync] playbackRate restored to 1.0 (via scheduler)');
        }
        const LOOKAHEAD = this._actualQuality === 'lossless' ? 3.0 : 1.5;
        const preloadCount = this._actualQuality === 'lossless' ? 3 : 3;
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
            // Per-segment gain for crossfade at boundaries
            const segGain = this.ctx.createGain();
            segGain.connect(this.gainNode);
            source.connect(segGain);
            const off = this._isFirstSeg ? this._firstSegOffset : 0;
            const dur = buffer.duration - off;
            const t = this._nextSegTime;
            const effectiveRate = (this._currentPlaybackRate && this._currentPlaybackRate !== 1.0) ? this._currentPlaybackRate : 1.0;
            const effectiveDur = dur / effectiveRate;
            if (this._currentPlaybackRate && this._currentPlaybackRate !== 1.0) {
                source.playbackRate.value = this._currentPlaybackRate;
            }
            // Crossfade: 3ms fade-in at start, 3ms fade-out at end to eliminate clicks
            const fadeTime = 0.003;
            if (!this._isFirstSeg && i > 0) {
                segGain.gain.setValueAtTime(0, t);
                segGain.gain.linearRampToValueAtTime(1, t + fadeTime);
            }
            if (i < this.segments.length - 1) {
                const fadeOutStart = t + effectiveDur - fadeTime;
                segGain.gain.setValueAtTime(1, fadeOutStart);
                segGain.gain.linearRampToValueAtTime(0, t + effectiveDur);
            }
            source.start(t, off);
            // Transfer pending drift correction now that the corrected segment is actually scheduled
            if (this._pendingDriftCorrection) {
                this._driftOffset += this._pendingDriftCorrection;
                this._pendingDriftCorrection = 0;
            }
            // Clean up ended sources
            source.onended = () => {
                const idx = this.sources.indexOf(source);
                if (idx > -1) this.sources.splice(idx, 1);
            };
            this.sources.push(source);
            this._nextSegTime = t + effectiveDur;
            this._nextSegIdx = i + 1;
            this._isFirstSeg = false;
            // Preload upcoming segments
            if (i + 1 < this.segments.length) this.preloadSegments(i + 1, preloadCount);
        }
        } finally { this._scheduling = false; }
    }

    // === Drift Correction ===
    // Three-tier correction: soft (15-50ms), playbackRate (50-300ms), hard (>300ms)
    correctDrift(skipDebounce) {
        if (!this.isPlaying || !this.serverPlayTime || this._resyncing) return 0;
        // Skip correction during playbackRate adjustment
        if (this._rateCorrectingUntil && this.ctx.currentTime < this._rateCorrectingUntil) return 0;
        // Check if rate correction period has ended (backup recovery)
        if (this._currentPlaybackRate !== 1.0 && this._rateCorrectingUntil && this.ctx.currentTime >= this._rateCorrectingUntil) {
            const actualRateTime = this.ctx.currentTime - this._rateStartTime;
            const extraPlayed = actualRateTime * (this._currentPlaybackRate - 1.0);
            this.startOffset += extraPlayed;
            this._currentPlaybackRate = 1.0;
            this._rateStartTime = 0;
            this.sources.forEach(source => {
                if (source.playbackRate) source.playbackRate.value = 1.0;
            });
            this._rateCorrectingUntil = 0;
            console.log('[sync] playbackRate restored to 1.0 (via correctDrift)');
        }

        // Debounce: max 10 corrections per second (skip for syncTick with fresh anchor)
        const now = performance.now();
        if (!skipDebounce && this._lastCorrectionTime && now - this._lastCorrectionTime < 100) return 0;
        this._lastCorrectionTime = now;

        const serverNow = window.clockSync.getServerTime();
        const expectedPos = this.serverPlayPosition + (serverNow - this.serverPlayTime) / 1000;
        // Use getCurrentTime() which includes _driftOffset compensation
        // This way, once a soft correction is applied and takes effect at the next segment,
        // the drift measurement will reflect the correction
        const actualPos = this.getCurrentTime();
        const drift = actualPos - expectedPos;
        // Debug display
        const driftEl = document.getElementById('driftStatus');
        if (driftEl) {
            const ctxElapsed = (this.ctx.currentTime - this.startTime).toFixed(3);
            const driftAcc = (this._driftOffset * 1000).toFixed(1);
            driftEl.textContent = `Drift: ${(drift*1000).toFixed(1)}ms | accum: ${driftAcc}ms`;
            // Detailed debug panel
            const dbg = document.getElementById('syncDebug');
            if (dbg) {
                const ctxEl = (this.ctx.currentTime - this.startTime).toFixed(3);
                const svrEl = ((serverNow - this.serverPlayTime) / 1000).toFixed(3);
                const elapsed_ = this.ctx.currentTime - this.startTime;
                const rawP = (this.startOffset + Math.max(0, elapsed_)).toFixed(3);
                const expP = expectedPos.toFixed(3);
                const curP = this.getCurrentTime().toFixed(3);
                const segI = this._nextSegIdx;
                const nst = (this._nextSegTime - this.ctx.currentTime).toFixed(3);
                const rate = this._currentPlaybackRate || 1.0;
                const lat = ((this._outputLatency||0)*1000).toFixed(0);
                const off = window.clockSync.offset.toFixed(1);
                const rtt = window.clockSync.rtt.toFixed(0);
                const sam = window.clockSync.samples.length;
                const syn = window.clockSync.synced ? 'Y' : 'N';
                dbg.textContent = [
                    `CLK offset:${off}ms rtt:${rtt}ms samples:${sam} synced:${syn}`,
                    `POS raw:${rawP} exp:${expP} cur:${curP} svrElapsed:${svrEl}s ctxElapsed:${ctxEl}s`,
                    `SEG idx:${segI} nextIn:${nst}s rate:${rate} driftOff:${driftAcc}ms lat:${lat}ms`,
                ].join('\n');
            }
        }
        const absDrift = Math.abs(drift);

        // Tier 1: Soft correction (5-50ms) — adjust _nextSegTime only, don't touch startTime
        if (absDrift > 0.005 && absDrift <= 0.05) {
            // Cap accumulated drift correction at ±500ms; beyond that, force hard resync
            if (Math.abs(this._driftOffset + drift) > 0.5) {
                console.warn(`[sync] soft correction capped: accumulated ${(this._driftOffset*1000).toFixed(0)}ms, forcing hard resync`);
                // 直接执行硬重置，不依赖 fall-through
                this._driftOffset = 0;
                if (!this._resyncing) {
                    this._resyncing = true;
                    this.playAtPosition(this.serverPlayPosition, this.serverPlayTime)
                        .finally(() => { this._resyncing = false; });
                }
                return Math.round(drift * 1000);
            }
            // drift>0 means ahead (too fast) → push _nextSegTime later to slow down
            // drift<0 means behind (too slow) → pull _nextSegTime earlier to speed up
            // Skip if there's already a pending correction in the same direction (avoid repeat-counting)
            if (Math.abs(this._pendingDriftCorrection) > 0.003 && Math.sign(this._pendingDriftCorrection) === Math.sign(drift)) {
                return Math.round(drift * 1000);
            }
            this._nextSegTime += drift;
            // Don't update _driftOffset here — the actual audio hasn't changed yet.
            // _driftOffset is updated in _scheduleAhead when the corrected segment is actually scheduled.
            this._pendingDriftCorrection = (this._pendingDriftCorrection || 0) + drift;
            this._resyncBackoff = 500;
            return Math.round(drift * 1000);
        }

        // Tier 2: playbackRate correction (50-200ms) — gradual catch-up over 1-2 seconds
        // Keep ±2-3% to avoid audible pitch shift (human threshold ~±1-2%)
        if (absDrift > 0.05 && absDrift <= 0.2) {
            // 50-100ms: ±2%, 100-200ms: ±3%
            let rateOffset;
            if (absDrift <= 0.1) rateOffset = 0.02;
            else rateOffset = 0.03;
            // If behind (drift < 0), speed up; if ahead (drift > 0), slow down
            const rate = drift < 0 ? (1 + rateOffset) : (1 - rateOffset);
            const neededCatchUp = absDrift;
            const adjustedDuration = Math.min(5, neededCatchUp / rateOffset);

            console.log(`[sync] playbackRate correction: drift=${(drift*1000).toFixed(0)}ms, rate=${rate}, duration=${adjustedDuration.toFixed(1)}s`);

            // Record start time for offset compensation
            this._rateStartTime = this.ctx.currentTime;

            // Set playbackRate on all active AudioBufferSourceNodes
            this._currentPlaybackRate = rate;
            this.sources.forEach(source => {
                if (source.playbackRate) source.playbackRate.value = rate;
            });
            this._rateCorrectingUntil = this.ctx.currentTime + adjustedDuration;

            // Clear any existing timer (keep for cleanup, but recovery is via scheduler)
            if (this._rateCorrectionTimer) clearTimeout(this._rateCorrectionTimer);
            this._rateCorrectionTimer = null;

            this._resyncBackoff = 500;
            return Math.round(drift * 1000);
        }

        // Tier 3: Hard resync (>200ms) — stop and restart with minimal backoff
        if (absDrift > 0.2) {
            const backoff = this._resyncBackoff || 500;
            if (this._lastResync && Date.now() - this._lastResync < backoff) return 0;
            console.warn(`[sync] hard resync: drift=${(drift*1000).toFixed(0)}ms, backoff=${backoff}ms`);
            this._lastResync = Date.now();
            this._resyncBackoff = Math.min(backoff * 1.5, 5000);
            if (!this._resyncing) {
                this._resyncing = true;
                this.playAtPosition(this.serverPlayPosition, this.serverPlayTime)
                    .finally(() => { this._resyncing = false; });
            }
            return Math.round(drift * 1000);
        }
        return Math.round(drift * 1000);
    }

    stop() {
        if (this.isPlaying) this.lastPosition = this.getCurrentTime();
        this.isPlaying = false;
        this._stopLookahead();
        this._upgrading = false;
        this._scheduling = false;
        if (this._rateCorrectionTimer) { clearTimeout(this._rateCorrectionTimer); this._rateCorrectionTimer = null; }
        this._rateCorrectingUntil = 0;
        this._currentPlaybackRate = 1.0;
        this._rateStartTime = 0;
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
            // Restore gain for next playback
            if (this.gainNode) this.gainNode.gain.value = 1.0;
        }, 10);
        this._driftOffset = 0;
        this._softCorrectionTotal = 0;
        this._pendingDriftCorrection = 0;
    }

    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.lastPosition || this.startOffset || 0;
        const elapsed = this.ctx.currentTime - this.startTime;
        let pos = this.startOffset + Math.max(0, elapsed);
        // Only reflect consumed drift corrections, not pending ones
        // _pendingDriftCorrection hasn't taken effect in audio scheduling yet
        pos -= this._driftOffset;
        // Compensate for playbackRate during Tier 2 correction
        if (this._currentPlaybackRate && this._currentPlaybackRate !== 1.0 && this._rateStartTime) {
            const rateElapsed = this.ctx.currentTime - this._rateStartTime;
            pos += rateElapsed * (this._currentPlaybackRate - 1.0);
        }
        // Clamp to duration
        if (this.duration > 0 && pos > this.duration) pos = this.duration;
        return pos;
    }

    setVolume(v) { if (this.gainNode) this.gainNode.gain.value = v; }
}

window.audioPlayer = new AudioPlayer();
