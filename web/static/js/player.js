/**
 * ListenTogether AudioPlayer — AudioWorklet + Ring Buffer engine
 * Drift correction ported from Snapcast's sample-level algorithm
 */

class MedianBuffer {
    constructor(size) { this._size = size; this._buf = []; }
    add(v) { this._buf.push(v); if (this._buf.length > this._size) this._buf.shift(); }
    clear() { this._buf.length = 0; }
    full() { return this._buf.length >= this._size; }
    size() { return this._buf.length; }
    median() {
        if (!this._buf.length) return 0;
        const s = [...this._buf].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
}

class AudioPlayer {
    constructor() {
        this.ctx = null; this.gainNode = null; this.workletNode = null;
        this.segments = []; this.buffers = new Map();
        this.isPlaying = false; this.lastPosition = 0; this.duration = 0;
        this.segmentTime = 5; this.roomCode = '';
        this._logBuffer = []; this._logMax = 200;
        this.serverPlayTime = 0; this.serverPlayPosition = 0;
        this.onBuffering = null; this._trackSegBase = null;
        this._quality = localStorage.getItem('lt_quality') || 'medium';
        this._actualQuality = 'medium'; this._upgrading = false;
        this._qualities = []; this._ownerID = null; this._audioID = null;
        this.onQualityChange = null;
        this._workletReady = false;
        this._workletBuffered = 0; this._workletCapacity = 0;
        this._workletTotalPlayed = 0; this._workletConsumed = 0; this._workletSampleRate = 48000;
        this._feederTimer = null; this._feederNextSeg = 0;
        this._feederSegOffset = 0; this._feederGen = 0; this._feederStartPos = 0; this._feeding = false;
        this._fedSinceLastStats = 0;
        this._miniBuffer = new MedianBuffer(40);
        this._shortBuffer = new MedianBuffer(100);
        this._longBuffer = new MedianBuffer(500);
        this._driftTimer = null; this._hardSyncing = false; this._lastHardSync = 0;
        this._playStartedAt = 0; this._fedFrames = 0; this._sampleRate = 0;
        this._ctxTimeAtPlay = 0; // AudioContext.currentTime when play started (same clock as worklet)
        this._prevTailL = null; this._prevTailR = null;
        this._CROSSFADE_FRAMES = 144; // ~3ms@48kHz, set properly after ctx init
    }

    _log(event, data) {
        const entry = { t: Date.now(), ct: this.ctx?.currentTime || 0, event, ...data };
        this._logBuffer.push(entry);
        if (this._logBuffer.length > this._logMax) this._logBuffer.shift();
        console.log(`[audio] ${event}`, data || '');
    }
    dumpLog() { return JSON.stringify(this._logBuffer, null, 2); }
    copyLog() { navigator.clipboard?.writeText(this.dumpLog()); console.log('Log copied'); }
    uploadLog() {
        if (!this._logBuffer.length) return;
        fetch('/api/debug-log', { method: 'POST', headers: {'Content-Type':'application/json'}, body: this.dumpLog() }).catch(() => {});
    }

    async init(sampleRate) {
        if (this.ctx && sampleRate && this.ctx.sampleRate !== sampleRate) {
            this.stop(); this.ctx.close().catch(() => {});
            this.ctx = null; this.gainNode = null; this.workletNode = null; this._workletReady = false;
        }
        if (!this.ctx) {
            const opts = sampleRate ? { sampleRate } : {};
            this.ctx = new (window.AudioContext || window.webkitAudioContext)(opts);
            this.gainNode = this.ctx.createGain();
            this.gainNode.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this._outputLatency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
        this._CROSSFADE_FRAMES = Math.ceil(this.ctx.sampleRate * 0.003); // 3ms
        // Bridge AudioContext to ClockSync for high-precision timing
        if (window.clockSync?.setAudioContext) window.clockSync.setAudioContext(this.ctx);
        if (!this._workletReady) {
            try { await this.ctx.audioWorklet.addModule('/js/worklet-processor.js'); }
            catch (e) { console.warn('[audio] worklet addModule:', e.message); }
            this._createWorkletNode();
            this._workletReady = true;
        }
    }

    _createWorkletNode() {
        if (this.workletNode) { try { this.workletNode.disconnect(); } catch {} }
        this.workletNode = new AudioWorkletNode(this.ctx, 'listen-together-processor', {
            outputChannelCount: [2], numberOfOutputs: 1
        });
        this.workletNode.connect(this.gainNode);
        this.workletNode.port.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'stats') {
                this._workletBuffered = msg.buffered;
                this._workletCapacity = msg.capacity;
                this._workletTotalPlayed = msg.totalPlayedFrames;
                this._workletConsumed = msg.totalConsumedFrames;
                this._workletSampleRate = msg.sampleRate;
                this._fedSinceLastStats = 0;
            } else if (msg.type === 'overflow') {
                this._log('overflow', { dropped: msg.dropped });
            }
        };
    }

