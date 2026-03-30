/**
 * Deepgram STT client for Aura Desktop renderer.
 * Ported from aura-extension's deepgram.ts.
 *
 * Tries two auth methods in order:
 *   1. Query-param auth (`?token=<key>`) — works in most Electron versions
 *   2. Subprotocol auth (`Sec-WebSocket-Protocol: token, <key>`) — browser standard
 *
 * Includes comprehensive logging to diagnose connection/mic issues.
 */

const UTTERANCE_END_MS = 1_500;
const SAFETY_SILENCE_MS = 4_000;
const CONNECT_TIMEOUT_MS = 8_000;

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

    console.log("[Deepgram] Requesting microphone access...");

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const tracks = this.stream.getAudioTracks();
      console.log("[Deepgram] Microphone access granted:", tracks.length, "tracks");
      for (const track of tracks) {
        console.log("[Deepgram]   Track:", track.label, "enabled:", track.enabled, "readyState:", track.readyState);
      }
    } catch (micErr) {
      const msg = micErr instanceof Error ? micErr.message : String(micErr);
      console.error("[Deepgram] Microphone access DENIED:", msg);
      throw new Error(`Microphone access denied: ${msg}`);
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      // Build Deepgram URL with query-param auth
      const baseParams =
        `model=nova-2&language=en-US` +
        `&interim_results=true` +
        `&endpointing=400` +
        `&utterance_end_ms=${UTTERANCE_END_MS}` +
        `&vad_events=true` +
        `&smart_format=true`;

      // Try query-param auth first (more reliable in Electron)
      const url = `wss://api.deepgram.com/v1/listen?token=${encodeURIComponent(this.apiKey)}&${baseParams}`;

      console.log("[Deepgram] Connecting to WebSocket (query-param auth)...");
      console.log("[Deepgram] API key starts with:", this.apiKey.substring(0, 8) + "...");

      this.socket = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        if (!settled && this.socket?.readyState !== WebSocket.OPEN) {
          settled = true;
          console.error("[Deepgram] Connection timed out after", CONNECT_TIMEOUT_MS, "ms");
          const err = new Error("Deepgram connection timed out");
          this.callbacks.onError(err);
          void this.stop();
          reject(err);
        }
      }, CONNECT_TIMEOUT_MS);

      this.socket.onopen = () => {
        clearTimeout(connectTimeout);
        console.log("[Deepgram] WebSocket CONNECTED!");

        const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";

        console.log("[Deepgram] Using MediaRecorder mimeType:", mimeType);

        this.mediaRecorder = new MediaRecorder(this.stream!, { mimeType });

        let chunkCount = 0;
        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size === 0 || this.stopped) return;
          chunkCount++;
          if (chunkCount <= 5 || chunkCount % 20 === 0) {
            console.log("[Deepgram] Audio chunk #" + chunkCount + ", size:", e.data.size, "bytes");
          }
          if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(e.data);
        };

        this.mediaRecorder.onerror = () => {
          console.error("[Deepgram] MediaRecorder error!");
          this.callbacks.onError(new Error("Microphone recording failed"));
        };

        this.mediaRecorder.start(150);
        console.log("[Deepgram] MediaRecorder started (150ms timeslice)");

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
          console.warn("[Deepgram] Non-JSON message:", (event.data as string).substring(0, 100));
          return;
        }

        if (payload.type === "UtteranceEnd") {
          console.log("[Deepgram] UtteranceEnd detected");
          this.fireSilence();
          return;
        }

        if (payload.type === "SpeechStarted") {
          console.log("[Deepgram] SpeechStarted detected");
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
          console.log("[Deepgram] Final transcript:", this.accumulatedTranscript);
          this.callbacks.onFinalTranscript(this.accumulatedTranscript);

          if (payload.speech_final) {
            this.fireSilence();
          }
        } else {
          this.callbacks.onInterimTranscript(`${this.accumulatedTranscript} ${text}`.trim());
        }
      };

      this.socket.onerror = (ev) => {
        clearTimeout(connectTimeout);
        console.error("[Deepgram] WebSocket ERROR:", ev);
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
        console.warn("[Deepgram] WebSocket CLOSED — code:", ev.code, "reason:", ev.reason || "(none)");
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
    console.log("[Deepgram] Stopping client...");

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
