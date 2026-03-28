/**
 * Deepgram STT client for Aura Desktop renderer.
 * Ported from aura-extension's deepgram.ts.
 *
 * Uses URL query-param auth (`token=<key>`) instead of subprotocol auth
 * because Electron's WebSocket implementation doesn't reliably forward
 * subprotocol headers to Deepgram's servers.
 */

const UTTERANCE_END_MS = 1_500;
const SAFETY_SILENCE_MS = 4_000;
const CONNECT_TIMEOUT_MS = 6_000;

export class DeepgramClient {
  private socket: WebSocket | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private accumulatedTranscript = "";
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private silenceFired = false;

  constructor(
    private readonly apiKey: string,
    private readonly callbacks: {
      onInterimTranscript: (text: string) => void;
      onFinalTranscript: (text: string) => void;
      onSilenceDetected?: () => void;
      onError: (error: Error) => void;
    },
  ) {}

  get isRunning(): boolean {
    return !this.stopped && this.socket?.readyState === WebSocket.OPEN;
  }

  get micStream(): MediaStream | null {
    return this.stream;
  }

  get transcript(): string {
    return this.accumulatedTranscript;
  }

  private fireSilence(): void {
    if (this.silenceFired || this.stopped) return;
    if (!this.accumulatedTranscript.trim()) return;
    this.silenceFired = true;
    this.clearSafetyTimer();
    this.callbacks.onSilenceDetected?.();
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private resetSafetyTimer(): void {
    this.clearSafetyTimer();
    this.safetyTimer = setTimeout(() => {
      this.fireSilence();
    }, SAFETY_SILENCE_MS);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("DeepgramClient already stopped — create a new instance");

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      // Use query-param auth — more reliable in Electron than subprotocol auth
      const url =
        `wss://api.deepgram.com/v1/listen` +
        `?token=${encodeURIComponent(this.apiKey)}` +
        `&model=nova-2&language=en-US` +
        `&interim_results=true` +
        `&endpointing=400` +
        `&utterance_end_ms=${UTTERANCE_END_MS}` +
        `&vad_events=true` +
        `&smart_format=true`;

      this.socket = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        if (!settled && this.socket?.readyState !== WebSocket.OPEN) {
          settled = true;
          const err = new Error("Deepgram connection timed out");
          this.callbacks.onError(err);
          void this.stop();
          reject(err);
        }
      }, CONNECT_TIMEOUT_MS);

      this.socket.onopen = () => {
        clearTimeout(connectTimeout);

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        this.mediaRecorder = new MediaRecorder(this.stream!, { mimeType });

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size === 0 || this.stopped) return;
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(e.data);
        };

        this.mediaRecorder.onerror = () => {
          this.callbacks.onError(new Error("Microphone recording failed"));
        };

        this.mediaRecorder.start(150);

        if (!settled) {
          settled = true;
          resolve();
        }
      };

      this.socket.onmessage = (event) => {
        if (this.stopped) return;
        let payload: {
          type?: string;
          channel?: { alternatives?: Array<{ transcript?: string }> };
          is_final?: boolean;
          speech_final?: boolean;
        };
        try {
          payload = JSON.parse(event.data as string);
        } catch {
          return;
        }

        if (payload.type === "UtteranceEnd") {
          this.fireSilence();
          return;
        }

        if (payload.type === "SpeechStarted") {
          this.silenceFired = false;
          this.clearSafetyTimer();
          return;
        }

        if (payload.type === "Metadata" || !payload.channel) return;

        const text = payload.channel.alternatives?.[0]?.transcript?.trim();
        if (!text) return;

        this.resetSafetyTimer();

        if (payload.is_final) {
          this.accumulatedTranscript = `${this.accumulatedTranscript} ${text}`.trim();
          this.callbacks.onFinalTranscript(this.accumulatedTranscript);

          if (payload.speech_final) {
            this.fireSilence();
          }
        } else {
          this.callbacks.onInterimTranscript(`${this.accumulatedTranscript} ${text}`.trim());
        }
      };

      this.socket.onerror = () => {
        clearTimeout(connectTimeout);
        if (!settled) {
          settled = true;
          const err = new Error("Deepgram connection failed — check API key");
          this.callbacks.onError(err);
          void this.stop();
          reject(err);
        } else if (!this.stopped) {
          this.callbacks.onError(new Error("Deepgram WebSocket error"));
        }
      };

      this.socket.onclose = (ev) => {
        clearTimeout(connectTimeout);
        if (!settled) {
          settled = true;
          const code = ev.code;
          const reason = code === 1008 ? "Invalid API key"
            : code === 1011 ? "Deepgram server error"
            : `Connection closed (code ${code})`;
          const err = new Error(reason);
          this.callbacks.onError(err);
          reject(err);
        } else if (!this.stopped && !this.silenceFired) {
          this.fireSilence();
        }
      };
    });
  }

  async stop(): Promise<string> {
    if (this.stopped) return this.accumulatedTranscript;
    this.stopped = true;
    this.clearSafetyTimer();

    try {
      this.mediaRecorder?.stop();
    } catch { /* ignore */ }
    this.mediaRecorder = null;

    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch { /* ignore */ }
    this.stream = null;

    try {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, "Normal closure");
    } catch { /* ignore */ }
    this.socket = null;

    return this.accumulatedTranscript;
  }
}
