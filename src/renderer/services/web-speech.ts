/**
 * WebSpeech STT client — fallback when Deepgram is unavailable.
 * Ported from aura-extension's webSpeech.ts.
 */

const SILENCE_MS = 2_800;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RecognitionFactory = new () => any;

const getRecognitionFactory = (): RecognitionFactory | null => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

export class WebSpeechClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognition: any = null;
  private _transcript = "";
  private stopped = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly callbacks: {
      onInterimTranscript: (text: string) => void;
      onFinalTranscript: (text: string) => void;
      onSilenceDetected?: () => void;
      onError: (error: Error) => void;
    },
  ) {}

  isSupported(): boolean {
    return getRecognitionFactory() !== null;
  }

  get isRunning(): boolean {
    return !this.stopped && this.recognition !== null;
  }

  get transcript(): string {
    return this._transcript.trim();
  }

  private clearSilence(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private resetSilenceTimer(): void {
    this.clearSilence();
    this.silenceTimer = setTimeout(() => {
      if (!this.stopped) {
        this.callbacks.onSilenceDetected?.();
      }
    }, SILENCE_MS);
  }

  async start(): Promise<void> {
    const Factory = getRecognitionFactory();
    if (!Factory) throw new Error("Web Speech API is unavailable");

    this.stopped = false;
    this._transcript = "";
    this.recognition = new Factory();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.recognition.onresult = (event: any) => {
      if (this.stopped) return;
      this.resetSilenceTimer();

      let interimText = "";
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          this._transcript += `${text} `;
          this.callbacks.onFinalTranscript(this._transcript.trim());
        } else {
          interimText += text;
        }
      }

      if (interimText) {
        this.callbacks.onInterimTranscript(`${this._transcript}${interimText}`.trim());
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.recognition.onerror = (event: any) => {
      const errCode = event.error ?? "unknown";
      if (errCode === "no-speech") {
        this.resetSilenceTimer();
        return;
      }
      if (!this.stopped) this.callbacks.onError(new Error(`Voice recognition failed: ${errCode}`));
    };

    this.recognition.onend = () => {
      if (this.stopped) return;
      try { this.recognition?.start(); } catch { /* ignore */ }
    };

    this.recognition.start();
  }

  stop(): string {
    if (this.stopped) return this._transcript.trim();
    this.stopped = true;
    this.clearSilence();
    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.recognition = null;
    return this._transcript.trim();
  }
}
