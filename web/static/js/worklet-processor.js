/**
 * AudioWorklet Processor for ListenTogether
 * Ring buffer based PCM playback with sample-level drift correction (Snapcast algorithm)
 */
class ListenTogetherProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._capacity = Math.ceil(sampleRate * 5); // 5 seconds stereo
        this._bufL = new Float32Array(this._capacity);
        this._bufR = new Float32Array(this._capacity);
        this._writePos = 0;
        this._readPos = 0;
        this._buffered = 0;
        this._correctAfterXFrames = 0;
        this._playedFrames = 0;
        this._totalPlayedFrames = 0;
        this._totalConsumedFrames = 0;
        this._reportCounter = 0;
        this._reportInterval = Math.ceil(sampleRate / 10); // 100ms reporting
        // Fade-out state for underrun smoothing
        this._lastSampleL = 0;
        this._lastSampleR = 0;
        this._fadeOutRemaining = 0;
        this._FADE_OUT_LEN = 64; // ~1.3ms at 48kHz
        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    _onMessage(msg) {
        if (msg.type === 'pcm') {
            const left = new Float32Array(msg.left);
            const right = new Float32Array(msg.right);
            const frames = left.length;
            const space = this._capacity - this._buffered;
            if (space >= frames) {
                // Enough space, write all
                for (let i = 0; i < frames; i++) {
                    this._bufL[this._writePos] = left[i];
                    this._bufR[this._writePos] = right[i];
                    this._writePos = (this._writePos + 1) % this._capacity;
                }
                this._buffered += frames;
            } else {
                // Overflow: drop oldest data to make room, then write all new data
                const need = frames - space;
                this._readPos = (this._readPos + need) % this._capacity;
                this._buffered -= need;
                this._totalConsumedFrames += need; // account for skipped frames
                for (let i = 0; i < frames; i++) {
                    this._bufL[this._writePos] = left[i];
                    this._bufR[this._writePos] = right[i];
                    this._writePos = (this._writePos + 1) % this._capacity;
                }
                this._buffered += frames;
                this.port.postMessage({ type: 'overflow', dropped: need });
            }
        } else if (msg.type === 'correction') {
            this._correctAfterXFrames = msg.correctAfterXFrames | 0;
            this._playedFrames = 0;
        } else if (msg.type === 'clear') {
            this._readPos = 0;
            this._writePos = 0;
            this._buffered = 0;
            this._playedFrames = 0;
            this._totalPlayedFrames = 0;
            this._totalConsumedFrames = 0;
            this._lastSampleL = 0;
            this._lastSampleR = 0;
            this._fadeOutRemaining = 0;
        } else if (msg.type === 'query') {
            this._doReport();
        }
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length < 2) return true;
        const outL = output[0];
        const outR = output[1];
        const frames = outL.length;

        if (this._buffered === 0) {
            // Underrun: fade out from last sample to avoid click/pop
            if (this._fadeOutRemaining > 0) {
                for (let i = 0; i < frames; i++) {
                    if (this._fadeOutRemaining > 0) {
                        const gain = this._fadeOutRemaining / this._FADE_OUT_LEN;
                        outL[i] = this._lastSampleL * gain;
                        outR[i] = this._lastSampleR * gain;
                        this._fadeOutRemaining--;
                    } else {
                        outL[i] = 0; outR[i] = 0;
                    }
                }
            } else {
                outL.fill(0); outR.fill(0);
            }
            this._reportCounter += frames;
            this._maybeReport();
            return true;
        }

        // Reset fade state when we have data
        this._fadeOutRemaining = this._FADE_OUT_LEN;

        const corrX = this._correctAfterXFrames;
        let outIdx = 0;
        let consumed = 0;

        while (outIdx < frames) {
            if (this._buffered - consumed <= 0) {
                // Entering underrun mid-block: fade out remaining samples
                const fadeLen = Math.min(frames - outIdx, this._FADE_OUT_LEN);
                for (let i = 0; i < fadeLen; i++) {
                    const gain = (fadeLen - i) / fadeLen;
                    outL[outIdx] = this._lastSampleL * gain;
                    outR[outIdx] = this._lastSampleR * gain;
                    outIdx++;
                }
                while (outIdx < frames) { outL[outIdx] = 0; outR[outIdx] = 0; outIdx++; }
                this._fadeOutRemaining = 0; // already faded
                break;
            }
            const rp = (this._readPos + consumed) % this._capacity;
            const sL = this._bufL[rp];
            const sR = this._bufR[rp];
            consumed++;

            if (corrX !== 0) {
                this._playedFrames++;
                const absCorrX = Math.abs(corrX);
                if (corrX > 0 && this._playedFrames >= absCorrX) {
                    this._playedFrames = 0;
                    this._lastSampleL = sL; this._lastSampleR = sR;
                    continue; // drop frame (playing too slow, speed up)
                }
                outL[outIdx] = sL; outR[outIdx] = sR;
                this._lastSampleL = sL; this._lastSampleR = sR;
                outIdx++;
                if (corrX < 0 && this._playedFrames >= absCorrX) {
                    this._playedFrames = 0;
                    if (outIdx < frames) { outL[outIdx] = sL; outR[outIdx] = sR; outIdx++; }
                }
            } else {
                outL[outIdx] = sL; outR[outIdx] = sR;
                this._lastSampleL = sL; this._lastSampleR = sR;
                outIdx++;
            }
        }

        this._readPos = (this._readPos + consumed) % this._capacity;
        this._buffered -= consumed;
        this._totalPlayedFrames += outIdx;
        this._totalConsumedFrames += consumed;
        this._reportCounter += frames;
        this._maybeReport();
        return true;
    }

    _maybeReport() {
        if (this._reportCounter >= this._reportInterval) {
            this._reportCounter = 0;
            this._doReport();
        }
    }

    _doReport() {
        this.port.postMessage({
            type: 'stats', buffered: this._buffered, capacity: this._capacity,
            totalPlayedFrames: this._totalPlayedFrames,
            totalConsumedFrames: this._totalConsumedFrames,
            sampleRate: sampleRate
        });
    }
}

registerProcessor('listen-together-processor', ListenTogetherProcessor);
