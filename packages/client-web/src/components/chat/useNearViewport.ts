import { useEffect, useRef, useState } from "react";

export function useNearViewport<T extends Element = HTMLDivElement>(
  rootMargin = "240px",
): { ref: React.RefObject<T | null>; nearViewport: boolean } {
  const ref = useRef<T | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    if (nearViewport) {
      return;
    }
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nearViewport, rootMargin]);

  return { ref, nearViewport };
}
