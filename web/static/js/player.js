// AudioPlayer - Snapcast-style worklet-based playback
// Phase 3 refactored version

class AudioPlayer {
    constructor() {
        // Core audio state
        this.ctx = null;
        this.gainNode = null;
        this.segments = [];
        this.buffers = new Map();
        this.isPlaying = false;
        this.duration = 0;
        this.segmentTime = 5;
        this.roomCode = '';
        this.lastPosition = 0;
        
        // Quality management
        this._quality = localStorage.getItem('lt_quality') || 'medium';
        this._actualQuality = 'medium';
        this._upgrading = false;
        this._qualities = [];
        this._ownerID = null;
        this._audioID = null;
        this._audioUUID = null;
        this.onQualityChange = null;
        this.onBuffering = null;
        
        // Worklet state
        this.workletNode = null;
        this._sharedBuffer = null;
        this._sharedView = null;
        this._sabSupported = typeof SharedArrayBuffer !== 'undefined';
        
        // Snapcast sync state
        this._anchorPos = 0;
        this._anchorServerTime = 0;
        this._nominalRate = 48000;
        this._maxCorrectionRate = 0.0005; // ±0.05%
        this._workletConsumed = 0;
        this._workletBuffered = 0;
        
        // Timers
        this._feedTimer = null;
        this._driftTimer = null;
        
        // Output latency
        this._outputLatency = 0;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.gainNode = this.ctx.createGain();
            this.gainNode.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        this._outputLatency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
        console.log(`[sync] outputLatency: ${(this._outputLatency*1000).toFixed(1)}ms`);
    }

    // === Audio Loading ===
    
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
        if (this.segments.length > 0) await this.preloadSegments(0, 2);
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
            
            // Preload buffers
            const newBuffers = new Map();
            for (let i = 0; i < newSegments.length && this._upgrading; i++) {
                const url = `/api/library/segments/${this._ownerID}/${newAudioUUID}/${targetQuality}/${newSegments[i]}`;
                let arrayBuf = await window.audioCache.get(url);
                if (!arrayBuf) {
                    const r = await fetch(url, {credentials:'include'});
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    arrayBuf = await r.arrayBuffer();
                    window.audioCache.put(url, arrayBuf.slice(0));
                }
                const buffer = await this.ctx.decodeAudioData(arrayBuf);
                newBuffers.set(i, buffer);
            }
            
