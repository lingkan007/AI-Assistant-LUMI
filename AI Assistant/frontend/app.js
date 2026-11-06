class LumiAssistant {
  constructor() {
    this.socket = null;
    this.micContext = null;
    this.playContext = null;
    this.micStream = null;
    this.micSource = null;
    this.worklet = null;
    this.activeSources = [];
    this.nextPlayTime = 0;
    this.audioGeneration = 0;
    this.responseComplete = false;
    this.active = false;
    this.connecting = false;
    this.stopping = false;
    this.fatalError = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.userTranscript = '';
    this.lumiTranscript = '';

    this.image = document.getElementById('character');
    this.stateLabel = document.getElementById('state');
    this.transcript = document.getElementById('transcript');
    this.wakeButton = document.getElementById('wake');

    this.wakeButton.addEventListener('click', () => {
      if (this.active || this.connecting) {
        this.stop();
      } else {
        this.start();
      }
    });
  }

  async start() {
    if (this.active || this.connecting) {
      return;
    }

    this.connecting = true;
    this.stopping = false;
    this.fatalError = false;
    this.wakeButton.disabled = true;
    this.wakeButton.textContent = 'Connecting...';
    this.transcript.textContent = 'Connecting to Lumi...';

    try {
      this.ensurePlaybackContext();
      await this.playContext.resume();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        if (this.socket !== socket) {
          socket.close();
          return;
        }
        this.connecting = false;
        this.active = true;
        this.reconnectAttempts = 0;
        this.wakeButton.disabled = false;
        this.wakeButton.textContent = 'Sleep Lumi';
        this.transcript.textContent = 'Lumi is awake. Say hello!';
        this.setState('LISTENING');
        this.startMicrophone(socket);
      };

      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => {
        if (this.socket === socket) {
          this.transcript.textContent = 'Connection problem. Checking the voice service...';
        }
      };
      socket.onclose = () => this.handleClose(socket);
    } catch (error) {
      console.error('Could not start Lumi:', error);
      this.connecting = false;
      this.wakeButton.disabled = false;
      this.wakeButton.textContent = 'Wake up Lumi';
      this.transcript.textContent =
        'Could not start audio. Allow microphone access and try again.';
      this.setState('IDLE');
    }
  }

  ensurePlaybackContext() {
    if (!this.playContext || this.playContext.state === 'closed') {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.playContext = new AudioContextClass({ sampleRate: 24000 });
    }
  }

  async startMicrophone(socket) {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      this.fatalError = true;
      this.transcript.textContent =
        'Microphone capture requires a supported browser on localhost or HTTPS.';
      socket.close();
      return;
    }

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.micContext = new AudioContextClass({ sampleRate: 16000 });
      await this.micContext.resume();
      await this.micContext.audioWorklet.addModule('/pcm_processor.js');
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.releaseMicrophone();
        return;
      }

      this.micSource = this.micContext.createMediaStreamSource(this.micStream);
      this.worklet = new AudioWorkletNode(this.micContext, 'lumi-pcm-processor');
      this.worklet.port.onmessage = ({ data }) => {
        if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 262144) {
          socket.send(data.pcmData);
        }
      };

      this.micSource.connect(this.worklet);
      this.worklet.connect(this.micContext.destination);
      this.transcript.textContent = 'Listening. Speak naturally to Lumi.';
      this.setState('LISTENING');
    } catch (error) {
      console.error('Could not start the microphone:', error);
      this.fatalError = true;
      this.transcript.textContent =
        'Microphone access failed. Allow access in your browser and try again.';
      socket.close();
    }
  }

  handleMessage(event) {
    if (event.data instanceof ArrayBuffer) {
      this.playAudio(event.data);
      return;
    }
    if (typeof event.data !== 'string') {
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      console.error('Received an invalid server message:', error);
      return;
    }

    if (message.action === 'clear_audio') {
      this.clearAudio();
      return;
    }
    if (message.type === 'error') {
      this.fatalError = true;
      this.transcript.textContent = message.message || 'Gemini Live is unavailable.';
      return;
    }
    if (message.type === 'transcript' && message.text) {
      if (message.role === 'user') {
        this.userTranscript = message.text;
        this.lumiTranscript = '';
        this.setState('THINKING');
      } else {
        this.lumiTranscript += message.text;
      }
      this.renderTranscript();
      return;
    }
    if (message.type === 'state') {
      const nextState = String(message.state).toUpperCase();
      if (nextState === 'IDLE') {
        this.responseComplete = true;
        if (this.activeSources.length === 0) {
          this.setState(this.active ? 'LISTENING' : 'IDLE');
        }
      } else if (['LISTENING', 'THINKING', 'TALKING'].includes(nextState)) {
        this.setState(nextState);
      }
    }
  }

  renderTranscript() {
    const lines = [];
    if (this.userTranscript) {
      lines.push(`You: ${this.userTranscript}`);
    }
    if (this.lumiTranscript) {
      lines.push(`Lumi: ${this.lumiTranscript}`);
    }
    this.transcript.textContent = lines.join('\n');
  }

  playAudio(arrayBuffer) {
    if (!this.playContext || arrayBuffer.byteLength < 2) {
      return;
    }

    const sampleCount = Math.floor(arrayBuffer.byteLength / 2);
    const view = new DataView(arrayBuffer);
    const channel = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      channel[i] = view.getInt16(i * 2, true) / 32768;
    }

    const buffer = this.playContext.createBuffer(1, sampleCount, 24000);
    buffer.copyToChannel(channel, 0);

    const source = this.playContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playContext.destination);

    const now = this.playContext.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now + 0.04;
    }
    const generation = this.audioGeneration;
    this.responseComplete = false;
    this.activeSources.push(source);
    source.onended = () => {
      if (generation !== this.audioGeneration) {
        return;
      }
      this.activeSources = this.activeSources.filter((activeSource) => activeSource !== source);
      if (this.activeSources.length === 0 && this.responseComplete) {
        this.setState(this.active ? 'LISTENING' : 'IDLE');
      }
    };

    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;
    this.setState('TALKING');
  }

  clearAudio() {
    this.audioGeneration++;
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch (error) {
        console.debug('Audio source was already stopped.', error);
      }
    }
    this.activeSources = [];
    this.nextPlayTime = 0;
    this.responseComplete = false;
  }

  setState(state) {
    const sprites = {
      IDLE: '/assets/lumi_idle.png',
      LISTENING: '/assets/lumi_listening.png',
      THINKING: '/assets/lumi_thinking.png',
      TALKING: '/assets/lumi_talking.png'
    };
    if (!sprites[state]) {
      return;
    }
    document.body.dataset.state = state;
    this.image.src = sprites[state];
    this.stateLabel.textContent = state.charAt(0) + state.slice(1).toLowerCase();
  }

  releaseMicrophone() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
    if (this.worklet) {
      this.worklet.disconnect();
      this.worklet = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micContext) {
      this.micContext.close();
      this.micContext = null;
    }
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.active = false;
    this.connecting = false;
    this.releaseMicrophone();
    this.clearAudio();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, 'Lumi stopped');
    }
    this.wakeButton.disabled = false;
    this.wakeButton.textContent = 'Wake up Lumi';
    this.transcript.textContent = 'Lumi is resting.';
    this.setState('IDLE');
  }

  handleClose(socket) {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.active = false;
    this.connecting = false;
    this.releaseMicrophone();
    this.clearAudio();
    this.setState('IDLE');

    if (this.stopping) {
      this.stopping = false;
      return;
    }
    if (this.fatalError) {
      this.wakeButton.disabled = false;
      this.wakeButton.textContent = 'Try again';
      return;
    }
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    const delay = Math.min(15000, 1000 * (2 ** this.reconnectAttempts));
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 4);
    this.wakeButton.disabled = true;
    this.wakeButton.textContent = 'Reconnecting...';
    this.transcript.textContent =
      `Connection lost. Reconnecting in ${Math.ceil(delay / 1000)} seconds...`;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delay);
  }
}

new LumiAssistant();
