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
const FINALIZE_WAIT_MS = 500;

export class DeepgramClient {
  private socket: WebSocket | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private accumulatedTranscript = "";
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private closing = false;
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
    return !this.stopped && !this.closing && this.socket?.readyState === WebSocket.OPEN;
  }

  get micStream(): MediaStream | null {
    return this.stream;
  }

  get transcript(): string {
    return this.accumulatedTranscript;
  }

  private fireSilence(): void {
    if (this.silenceFired || this.stopped || this.closing) return;
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

  private async connectWebSocketWithFallbacks(baseUrl: string): Promise<WebSocket> {
    const attempts: Array<{ label: string; url: string; protocols?: string[] }> = [];
    attempts.push({
      label: "query-api-key",
      url: `${baseUrl}&token=${encodeURIComponent(this.apiKey)}`,
    });
    attempts.push({
      label: "protocol-api-key",
      url: baseUrl,
      protocols: ["token", this.apiKey],
    });

    let lastError: Error | null = null;
    for (const attempt of attempts) {
      try {
        return await this.openWebSocket(attempt.url, attempt.protocols);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[Deepgram] WebSocket auth attempt failed (${attempt.label}):`, lastError.message);
      }
    }

    throw lastError ?? new Error("Could not connect to Deepgram.");
  }

  private openWebSocket(url: string, protocols?: string[]): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const socket = protocols?.length ? new WebSocket(url, protocols) : new WebSocket(url);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error("Deepgram connection timed out"));
      }, CONNECT_TIMEOUT_MS);

      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { socket.close(); } catch { /* ignore */ }
        reject(new Error(message));
      };

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(socket);
      };

      socket.onerror = () => {
        fail("Deepgram WebSocket auth failed");
      };

      socket.onclose = (event) => {
        if (settled) return;
        const code = event.code;
        const reason = event.reason?.trim();
        fail(reason || `Deepgram connection closed (code ${code})`);
      };
    });
  }
  async start(): Promise<void> {
    if (this.stopped) throw new Error("DeepgramClient already stopped — create a new instance");
    this.closing = false;
    this.silenceFired = false;
    this.accumulatedTranscript = "";

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error("Microphone permission was denied.");
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        throw new Error("No microphone was found.");
      }
      throw error instanceof Error ? error : new Error("Unable to access the microphone.");
    }
    try {
      const url =
        `wss://api.deepgram.com/v1/listen` +
        `?model=nova-2&language=en-US` +
        `&interim_results=true` +
        `&endpointing=400` +
        `&utterance_end_ms=${UTTERANCE_END_MS}` +
        `&vad_events=true` +
        `&smart_format=true`;

      this.socket = await this.connectWebSocketWithFallbacks(url);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onError(err);
      await this.stop();
      throw err;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.socket!;

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
      settled = true;
      resolve();

      socket.onmessage = (event) => {
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

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          const err = new Error("Deepgram connection failed — check API key");
          this.callbacks.onError(err);
          void this.stop();
          reject(err);
        } else if (!this.stopped && !this.closing) {
          this.callbacks.onError(new Error("Deepgram WebSocket error"));
        }
      };

      socket.onclose = (ev) => {
        if (!settled) {
          settled = true;
          const code = ev.code;
          const reason = code === 1008 ? "Invalid API key"
            : code === 1011 ? "Deepgram server error"
            : `Connection closed (code ${code})`;
          const err = new Error(reason);
          this.callbacks.onError(err);
          reject(err);
        } else if (!this.stopped && !this.closing && !this.silenceFired) {
          this.fireSilence();
        }
      };
    });
  }

  private async stopRecorder(): Promise<void> {
    const recorder = this.mediaRecorder;
    this.mediaRecorder = null;
    if (!recorder) return;
    if (recorder.state === "inactive") return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        recorder.removeEventListener("stop", finish);
        recorder.removeEventListener("error", finish);
        resolve();
      };

      recorder.addEventListener("stop", finish, { once: true });
      recorder.addEventListener("error", finish, { once: true });

      try {
        recorder.requestData();
      } catch {
        // Ignore recorders that do not support requestData in the current state.
      }

      try {
        recorder.stop();
      } catch {
        finish();
      }
    });
  }

  private async finalizeSocket(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        socket.removeEventListener("close", finish);
        clearTimeout(timeout);
        resolve();
      };

      const timeout = setTimeout(finish, FINALIZE_WAIT_MS);
      socket.addEventListener("close", finish, { once: true });

      try {
        socket.send(JSON.stringify({ type: "Finalize" }));
      } catch {
        finish();
      }
    });
  }

  async stop(): Promise<string> {
    if (this.stopped) return this.accumulatedTranscript;
    this.closing = true;
    this.clearSafetyTimer();

    await this.stopRecorder();
    await this.finalizeSocket();

    try {
      this.stream?.getTracks().forEach((t) => t.stop());
    } catch { /* ignore */ }
    this.stream = null;

    try {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, "Normal closure");
    } catch { /* ignore */ }
    this.socket = null;
    this.stopped = true;
    this.closing = false;

    return this.accumulatedTranscript;
  }
}