            if (!this._upgrading) return;
            
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
                await this.playAtPosition(resumePos);
            }
        } catch (e) {
            console.error('_upgradeQuality failed:', e);
        } finally {
            this._upgrading = false;
            if (this.onQualityChange) this.onQualityChange(this._actualQuality, false);
        }
    }

    _getSegmentURL(idx) {
        if (this._ownerID && this._audioID)
            return `/api/library/segments/${this._ownerID}/${this._audioUUID}/${this._actualQuality}/${this.segments[idx]}`;
        return `/api/segments/${this.roomCode}/${this.segments[idx]}`;
    }

    async preloadSegments(startIdx, count) {
        const end = Math.min(startIdx + count, this.segments.length);
        const promises = [];
        for (let i = startIdx; i < end; i++) {
            if (!this.buffers.has(i)) promises.push(this.loadSegment(i));
        }
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
                    data = await res.arrayBuffer();
                    break;
                } catch (e) {
                    if (attempt === 2) throw e;
                    await new Promise(r => setTimeout(r, 300));
                }
            }
            window.audioCache.put(url, data.slice(0));
        }
        const buffer = await this.ctx.decodeAudioData(data);
        
        // Trim FLAC padding
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

    // === Worklet Management ===
    
    async _createWorkletNode() {
        if (this.workletNode) return;
        
        await this.ctx.audioWorklet.addModule('/js/worklet-processor.js');
        this.workletNode = new AudioWorkletNode(this.ctx, 'listen-together-processor', {
            outputChannelCount: [2]
        });
        this.workletNode.connect(this.gainNode);
        
        // Listen for stats
        this.workletNode.port.onmessage = (e) => {
            if (e.data.type === 'stats') {
                this._workletConsumed = e.data.totalConsumedFrames;
                this._workletBuffered = e.data.buffered;
            }
        };
        
        console.log('[sync] worklet node created');
    }

    _initSharedBuffer() {
        if (!this._sabSupported || this._sharedBuffer) return;
        
        try {
            this._sharedBuffer = new SharedArrayBuffer(8);
            this._sharedView = new BigInt64Array(this._sharedBuffer);
            if (this.workletNode) {
                this.workletNode.port.postMessage({
                    type: 'init-shared',
                    buffer: this._sharedBuffer
                });
            }
            console.log('[sync] SharedArrayBuffer initialized');
        } catch (e) {
            console.warn('[sync] SharedArrayBuffer init failed:', e);
            this._sabSupported = false;
        }
    }

    // === PCM Feed ===
    
    async _feedPCMSegments(startPos) {
        if (!this.workletNode) return;
        
        const startSeg = Math.floor(startPos / this.segmentTime);
        const preloadCount = 5; // Preload 5 segments at a time
        
        for (let i = startSeg; i < Math.min(startSeg + preloadCount, this.segments.length); i++) {
            if (!this.buffers.has(i)) {
                if (this.onBuffering) this.onBuffering(true);
                await this.loadSegment(i);
                if (this.onBuffering) this.onBuffering(false);
            }
            
            const buffer = this.buffers.get(i);
            if (!buffer) continue;
            
            // Extract PCM data - create copies for transfer
            const leftData = buffer.getChannelData(0);
            const rightData = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : leftData;
            
            // Create new arrays for transfer (don't detach cached buffer)
            const left = new Float32Array(leftData);
            const right = new Float32Array(rightData);
            
            // Send to worklet with transfer
            this.workletNode.port.postMessage({
                type: 'pcm',
                left: left.buffer,
                right: right.buffer
            }, [left.buffer, right.buffer]);
        }
    }

    _feedLoop() {
        if (!this.isPlaying) return;
        
        const currentPos = this.getCurrentTime();
        const bufferedSec = this._workletBuffered / this._nominalRate;
        
        // Keep 3-5 seconds of buffer
        if (bufferedSec < 3 && this._workletBuffered < this._nominalRate * 10) {
            const currentSeg = Math.floor(currentPos / this.segmentTime);
            this._feedPCMSegments(currentSeg * this.segmentTime);
        }
    }

    // === Core Playback ===
    
    async playAtPosition(position, serverTime, scheduledAt) {
        this.init();
        this.stop();
        this.isPlaying = true;
        
        // Create worklet if needed
        await this._createWorkletNode();
        
        // Initialize SharedArrayBuffer
        this._initSharedBuffer();
        
        // Reset shared counter
        if (this._sharedView) {
            Atomics.store(this._sharedView, 0, 0n);
        }
        
        // Wait for clock sync
        if (!window.clockSync.synced) {
            const syncStart = performance.now();
            while (!window.clockSync.synced && performance.now() - syncStart < 800) {
                await new Promise(r => setTimeout(r, 50));
            }
        }
        
        // Set Snapcast anchor
        this._anchorPos = position || 0;
        this._anchorServerTime = serverTime || window.clockSync.getServerTime();
        
        // Clear worklet buffer
        this.workletNode.port.postMessage({ type: 'clear' });
        this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
        
        // Start feeding PCM
        await this._feedPCMSegments(this._anchorPos);
        
        // Start feed loop
        this._feedTimer = setInterval(() => this._feedLoop(), 200);
        
        // Start drift loop
        this._driftTimer = setInterval(() => this._driftLoop(), 250);
        
        console.log(`[sync] playAtPosition: pos=${this._anchorPos.toFixed(2)}s, anchor=${this._anchorServerTime}`);
    }

    // === Position Tracking ===
    
    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.lastPosition || 0;
        
        // Read consumed frames from SharedArrayBuffer (zero latency)
        let consumed;
        if (this._sabSupported && this._sharedView) {
            consumed = Number(Atomics.load(this._sharedView, 0));
        } else {
            // Fallback: use postMessage stats (higher latency)
            consumed = this._workletConsumed || 0;
        }
        
        // Snapcast formula: position = anchorPos + consumed / sampleRate
        const pos = this._anchorPos + consumed / this._nominalRate;
        
        // Clamp to duration
        if (this.duration > 0 && pos > this.duration) return this.duration;
        return pos;
    }

    // === Drift Detection & Correction ===
    
    _driftLoop() {
        if (!this.isPlaying || !this._anchorServerTime) return;
        
        const serverNow = window.clockSync.getServerTime();
        const elapsedSec = (serverNow - this._anchorServerTime) / 1000;
        const expectedPos = this._anchorPos + elapsedSec;
        const actualPos = this.getCurrentTime();
        const driftSec = actualPos - expectedPos;
        const driftSamples = driftSec * this._nominalRate;
        
        // Debug display
        const driftEl = document.getElementById('driftStatus');
        if (driftEl) {
            driftEl.textContent = `Drift: ${(driftSec*1000).toFixed(1)}ms`;
        }
        
        const absDrift = Math.abs(driftSec);
        
        // Tier 3: Hard resync (>100ms)
        if (absDrift > 0.1) {
            console.warn(`[sync] hard resync: drift=${(driftSec*1000).toFixed(0)}ms`);
            // Reset anchor
            this._anchorPos = expectedPos;
            this._anchorServerTime = serverNow;
            if (this._sharedView) {
                Atomics.store(this._sharedView, 0, 0n);
            }
            this.workletNode?.port.postMessage({ type: 'clear' });
            this.workletNode?.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
            this._feedPCMSegments(expectedPos);
            return;
        }
        
        // Soft Correction (±0.05% max)
        if (absDrift > 0.001) { // > 1ms
            const correctionTimeSec = 5; // Correct over 5 seconds
            const samplesPerSec = driftSamples / correctionTimeSec;
            
            // Clamp to max rate
            const maxRate = this._nominalRate * this._maxCorrectionRate;
            const clampedRate = Math.max(-maxRate, Math.min(maxRate, samplesPerSec));
            
            if (Math.abs(clampedRate) < 0.5) {
                // Drift too small
                this.workletNode?.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
            } else {
                // Calculate correction interval
                const corrX = Math.round(this._nominalRate / Math.abs(clampedRate));
                // drift > 0 → ahead → slow down → duplicate frames → negative
                // drift < 0 → behind → speed up → drop frames → positive
                const sign = driftSec > 0 ? -1 : 1;
                
                this.workletNode?.port.postMessage({
                    type: 'correction',
                    correctAfterXFrames: sign * corrX
                });
            }
        } else {
            this.workletNode?.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
        }
    }

    // === Control ===
    
    stop() {
        if (this.isPlaying) this.lastPosition = this.getCurrentTime();
        this.isPlaying = false;
        
        // Clear timers
        if (this._feedTimer) { clearInterval(this._feedTimer); this._feedTimer = null; }
        if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }
        
        // Clear worklet
        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'clear' });
            this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
        }
        
        this._upgrading = false;
    }

    setVolume(v) {
        if (this.gainNode) this.gainNode.gain.value = v;
    }
}

window.audioPlayer = new AudioPlayer();