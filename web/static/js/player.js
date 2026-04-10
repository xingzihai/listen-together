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
        this._anchorConsumedBase = 0; // Baseline consumed when anchor is set
        this._nominalRate = 48000; // Will be updated from actual AudioContext
        this._maxCorrectionRate = 0.0005; // ±0.05%
        this._workletConsumed = 0;
        this._workletBuffered = 0;
        this._anchorSet = false; // Anchor will be set when PCM actually starts
        
        // Server anchor (from syncTick)
        this.serverPlayTime = 0;
        this.serverPlayPosition = 0;
        
        // Debug state
        this._debugCounter = 0;
        this._lastDebugLog = 0;
        this._playInProgress = false; // Prevent duplicate playback
        this._lastHardResync = 0; // Hard resync cooldown
        
        // Timers
        this._feedTimer = null;
        this._driftTimer = null;
        
        // Output latency
        this._outputLatency = 0;
        
        // Segment feed tracking (prevent duplicate segment feeds)
        this._fedSegEnd = -1; // Last segment index that was fed to worklet
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.gainNode = this.ctx.createGain();
            this.gainNode.connect(this.ctx.destination);
            // Update nominal rate from actual AudioContext sample rate
            this._nominalRate = this.ctx.sampleRate;
            console.log(`[sync] AudioContext sampleRate: ${this._nominalRate}`);
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
        if (this.segments.length > 0) await this.preloadSegments(0, 4); // Preload first 4 segments
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
        // Always create fresh node - called after stop() which clears old node
        
        await this.ctx.audioWorklet.addModule('/js/worklet-processor.js');
        this.workletNode = new AudioWorkletNode(this.ctx, 'listen-together-processor', {
            outputChannelCount: [2]
        });
        this.workletNode.connect(this.gainNode);
        
        // Listen for stats - set anchor on first playback
        this.workletNode.port.onmessage = (e) => {
            if (e.data.type === 'stats') {
                this._workletConsumed = e.data.totalConsumedFrames;
                this._workletBuffered = e.data.buffered;
                
                // Set anchor when PCM actually starts playing
                if (!this._anchorSet && e.data.totalConsumedFrames > 0) {
                    this._anchorSet = true;
                    this._anchorServerTime = window.clockSync.getServerTime();
                    this._anchorConsumedBase = e.data.totalConsumedFrames; // Record baseline
                } else if (this._anchorSet && this._anchorConsumedBase === 0 && e.data.totalConsumedFrames > 0) {
                    // Hard resync just happened, update baseline
                    this._anchorConsumedBase = e.data.totalConsumedFrames;
                }
            }
        };
        
        console.log('[sync] worklet node created (fresh)');
    }

    _initSharedBuffer() {
        if (!this._sabSupported) return;
        
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
        if (!this.workletNode) {
            return;
        }
        
        const startSeg = Math.floor(startPos / this.segmentTime);
        const preloadCount = 5;
        
        // KEY FIX: Only feed segments after _fedSegEnd to prevent duplicates
        const actualStartSeg = Math.max(startSeg, this._fedSegEnd + 1);
        const endSeg = Math.min(actualStartSeg + preloadCount, this.segments.length);
        
        if (actualStartSeg >= endSeg) {
            // No new segments to feed
            return;
        }
        
        for (let i = actualStartSeg; i < endSeg; i++) {
            const buffer = this.buffers.get(i);
            if (!buffer) {
                // Trigger background load, don't wait
                this._loadSegmentBackground(i);
                continue;
            }
            
            // Extract PCM data - create copies for transfer
            const leftData = buffer.getChannelData(0);
            const rightData = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : leftData;
            
            const left = new Float32Array(leftData);
            const right = new Float32Array(rightData);
            
            this.workletNode.port.postMessage({
                type: 'pcm',
                segIdx: i,  // Add segment index for debugging
                left: left.buffer,
                right: right.buffer
            }, [left.buffer, right.buffer]);
            
            // Update fed segment range
            this._fedSegEnd = Math.max(this._fedSegEnd, i);
        }
        
        console.log(`[feed] fed segments ${actualStartSeg}-${endSeg-1}, _fedSegEnd now ${this._fedSegEnd}`);
    }
    
    // Background segment loading (non-blocking)
    _loadSegmentBackground(idx) {
        if (this.buffers.has(idx)) return;
        if (this._loadingSegments && this._loadingSegments.has(idx)) return;
        
        if (!this._loadingSegments) this._loadingSegments = new Set();
        this._loadingSegments.add(idx);
        
        this.loadSegment(idx).then(() => {
            this._loadingSegments.delete(idx);
        }).catch(e => {
            this._loadingSegments.delete(idx);
        });
    }

    _feedLoop() {
        if (!this.isPlaying) return;
        
        const bufferedSec = this._workletBuffered / this._nominalRate;
        
        // KEY FIX: Calculate buffered end based on fed segments, not current position
        // This ensures we feed the NEXT segments, not re-feed what's already in buffer
        const fedEndPos = (this._fedSegEnd + 1) * this.segmentTime;
        const remainingBufferSec = fedEndPos - this.getCurrentTime();
        
        // Start feeding when remaining buffer < 5 seconds
        if (remainingBufferSec < 5) {
            const nextSeg = this._fedSegEnd + 1;
            
            // Only feed if we haven't reached the end
            if (nextSeg < this.segments.length) {
                this._feedPCMSegments(nextSeg * this.segmentTime);
            }
        }
    }

    // === Core Playback ===
    
    async playAtPosition(position, serverTime, scheduledAt) {
        // Prevent duplicate playback calls
        if (this._playInProgress) {
            console.warn('[sync] playAtPosition already in progress, skipping');
            return;
        }
        this._playInProgress = true;
        
        try {
            this.init();
            this.stop();
            this.isPlaying = true;
            
            // Always create a fresh worklet node for each playback session
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
            
            // Set initial position (anchor will be set when PCM actually starts)
            this._anchorPos = position || 0;
            this._anchorSet = false;
            this._anchorServerTime = 0;
            this._anchorConsumedBase = 0; // Record consumed when anchor is set
            
            // KEY FIX: Reset fed segment tracking before first feed
            const startSeg = Math.floor(this._anchorPos / this.segmentTime);
            this._fedSegEnd = startSeg - 1;  // Will feed from startSeg
            
            // Clear worklet buffer (fresh node, but clear anyway)
            this.workletNode.port.postMessage({ type: 'clear' });
            this.workletNode.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
            
            console.log(`[sync] playAtPosition: pos=${this._anchorPos.toFixed(2)}s, startSeg=${startSeg}, worklet created, waiting for PCM...`);
            
            // Start feeding PCM
            await this._feedPCMSegments(this._anchorPos);
            
            // Start feed loop
            this._feedTimer = setInterval(() => this._feedLoop(), 200);
            
            // Start drift loop
            this._driftTimer = setInterval(() => this._driftLoop(), 250);
        } finally {
            this._playInProgress = false;
        }
    }

    // === Position Tracking ===
    
    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.lastPosition || 0;
        
        // If anchor not set yet, return anchorPos (initial position)
        if (!this._anchorSet) {
            return this._anchorPos || 0;
        }
        
        // Read consumed frames from SharedArrayBuffer (zero latency)
        let consumed;
        if (this._sabSupported && this._sharedView) {
            consumed = Number(Atomics.load(this._sharedView, 0));
        } else {
            // Fallback: use postMessage stats (higher latency)
            consumed = this._workletConsumed || 0;
        }
        
        // Snapcast formula: position = anchorPos + (consumed - base) / sampleRate
        const consumedDelta = consumed - (this._anchorConsumedBase || 0);
        const pos = this._anchorPos + consumedDelta / this._nominalRate;
        
        // Clamp to duration
        if (this.duration > 0 && pos > this.duration) return this.duration;
        return pos;
    }

    // === Drift Detection & Correction ===
    
    _driftLoop() {
        if (!this.isPlaying) return;
        
        // Skip drift calculation if anchor not set yet
        if (!this._anchorSet || !this._anchorServerTime) {
            return;
        }
        
        const serverNow = window.clockSync.getServerTime();
        const elapsedSec = (serverNow - this._anchorServerTime) / 1000;
        const expectedPos = this._anchorPos + elapsedSec;
        
        // Read consumed from SharedArrayBuffer
        let consumed;
        if (this._sabSupported && this._sharedView) {
            consumed = Number(Atomics.load(this._sharedView, 0));
        } else {
            consumed = this._workletConsumed || 0;
        }
        
        // Use delta from anchor baseline
        const consumedDelta = consumed - (this._anchorConsumedBase || 0);
        const actualPos = this._anchorPos + consumedDelta / this._nominalRate;
        const driftSec = actualPos - expectedPos;
        const driftMs = driftSec * 1000;
        
        // Debug output only when drift exceeds threshold
        this._debugCounter++;
        const now = performance.now();
        if (now - this._lastDebugLog > 1000) {
            this._lastDebugLog = now;
            // Only log if drift is abnormal (>50ms)
            if (Math.abs(driftMs) > 50) {
                console.warn(`[sync] ABNORMAL DRIFT: ${driftMs.toFixed(1)}ms`);
            }
        }
        
        // Debug display
        const driftEl = document.getElementById('driftStatus');
        if (driftEl) {
            driftEl.textContent = `Drift: ${driftMs.toFixed(1)}ms`;
        }
        
        const absDrift = Math.abs(driftSec);
        const driftSamples = driftSec * this._nominalRate;
        
        // Tier 3: Hard resync (>500ms) with cooldown
        const HARD_RESYNC_THRESHOLD = 0.5; // 500ms
        const COOLDOWN_MS = 3000; // 3 second cooldown
        
        if (absDrift > HARD_RESYNC_THRESHOLD) {
            // Check cooldown
            const nowMs = performance.now();
            if (this._lastHardResync && nowMs - this._lastHardResync < COOLDOWN_MS) {
                // In cooldown period, skip hard resync
                return;
            }
            
            console.warn(`[sync] HARD_RESYNC: drift=${driftMs.toFixed(0)}ms expected=${expectedPos.toFixed(3)} actual=${actualPos.toFixed(3)}`);
            
            this._lastHardResync = nowMs;
            
            // KEY FIX: Read current consumed and use as new baseline
            // Don't reset to 0! Use actual current value
            let currentConsumed = 0;
            if (this._sabSupported && this._sharedView) {
                currentConsumed = Number(Atomics.load(this._sharedView, 0));
            } else {
                currentConsumed = this._workletConsumed || 0;
            }
            
            // Reset anchor - use current consumed as baseline
            this._anchorPos = expectedPos;
            this._anchorServerTime = serverNow;
            this._anchorSet = true; // Set immediately
            this._anchorConsumedBase = currentConsumed; // KEY: use current value, not 0
            
            // KEY FIX: Reset fed segment tracking for resync position
            const resyncSeg = Math.floor(expectedPos / this.segmentTime);
            this._fedSegEnd = resyncSeg - 1;
            
            // DO NOT reset SharedArrayBuffer - worklet is still running
            // DO NOT send 'clear' - we're just adjusting anchor, not stopping playback
            
            this.workletNode?.port.postMessage({ type: 'correction', correctAfterXFrames: 0 });
            this._feedPCMSegments(expectedPos);
            return;
        }
        
        // Tier 2: Medium correction (100-500ms) - more aggressive soft correction
        if (absDrift > 0.1) {
            const correctionTimeSec = Math.max(2, absDrift * 5); // Faster correction
            const samplesPerSec = driftSamples / correctionTimeSec;
            
            // Allow ±0.2% for medium drift
            const maxRate = this._nominalRate * 0.002;
            const clampedRate = Math.max(-maxRate, Math.min(maxRate, samplesPerSec));
            
            if (Math.abs(clampedRate) >= 0.5) {
                const corrX = Math.round(this._nominalRate / Math.abs(clampedRate));
                const sign = driftSec > 0 ? -1 : 1;
                this.workletNode?.port.postMessage({
                    type: 'correction',
                    correctAfterXFrames: sign * corrX
                });
            }
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

    _sendDebugToServer(data) {
        // Send debug data to server via WebSocket for server-side logging
        if (window.ws && window.ws.readyState === WebSocket.OPEN) {
            try {
                window.ws.send(JSON.stringify({
                    type: 'debug',
                    player: data
                }));
            } catch (e) {
                // Ignore send errors
            }
        }
    }

    // === Control ===
    
    stop() {
        if (this.isPlaying) this.lastPosition = this.getCurrentTime();
        this.isPlaying = false;
        // Note: Do NOT reset _playInProgress here! It's managed by playAtPosition's try-finally
        
        // Clear timers
        if (this._feedTimer) { clearInterval(this._feedTimer); this._feedTimer = null; }
        if (this._driftTimer) { clearInterval(this._driftTimer); this._driftTimer = null; }
        
        // Disconnect and destroy worklet node (critical for proper reset)
        if (this.workletNode) {
            try {
                this.workletNode.port.postMessage({ type: 'clear' });
                this.workletNode.disconnect();
            } catch (e) {}
            this.workletNode = null;
        }
        
        // Reset state
        this._workletConsumed = 0;
        this._workletBuffered = 0;
        this._anchorSet = false;
        this._anchorConsumedBase = 0; // Reset baseline
        this._sharedBuffer = null;
        this._sharedView = null;
        this._fedSegEnd = -1; // Reset segment feed tracking
        
        this._upgrading = false;
    }
    
    // === Server Anchor Correction ===
    
    correctDrift(skipDebounce = false) {
        if (!this.isPlaying || !this._anchorSet) return null;
        
        // If we have server anchor (from syncTick), use it for correction
        if (this.serverPlayTime && this.serverPlayPosition !== undefined) {
            const serverNow = window.clockSync.getServerTime();
            const elapsed = (serverNow - this.serverPlayTime) / 1000;
            const serverExpected = this.serverPlayPosition + elapsed;
            const actualPos = this.getCurrentTime();
            const driftSec = actualPos - serverExpected;
            const driftMs = Math.round(driftSec * 1000);
            
            // Large drift correction (>100ms)
            if (Math.abs(driftMs) > 100) {
                // Update anchor to server position
                this._anchorPos = serverExpected;
                this._anchorServerTime = serverNow;
                this._anchorConsumedBase = this._workletConsumed || 0;
                
                // KEY FIX: Reset fed segment tracking for new position
                const newStartSeg = Math.floor(serverExpected / this.segmentTime);
                this._fedSegEnd = newStartSeg - 1;
                
                // Feed PCM from new position
                this._feedPCMSegments(serverExpected);
                
                console.log(`[sync] correctDrift: corrected ${driftMs}ms to pos=${serverExpected.toFixed(2)}s, reset _fedSegEnd to ${this._fedSegEnd}`);
                return driftMs;
            }
        }
        
        return null;
    }

    setVolume(v) {
        if (this.gainNode) this.gainNode.gain.value = v;
    }
}

window.audioPlayer = new AudioPlayer();