    // Normalize segments: accept both ["seg.flac"] and [{filename:"seg.flac", sample_count:N}]
    _normalizeSegments(segs) {
        if (!segs || !segs.length) return [];
        if (typeof segs[0] === 'string') return segs;
        return segs.map(s => s.filename || s);
    }

    async loadAudio(audioInfo, roomCode) {
        this.stop();
        this.segments = this._normalizeSegments(audioInfo.segments);
        this.duration = audioInfo.duration || 0;
        this.segmentTime = audioInfo.segmentTime || 5;
        this.roomCode = roomCode;
        this.buffers.clear();
        this._qualities = audioInfo.qualities || [];
        this._ownerID = audioInfo.ownerID || null;
        this._audioID = audioInfo.audioID || null;
        this._audioUUID = audioInfo.audioUUID || null;
        this._sampleRate = audioInfo.sampleRate || 0;
        this._upgrading = false;
        if (this._qualities.length > 0) {
            const preferred = this._quality;
            const initialQ = this._qualities.includes(preferred) ? preferred
                : this._qualities.includes('medium') ? 'medium' : this._qualities[this._qualities.length - 1];
            this._actualQuality = initialQ;
            await this._loadQualitySegments(initialQ);
        } else { this._actualQuality = 'medium'; }
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
            this.segments = this._normalizeSegments(data.segments); this.segmentTime = data.segment_time || 5;
            this.duration = data.duration || this.duration;
            if (data.sample_rate) this._sampleRate = data.sample_rate;
            if (data.owner_id) this._ownerID = data.owner_id;
            if (data.audio_uuid) this._audioUUID = data.audio_uuid;
        } catch (e) { console.error('loadQualitySegments:', e); }
    }

    async setQuality(quality) {
        this._quality = quality; localStorage.setItem('lt_quality', quality);
        if (quality === this._actualQuality && this.segments.length > 0) return;
        await this._upgradeQuality(quality);
    }
    getQuality() { return this._quality; }
    getActualQuality() { return this._actualQuality; }
    getQualities() { return this._qualities; }

    async _upgradeQuality(targetQuality) {
        if (this._upgrading || targetQuality === this._actualQuality) return;
        if (!this._audioID || !this._ownerID) return;
        this._upgrading = true;
        if (this.onQualityChange) this.onQualityChange(this._actualQuality, true);
        try {
            const res = await fetch(`/api/library/files/${this._audioID}/segments/${targetQuality}/`, {credentials:'include'});
            if (!res.ok) throw new Error('upgrade fetch failed: ' + res.status);
            const data = await res.json();
            const rawSegments = data.segments || [];
            const newSegments = this._normalizeSegments(rawSegments);
            const newSegTime = data.segment_time || this.segmentTime;
            const newAudioUUID = data.audio_uuid || this._audioUUID;
            if (!newSegments.length) throw new Error('no segments');
            const newBuffers = new Map();
            for (let i = 0; i < newSegments.length; i++) {
                if (!this._upgrading) return;
                const url = `/api/library/segments/${this._ownerID}/${newAudioUUID}/${targetQuality}/${newSegments[i]}`;
                let arrayBuf = await window.audioCache.get(url);
                if (!arrayBuf) {
                    for (let attempt = 0; attempt < 3; attempt++) {
                        try { const r = await fetch(url, {credentials:'include'}); if (!r.ok) throw new Error(`HTTP ${r.status}`); arrayBuf = await r.arrayBuffer(); break; }
                        catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 300)); }
                    }
                    window.audioCache.put(url, arrayBuf.slice(0));
                }
                newBuffers.set(i, await this.ctx.decodeAudioData(arrayBuf));
            }
            if (!this._upgrading) return;
            const resumePos = this.isPlaying ? this.getCurrentTime() : this.lastPosition;
            const wasPlaying = this.isPlaying;
            this.stop();
            this.segments = newSegments; this.segmentTime = newSegTime;
            this._audioUUID = newAudioUUID; this.buffers = newBuffers;
            this._actualQuality = targetQuality;
            if (data.duration) this.duration = data.duration;
            if (wasPlaying) await this.playAtPosition(resumePos, this.serverPlayTime);
        } catch (e) { console.error('_upgradeQuality failed:', e);
        } finally { this._upgrading = false; if (this.onQualityChange) this.onQualityChange(this._actualQuality, false); }
    }

    _getSegmentURL(idx) {
        if (this._ownerID && this._audioID)
            return `/api/library/segments/${this._ownerID}/${this._audioUUID}/${this._actualQuality}/${this.segments[idx]}`;
        return (this._trackSegBase || `/api/segments/${this.roomCode}/`) + this.segments[idx];
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
                try { const res = await fetch(url, {credentials:'include'}); if (!res.ok) throw new Error(`HTTP ${res.status}`); data = await res.arrayBuffer(); break; }
                catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 300)); }
            }
            window.audioCache.put(url, data.slice(0));
        }
        const buffer = await this.ctx.decodeAudioData(data);
        this.buffers.set(idx, buffer);
        return buffer;
    }

    async playAtPosition(position, serverTime, scheduledAt) {
        await this.init(this._sampleRate || undefined);
        this.stop();
        this.isPlaying = true;
        this._feederGen++;
        const gen = this._feederGen;
        this.serverPlayTime = scheduledAt || serverTime || window.clockSync.getServerTime();
        this.serverPlayPosition = position || 0;
        this._playStartedAt = performance.now();
        this._miniBuffer.clear(); this._shortBuffer.clear(); this._longBuffer.clear();
        this._log('playAtPosition', { pos: this.serverPlayPosition, scheduledAt, quality: this._actualQuality });

        if (this.workletNode) this.workletNode.port.postMessage({ type: 'clear' });
        this._fedFrames = 0; this._fedSinceLastStats = 0;

        const segIdx = Math.floor(this.serverPlayPosition / this.segmentTime);
        if (!this.buffers.has(segIdx)) {
            if (this.onBuffering) this.onBuffering(true);
            await this.preloadSegments(segIdx, 2);
            if (this.onBuffering) this.onBuffering(false);
        }
        if (!this.isPlaying || gen !== this._feederGen) return;

        let actualPos = this.serverPlayPosition;
        if (scheduledAt) {
            const waitMs = (scheduledAt - window.clockSync.offset) - Date.now();
            if (waitMs > 2 && waitMs < 3000) {
                await new Promise(r => setTimeout(r, waitMs));
                if (!this.isPlaying || gen !== this._feederGen) return;
            }
        }
        // Always recalculate elapsed after any wait
        const elapsed = Math.max(0, (window.clockSync.getServerTime() - this.serverPlayTime) / 1000);
        actualPos = this.serverPlayPosition + elapsed;

        this._feederStartPos = actualPos;
        this._ctxTimeAtPlay = this.ctx.currentTime; // anchor for drift calc (same clock as worklet)
        this._feederNextSeg = Math.floor(actualPos / this.segmentTime);
        this._feederSegOffset = actualPos - this._feederNextSeg * this.segmentTime;

        await this._feedSegments(gen, 1);
        if (!this.isPlaying || gen !== this._feederGen) return;

        this._feederTimer = setInterval(() => this._feedLoop(gen), 100);
        this._driftTimer = setInterval(() => this._driftLoop(), 250);
        this._logUploadTimer = setInterval(() => this.uploadLog(), 30000);
    }

    async _feedSegments(gen, count) {
        for (let i = 0; i < count; i++) {
            if (!this.isPlaying || gen !== this._feederGen) return;
            if (this._feederNextSeg >= this.segments.length) return;
            const sr = this.ctx?.sampleRate || 48000;
            const segFrames = Math.ceil(this.segmentTime * sr);
            // Use known capacity (5s * sampleRate) if worklet hasn't reported yet
            const capacity = this._workletCapacity > 0 ? this._workletCapacity : Math.ceil(sr * 5);
            const buffered = this._workletBuffered + this._fedSinceLastStats;
            if (buffered > capacity - segFrames) return;

            if (!this.buffers.has(this._feederNextSeg)) {
                if (this.onBuffering) this.onBuffering(true);
                await this.loadSegment(this._feederNextSeg);
                if (this.onBuffering) this.onBuffering(false);
                if (!this.isPlaying || gen !== this._feederGen) return;
            }
            const audioBuf = this.buffers.get(this._feederNextSeg);
            if (!audioBuf) return;

            const srcL = audioBuf.getChannelData(0);
            const srcR = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : srcL;
            const offsetFrames = Math.round(this._feederSegOffset * audioBuf.sampleRate);
            this._feederSegOffset = 0;

            // Crossfade with previous segment tail to eliminate Opus pre-skip gaps
            // Instead of trimming tail, we overlap-blend: prev tail fades out, new head fades in
            let sliceL = srcL.slice(offsetFrames);
            let sliceR = srcR.slice(offsetFrames);
            if (this._prevTailL && sliceL.length > 0) {
                const cfLen = Math.min(this._CROSSFADE_FRAMES, this._prevTailL.length, sliceL.length);
                for (let j = 0; j < cfLen; j++) {
                    const t = (j + 1) / (cfLen + 1);
                    sliceL[j] = this._prevTailL[this._prevTailL.length - cfLen + j] * (1 - t) + sliceL[j] * t;
                    sliceR[j] = this._prevTailR[this._prevTailR.length - cfLen + j] * (1 - t) + sliceR[j] * t;
                }
                this._prevTailL = null; this._prevTailR = null;
            }
            // Save tail reference for next segment crossfade (no trimming — send full data)
            if (sliceL.length > this._CROSSFADE_FRAMES) {
                this._prevTailL = sliceL.slice(sliceL.length - this._CROSSFADE_FRAMES);
                this._prevTailR = sliceR.slice(sliceR.length - this._CROSSFADE_FRAMES);
            } else {
                this._prevTailL = null; this._prevTailR = null;
            }
            // Send ALL frames (no tail trimming — eliminates cumulative position drift)
            const sendL = sliceL;
            const sendR = sliceR;
            const len = sendL.length;
            if (len <= 0) { this._feederNextSeg++; continue; }

            // sliceL/sliceR are from Float32Array.slice() — independent ArrayBuffers
            // prevTail was saved via .slice() before this point — also independent
            // Safe to transfer sendL/sendR buffers directly
            const leftBuf = sendL.buffer;
            const rightBuf = sendR.buffer;
            this.workletNode.port.postMessage({ type: 'pcm', left: leftBuf, right: rightBuf }, [leftBuf, rightBuf]);
            this._fedFrames += len;
            this._fedSinceLastStats += len;
            this._feederNextSeg++;
            if (this._feederNextSeg < this.segments.length) this.preloadSegments(this._feederNextSeg, 3);
        }
    }

    async _feedLoop(gen) {
        if (this._feeding || !this.isPlaying || gen !== this._feederGen) return;
        this._feeding = true;
        try { await this._feedSegments(gen, 2); }
        finally { this._feeding = false; }
    }

    _driftLoop() {
        if (!this.isPlaying || !this.serverPlayTime || this._hardSyncing) return;
        if (performance.now() - this._playStartedAt < 3000) return;

        // Use same clock source for both expected and actual position
        // expectedPos: based on AudioContext.currentTime elapsed since play start
        // actualPos: based on workletConsumed (also AudioContext clock)
        const ctxElapsed = this.ctx.currentTime - this._ctxTimeAtPlay;
        const expectedPos = this._feederStartPos + ctxElapsed;
        const actualPos = this.getCurrentTime();
        const ageMs = (actualPos - expectedPos) * 1000;
        const ageUs = ageMs * 1000;

        this._miniBuffer.add(ageUs); this._shortBuffer.add(ageUs); this._longBuffer.add(ageUs);
        const miniMedian = this._miniBuffer.median();
        const shortMedian = this._shortBuffer.median();
        const longMedian = this._longBuffer.median();

        this._updateDebugDisplay(ageMs, miniMedian, shortMedian, longMedian);
        this._log('drift', { d: +ageMs.toFixed(1), mini: +(miniMedian/1000).toFixed(1), short: +(shortMedian/1000).toFixed(1), long: +(longMedian/1000).toFixed(1) });

        // Hard sync thresholds (Snapcast, all in microseconds)
        // longMedian > 2ms(2000us), shortMedian > 5ms(5000us), miniMedian > 50ms(50000us), age > 500ms
        if ((this._longBuffer.full() && Math.abs(longMedian) > 2000 && Math.abs(ageMs) > 5) ||
            (this._shortBuffer.full() && Math.abs(shortMedian) > 5000 && Math.abs(ageMs) > 5) ||
            (this._miniBuffer.full() && Math.abs(miniMedian) > 50000 && Math.abs(ageMs) > 20) ||
            (Math.abs(ageMs) > 500)) {
            this._log('hardSync', { age: +ageMs.toFixed(1) });
            // Cooldown: no hard sync within 3 seconds
            if (performance.now() - this._lastHardSync < 3000) return;
            this._lastHardSync = performance.now();
            this._hardSyncing = true;
            // Use server time for cross-device sync accuracy
            const serverNow = window.clockSync.getServerTime();
            const serverPos = this.serverPlayPosition + (serverNow - this.serverPlayTime) / 1000;
            this.playAtPosition(serverPos, serverNow)
                .finally(() => { this._hardSyncing = false; });
            return;
        }

        // Soft correction (Snapcast setRealSampleRate)
        if (this._shortBuffer.full()) {
            const CORRECTION_BEGIN = 100; // 100us
            const sr = this.ctx.sampleRate;
            let correctAfterXFrames = 0;
            // age>0 = playing too fast → insert frames (negative correctAfterXFrames)
            // age<0 = playing too slow → drop frames (positive correctAfterXFrames)
            if (shortMedian > CORRECTION_BEGIN && miniMedian > 50 && ageUs > 50) {
                // Too fast: slow down by inserting frames
                let rateAdj = Math.min((shortMedian / 100) * 0.00005, 0.005);
                correctAfterXFrames = -Math.round(1 / rateAdj); // negative = insert
            } else if (shortMedian < -CORRECTION_BEGIN && miniMedian < -50 && ageUs < -50) {
                // Too slow: speed up by dropping frames
                let rateAdj = Math.min((-shortMedian / 100) * 0.00005, 0.005);
                correctAfterXFrames = Math.round(1 / rateAdj); // positive = drop
            }
            if (this.workletNode) this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames });
        }
    }

    _updateDebugDisplay(ageMs, miniMedian, shortMedian, longMedian) {
        const driftEl = document.getElementById('driftStatus');
        if (driftEl) {
            const bufMs = Math.round(this._workletBuffered / (this.ctx?.sampleRate || 48000) * 1000);
            driftEl.textContent = `Drift: ${ageMs.toFixed(1)}ms | buf: ${bufMs}ms`;
        }
        const dbg = document.getElementById('syncDebug');
        if (dbg) {
            const bufMs = Math.round(this._workletBuffered / (this.ctx?.sampleRate || 48000) * 1000);
            const capMs = Math.round(this._workletCapacity / (this.ctx?.sampleRate || 48000) * 1000);
            dbg.innerHTML = [
                `CLK offset:${window.clockSync.offset.toFixed(1)}ms rtt:${window.clockSync.rtt.toFixed(0)}ms synced:${window.clockSync.synced?'Y':'N'}`,
                `DRIFT age:${ageMs.toFixed(1)}ms mini:${(miniMedian/1000).toFixed(1)}ms short:${(shortMedian/1000).toFixed(1)}ms long:${(longMedian/1000).toFixed(1)}ms`,
                `BUF ${bufMs}ms/${capMs}ms | fed:${this._feederNextSeg}/${this.segments.length}`,
            ].join('<br>');
        }
    }

    correctDrift() {
        if (!this.isPlaying || !this.serverPlayTime) return 0;
        const expectedPos = this.serverPlayPosition + (window.clockSync.getServerTime() - this.serverPlayTime) / 1000;
        return Math.round((this.getCurrentTime() - expectedPos) * 1000);
    }

    stop() {
        if (this.isPlaying) this.lastPosition = this.getCurrentTime();
        this.isPlaying = false; this._upgrading = false;
        if (this._feederTimer) { clearInterval(this._feederTimer); this._feederTimer = null; }
        if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }
        if (this._logUploadTimer) { clearInterval(this._logUploadTimer); this._logUploadTimer = null; }
        this.uploadLog();
        if (this.workletNode) this.workletNode.port.postMessage({ type: 'clear' });
        this._fedFrames = 0; this._fedSinceLastStats = 0;
        this._miniBuffer.clear(); this._shortBuffer.clear(); this._longBuffer.clear();
    }

    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.lastPosition || 0;
        const sr = this._workletSampleRate || this.ctx.sampleRate || 48000;
        const pos = this._feederStartPos + this._workletConsumed / sr;
        return this.duration > 0 ? Math.min(pos, this.duration) : pos;
    }

    setVolume(v) { if (this.gainNode) this.gainNode.gain.value = v; }
}

window.audioPlayer = new AudioPlayer();
