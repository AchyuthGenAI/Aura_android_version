import { useEffect, useRef, useState } from "react";

import { AuraFace } from "./primitives";
import { Button } from "./shared";
import { useAuraStore } from "@renderer/store/useAuraStore";

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
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <AuraFace phase={phase} />
      <div>
        <p className="text-xs uppercase tracking-[0.24em] text-aura-violet">{phase}</p>
        <p className="mt-2 text-sm text-aura-muted">
          {transcript || "Aura Voice listens, thinks, and speaks back through the local desktop wrapper."}
        </p>
      </div>
      <Button className="bg-aura-gradient text-white" onClick={() => void toggleListening()}>
        {phase === "listening" ? "Stop Listening" : "Start Voice"}
      </Button>
    </div>
  );
};
