import { useEffect, useRef } from "react";

interface AuraFaceProps {
  state: "idle" | "listening" | "speaking";
}

export const AuraFace = ({ state }: AuraFaceProps): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 200;
    const H = 200;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const cx = W / 2;
    const cy = H / 2;

    let t = 0;
    const draw = () => {
      t += 0.02;
      ctx.clearRect(0, 0, W, H);

      const drawBlob = (
        baseRadius: number,
        color: string,
        speedScale: number,
        waveCount: number,
        amplitude: number,
        alpha: number,
      ) => {
        ctx.beginPath();
        for (let i = 0; i <= Math.PI * 2 + 0.1; i += 0.05) {
          let wave = Math.sin(i * waveCount + t * speedScale) * amplitude;
          if (state === "speaking") {
            wave += Math.sin(i * (waveCount * 2) - t * speedScale * 2) * (amplitude * 0.5);
            wave += Math.sin(i * 3 + t * speedScale * 4) * (amplitude * 0.3);
          }
          const r = baseRadius + wave;
          const x = cx + Math.cos(i) * r;
          const y = cy + Math.sin(i) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 15;
        ctx.shadowColor = color;
        ctx.fill();
      };

      ctx.globalCompositeOperation = "screen";

      if (state === "idle") {
        drawBlob(45, "#a855f7", 1.0, 3, 4, 0.5);
        drawBlob(42, "#06b6d4", 1.2, 4, 3, 0.5);
        drawBlob(44, "#ec4899", 0.8, 2, 5, 0.5);
      } else if (state === "listening") {
        drawBlob(55, "#a855f7", 2.5, 3, 6, 0.6);
        drawBlob(52, "#ec4899", 3.0, 5, 4, 0.6);
        drawBlob(50, "#06b6d4", 2.2, 4, 5, 0.6);
        ctx.globalCompositeOperation = "source-over";
        drawBlob(15, "#ffffff", 4.0, 2, 2, 0.9);
      } else if (state === "speaking") {
        ctx.globalCompositeOperation = "screen";
        drawBlob(60, "#06b6d4", 4.0, 6, 8, 0.6);
        drawBlob(55, "#ec4899", 4.5, 8, 6, 0.6);
        drawBlob(58, "#a855f7", 5.0, 5, 9, 0.6);
        ctx.globalCompositeOperation = "source-over";
        const pulse = Math.sin(t * 10) * 4;
        drawBlob(22 + pulse, "#ffffff", 6.0, 4, 3, 1.0);
      }

      ctx.globalCompositeOperation = "source-over";

      if (state !== "speaking" && state !== "listening") {
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 10;
        ctx.shadowColor = "#ffffff";
        ctx.fill();
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [state]);

  const stateLabel = state === "listening" ? "Listening..." : state === "speaking" ? "Speaking..." : "Ready";
  const stateColor = state === "listening" ? "text-[#ec4899]" : state === "speaking" ? "text-[#06b6d4]" : "text-aura-muted";

  return (
    <div className="flex flex-col items-center gap-2 w-full h-full justify-center">
      <div className="relative flex items-center justify-center min-h-[160px] min-w-[160px]">
        <div
          className={`absolute inset-0 rounded-full blur-3xl transition-all duration-700 opacity-40 ${
            state === "listening" ? "bg-[#ec4899] scale-110"
            : state === "speaking" ? "bg-[#06b6d4] scale-125"
            : "bg-[#a855f7] scale-100"
          }`}
          style={{ zIndex: 0 }}
        />
        <canvas ref={canvasRef} className="relative z-10 w-[180px] h-[180px] object-contain" />
      </div>
      <p className={`text-[10px] font-bold uppercase tracking-widest transition-colors ${stateColor} z-10`}>
        {stateLabel}
      </p>
    </div>
  );
};
