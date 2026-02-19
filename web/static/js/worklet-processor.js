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
        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    _onMessage(msg) {
        if (msg.type === 'pcm') {
            const left = new Float32Array(msg.left);
            const right = new Float32Array(msg.right);
            const frames = left.length;
            const space = this._capacity - this._buffered;
            const toWrite = Math.min(frames, space);
            for (let i = 0; i < toWrite; i++) {
                this._bufL[this._writePos] = left[i];
                this._bufR[this._writePos] = right[i];
                this._writePos = (this._writePos + 1) % this._capacity;
            }
            this._buffered += toWrite;
            // Report back how many frames were actually written (for overflow detection)
            if (toWrite < frames) {
                this.port.postMessage({ type: 'overflow', dropped: frames - toWrite });
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
            outL.fill(0); outR.fill(0);
            this._reportCounter += frames;
            this._maybeReport();
            return true;
        }

        const corrX = this._correctAfterXFrames;
        let outIdx = 0;
        let consumed = 0;

        while (outIdx < frames) {
            if (this._buffered - consumed <= 0) {
                while (outIdx < frames) { outL[outIdx] = 0; outR[outIdx] = 0; outIdx++; }
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
                    continue; // drop frame (playing too slow, speed up)
                }
                outL[outIdx] = sL; outR[outIdx] = sR; outIdx++;
                if (corrX < 0 && this._playedFrames >= absCorrX) {
                    this._playedFrames = 0;
                    // duplicate frame (playing too fast, slow down)
                    if (outIdx < frames) { outL[outIdx] = sL; outR[outIdx] = sR; outIdx++; }
                }
            } else {
                outL[outIdx] = sL; outR[outIdx] = sR; outIdx++;
            }
        }

        this._readPos = (this._readPos + consumed) % this._capacity;
        this._buffered -= consumed;
        this._totalPlayedFrames += outIdx;    // DAC output frames
        this._totalConsumedFrames += consumed; // source audio frames (for position tracking)
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
