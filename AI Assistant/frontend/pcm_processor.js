class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.frameSize = 1600;
        this.buffer = new Int16Array(this.frameSize);
        this.writeIndex = 0;
    }

    process(inputs, outputs) {
        for (const channel of outputs[0] || []) {
            channel.fill(0);
        }

        const input = inputs[0];
        if (!input || !input[0]) {
            return true;
        }

        const channelData = input[0];

        for (let i = 0; i < channelData.length; i++) {
            const sample = Math.max(-1, Math.min(1, channelData[i]));
            this.buffer[this.writeIndex++] = sample < 0
                ? sample * 0x8000
                : sample * 0x7fff;

            if (this.writeIndex === this.frameSize) {
                const pcmData = this.buffer.buffer.slice(0);
                this.port.postMessage({ pcmData }, [pcmData]);
                this.writeIndex = 0;
            }
        }

        return true;
    }
}

registerProcessor('lumi-pcm-processor', PCMProcessor);
