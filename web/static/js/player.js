class AudioPlayer {
    constructor() {
        this.ctx = null; this.gainNode = null; this.segments = []; this.buffers = new Map();
        this.sources = []; this.isPlaying = false; this.startTime = 0; this.startOffset = 0;
        this.lastPosition = 0; this.duration = 0; this.segmentTime = 5; this.roomCode = '';
        this.serverPlayTime = 0; this.serverPlayPosition = 0;
        this.onBuffering = null;
        this._trackSegBase = null;
        // Multi-quality
        this._quality = localStorage.getItem('lt_quality') || 'medium';
        this._qualities = [];
        this._ownerID = null;
        this._audioID = null;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.gainNode = this.ctx.createGain();
            this.gainNode.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
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

        // Pick best available quality
        if (this._qualities.length > 0) {
            if (!this._qualities.includes(this._quality)) {
                this._quality = this._qualities.includes('medium') ? 'medium' : this._qualities[this._qualities.length - 1];
            }
            // Load segments for chosen quality from library API
            await this._loadQualitySegments(this._quality);
        }

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
        if (quality === this._quality && this.segments.length > 0) return;
        const wasPlaying = this.isPlaying;
        const pos = this.getCurrentTime();
        this._quality = quality;
        localStorage.setItem('lt_quality', quality);
        this.stop();
        this.buffers.clear();
        await this._loadQualitySegments(quality);
        if (wasPlaying && this.segments.length > 0) {
            this.isPlaying = true;
            this.init();
            const segIdx = Math.floor(pos / this.segmentTime);
            await this.preloadSegments(segIdx, 2);
            this.startOffset = pos;
            this.startTime = this.ctx.currentTime;
            this.serverPlayPosition = pos;
            this.serverPlayTime = window.clockSync.getServerTime();
            await this._scheduleFrom(pos);
        }
    }

    getQuality() { return this._quality; }
    getQualities() { return this._qualities; }

    _getSegmentURL(idx) {
        if (this._ownerID && this._audioID) {
            return `/api/library/segments/${this._ownerID}/${this._audioUUID}/${this._quality}/${this.segments[idx]}`;
        }
        const base = this._trackSegBase || `/api/segments/${this.roomCode}/`;
        return base + this.segments[idx];
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
        this.buffers.set(idx, buffer);
        return buffer;
    }

    async playAtPosition(position, serverTime, scheduledAt) {
        this.init(); this.stop();
        this._scheduleAbort = false;
        this.isPlaying = true;
        this.serverPlayTime = scheduledAt || serverTime || window.clockSync.getServerTime();
        this.serverPlayPosition = position || 0;
        const segIdx = Math.floor(this.serverPlayPosition / this.segmentTime);
        if (!this.buffers.has(segIdx)) {
            if (this.onBuffering) this.onBuffering(true);
            await this.preloadSegments(segIdx, 2);
            if (this.onBuffering) this.onBuffering(false);
        }
        if (scheduledAt) {
            const localScheduled = scheduledAt - window.clockSync.offset;
            const waitMs = localScheduled - Date.now();
            if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        }
        if (!this.isPlaying) return;
        const now = window.clockSync.getServerTime();
        const elapsed = Math.max(0, (now - this.serverPlayTime) / 1000);
        const actualPos = this.serverPlayPosition + elapsed;
        this.startOffset = actualPos;
        this.startTime = this.ctx.currentTime;
        await this._scheduleFrom(actualPos);
    }

    async _scheduleFrom(position) {
        const segIdx = Math.floor(position / this.segmentTime);
        const segOffset = position % this.segmentTime;
        if (!this.buffers.has(segIdx)) {
            if (this.onBuffering) this.onBuffering(true);
            await this.preloadSegments(segIdx, 1);
            if (this.onBuffering) this.onBuffering(false);
        }
        let t = this.ctx.currentTime;
        const overlap = 0.005;
        const preloadCount = this._quality === 'lossless' ? 2 : 3;
        for (let i = segIdx; i < this.segments.length; i++) {
            if (!this.isPlaying || this._scheduleAbort) break;
            if (!this.buffers.has(i)) {
                if (this.onBuffering) this.onBuffering(true);
                await this.loadSegment(i);
                if (this.onBuffering) this.onBuffering(false);
            }
            const buffer = this.buffers.get(i);
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            const gain = this.ctx.createGain();
            source.connect(gain);
            gain.connect(this.gainNode);
            const off = (i === segIdx) ? segOffset : 0;
            const dur = buffer.duration - off;
            if (i > segIdx) {
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(1, t + overlap);
            }
            const endTime = t + dur;
            gain.gain.setValueAtTime(1, endTime - overlap);
            gain.gain.linearRampToValueAtTime(0, endTime + overlap);
            source.start(t, off);
            this.sources.push(source);
            t += dur - overlap;
            if (i + 1 < this.segments.length) this.preloadSegments(i + 1, preloadCount);
        }
    }

    correctDrift() {
        if (!this.isPlaying || !this.serverPlayTime) return 0;
        const now = window.clockSync.getServerTime();
        const expectedPos = this.serverPlayPosition + (now - this.serverPlayTime) / 1000;
        const actualPos = this.getCurrentTime();
        const drift = actualPos - expectedPos;
        if (Math.abs(drift) > 0.3) {
            this.playAtPosition(this.serverPlayPosition, this.serverPlayTime);
            return Math.round(drift * 1000);
        } else if (Math.abs(drift) > 0.008) {
            const correction = 1.0 - Math.max(-0.02, Math.min(0.02, drift * 0.5));
            this.sources.forEach(s => { try { s.playbackRate.value = correction; } catch {} });
            const holdMs = Math.min(1000, Math.abs(drift) * 5000);
            clearTimeout(this._rateTimer);
            this._rateTimer = setTimeout(() => {
                this.sources.forEach(s => { try { s.playbackRate.value = 1.0; } catch {} });
            }, holdMs);
            return Math.round(drift * 1000);
        }
        return 0;
    }

    stop() {
        if (this.isPlaying) this.lastPosition = this.getCurrentTime();
        this.isPlaying = false;
        this._scheduleAbort = true;
        this.sources.forEach(s => { try { s.stop(); s.disconnect(); } catch {} });
        this.sources = [];
    }

    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.lastPosition || this.startOffset || 0;
        return this.startOffset + (this.ctx.currentTime - this.startTime);
    }

    setVolume(v) { if (this.gainNode) this.gainNode.gain.value = v; }
}

window.audioPlayer = new AudioPlayer();
