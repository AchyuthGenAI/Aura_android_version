import { useCallback } from "react";

export type InteractionMode = "drag" | "resize" | "bubble-drag";

export interface WindowInteractionOptions {
  mode: InteractionMode;
  onMove: (nextX: number, nextY: number, nextW: number, nextH: number) => void;
  onComplete: (hasMoved: boolean) => void;
  collapsedSize?: number;
}

/**
 * A highly optimized, custom React hook that replaces native OS dragging and resizing.
 * Native `-webkit-app-region` fails on transparent Windows 11 Electron windows.
 * This hook captures pointer events natively and calculates strict delta bounds
 * using `window.screenX/Y` to guarantee the window cannot desync or glitch.
 */
export const useWindowInteraction = ({ mode, onMove, onComplete, collapsedSize = 84 }: WindowInteractionOptions) => {
  return useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Only process left clicks
      if (e.button !== 0) return;

      // Ignore if clicking on an interactive element (buttons, links, inputs)
      const targetElement = e.target as HTMLElement;
      if (targetElement.closest("button") || targetElement.closest("a") || targetElement.closest("input")) {
        return;
      }

      e.stopPropagation();
      if (mode === "resize") e.preventDefault();

      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      const initialW = window.innerWidth;
      const initialH = window.innerHeight;
      const initialMouseX = e.screenX;
      const initialMouseY = e.screenY;
      const minX = (window.screen as any).availLeft || 0;
      const minY = (window.screen as any).availTop || 0;
      const winX = window.screenX;
      const winY = window.screenY;

      let hasMoved = false;
      let frameId: number | null = null;

      const handleMove = (moveEv: PointerEvent) => {
        if (mode !== "resize" && !hasMoved && (Math.abs(moveEv.screenX - initialMouseX) > 4 || Math.abs(moveEv.screenY - initialMouseY) > 4)) {
          hasMoved = true;
        } else if (mode === "resize") {
          hasMoved = true;
        }

        if ((hasMoved || mode === "resize") && !frameId) {
          frameId = requestAnimationFrame(() => {
            let nextX = winX;
            let nextY = winY;
            let nextW = initialW;
            let nextH = initialH;

            const deltaX = moveEv.screenX - initialMouseX;
            const deltaY = moveEv.screenY - initialMouseY;

            if (mode === "resize") {
              const minX = (window.screen as any).availLeft || 0;
              const minY = (window.screen as any).availTop || 0;
              const screenRight = minX + (window.screen.availWidth || window.innerWidth);
              const screenBottom = minY + (window.screen.availHeight || window.innerHeight);

              const maxWidth = screenRight - winX;
              const maxHeight = screenBottom - winY;

              nextW = Math.max(300, Math.min(initialW + deltaX, maxWidth));
              nextH = Math.max(400, Math.min(initialH + deltaY, maxHeight));
            } else {
              nextX = winX + deltaX;
              nextY = winY + deltaY;
              if (mode === "bubble-drag") {
                nextW = collapsedSize;
                nextH = collapsedSize;
              }

              const minX = (window.screen as any).availLeft || 0;
              const minY = (window.screen as any).availTop || 0;
              const maxX = minX + (window.screen.availWidth || window.innerWidth) - nextW;
              const maxY = minY + (window.screen.availHeight || window.innerHeight) - nextH;

              nextX = Math.max(minX, Math.min(nextX, maxX));
              nextY = Math.max(minY, Math.min(nextY, maxY));
            }

            onMove(nextX, nextY, nextW, nextH);

            void window.auraDesktop.widget.setBounds({
              x: nextX,
              y: nextY,
              width: nextW,
              height: nextH
            });
            frameId = null;
          });
        }
      };

      const handleUp = (upEv: PointerEvent) => {
        target.releasePointerCapture(upEv.pointerId);
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        if (frameId) cancelAnimationFrame(frameId);
        onComplete(hasMoved);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [mode, onMove, onComplete, collapsedSize]
  );
};
