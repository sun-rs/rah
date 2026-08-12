import { useEffect, useState } from "react";

export function useComposerVisualViewportRevision(active: boolean): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!active || typeof window === "undefined") {
      return;
    }
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setRevision((current) => current + 1);
      });
    };
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", schedule);
    visualViewport?.addEventListener("resize", schedule);
    visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [active]);

  return revision;
}
