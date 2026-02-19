// Audio smoother worklet — detects PCM discontinuities and applies micro-fade
class SmootherProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._prevSample = new Float32Array(2); // last sample per channel
        this._fadeRemaining = 0;
        this._fadeLength = 64; // ~1.3ms @48kHz
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input.length) return true;

        for (let ch = 0; ch < input.length; ch++) {
            const inp = input[ch];
            const out = output[ch];
            let prev = this._prevSample[ch] || 0;

            for (let i = 0; i < inp.length; i++) {
                let sample = inp[i];

                // Detect discontinuity: jump > 0.3 between adjacent samples
                if (i === 0 && Math.abs(sample - prev) > 0.3) {
                    this._fadeRemaining = this._fadeLength;
                }

                // Apply fade-in during recovery from discontinuity
                if (this._fadeRemaining > 0) {
                    const t = 1 - (this._fadeRemaining / this._fadeLength);
                    sample *= t * t; // quadratic ease-in, smoother than linear
                    this._fadeRemaining--;
                }

                out[i] = sample;
                prev = sample;
            }
            this._prevSample[ch] = prev;
        }
        return true;
    }
}

registerProcessor('smoother-processor', SmootherProcessor);
