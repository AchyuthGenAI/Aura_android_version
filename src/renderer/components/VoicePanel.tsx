import { useEffect, useRef, useState } from "react";

import { AuraLogoBlob } from "./primitives";
import { useAuraStore } from "@renderer/store/useAuraStore";

const ListeningDots = () => (
  <div className="flex items-center gap-1.5 justify-center h-4 my-2">
    <div className="w-1.5 h-1.5 rounded-full bg-[#ec4899] animate-bounce" style={{ animationDelay: "0ms" }} />
    <div className="w-1.5 h-1.5 rounded-full bg-[#ec4899] animate-bounce" style={{ animationDelay: "150ms" }} />
    <div className="w-1.5 h-1.5 rounded-full bg-[#ec4899] animate-bounce" style={{ animationDelay: "300ms" }} />
    <div className="w-2 h-2 rounded-full bg-[#ec4899] animate-bounce" style={{ animationDelay: "450ms" }} />
    <div className="w-1.5 h-1.5 rounded-full bg-[#ec4899] animate-bounce" style={{ animationDelay: "600ms" }} />
  </div>
);

export const VoicePanel = ({ active }: { active: boolean }): JSX.Element => {
  const sendMessage = useAuraStore((state) => state.sendMessage);
  const messages = useAuraStore((state) => state.messages);
  const settings = useAuraStore((state) => state.settings);
  const [phase, setPhase] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [transcript, setTranscript] = useState("");
  const recognitionRef = useRef<any>(null);

  const lastAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant" && message.status === "done");

  useEffect(() => {
    if (!active || !settings.voiceEnabled || !lastAssistantMessage || phase !== "thinking") {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(lastAssistantMessage.content.slice(0, 2800));
    utterance.onend = () => setPhase("idle");
    setPhase("speaking");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [active, lastAssistantMessage, phase, settings.voiceEnabled]);

  const toggleListening = async () => {
    const RecognitionCtor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!RecognitionCtor) {
      return;
    }
    if (phase === "listening") {
      recognitionRef.current?.stop?.();
      setPhase("idle");
      return;
    }
    const recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = async (event: any) => {
      const combined = Array.from(event.results)
        .map((result: any) => result[0]?.transcript || "")
        .join(" ")
        .trim();
      setTranscript(combined);
      const last = event.results[event.results.length - 1];
      if (last?.isFinal && combined) {
        recognition.stop();
        setPhase("thinking");
        await sendMessage("voice", combined);
      }
    };
    recognition.onerror = () => setPhase("idle");
    recognition.onend = () => {
      if (phase !== "thinking") {
        setPhase("idle");
      }
    };
    recognition.start();
    recognitionRef.current = recognition;
    setTranscript("");
    setPhase("listening");
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 pb-2 pt-4 text-center fade-up">
      
      <div className="flex flex-col items-center relative">
        <div className="absolute inset-0 m-auto w-[240px] h-[240px] bg-[#ec4899]/10 blur-3xl rounded-full" />
        <div className="scale-[2.4] mb-8">
          <AuraLogoBlob size="md" isTaskRunning={phase === "speaking" || phase === "thinking"} />
        </div>
        
        {phase === "speaking" || phase === "thinking" ? (
          <div className="mt-8 flex flex-col items-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#06b6d4]">
              {phase === "thinking" ? "THINKING..." : "SPEAKING..."}
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white">
               {phase === "speaking" ? "Still here." : "Evaluating..."}
            </h2>
          </div>
        ) : (
          <div className="mt-8 flex flex-col items-center">
             <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#ec4899]">LISTENING...</p>
             <ListeningDots />
             <p className="text-[13px] font-medium text-[#ec4899]/80">Listening...</p>
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-3">
        {phase === "listening" ? (
          <button 
            className="flex h-[68px] w-[68px] items-center justify-center rounded-full bg-[#ec4899] text-white shadow-[0_8px_32px_rgba(236,72,153,0.4)] transition-transform hover:scale-105 active:scale-95"
            onClick={() => void toggleListening()}
          >
            <div className="h-5 w-5 rounded-sm bg-white" />
          </button>
        ) : (
          <button 
            className="flex h-[68px] w-[68px] items-center justify-center rounded-full bg-[#7c3aed] text-white shadow-[0_8px_32px_rgba(124,58,237,0.4)] transition-transform hover:scale-105 active:scale-95"
            onClick={() => void toggleListening()}
          >
             <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
          </button>
        )}
        <p className="text-[12px] font-medium text-aura-muted">
          {phase === "listening" ? "Tap to stop" : "Tap to interrupt"}
        </p>
      </div>

    </div>
  );
};
