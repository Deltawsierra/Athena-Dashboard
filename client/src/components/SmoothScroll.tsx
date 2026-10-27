import { useEffect, useRef, ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useReducedMotion } from 'framer-motion';
import Lenis from 'lenis';

interface SmoothScrollProps {
  children: ReactNode;
}

export default function SmoothScroll({ children }: SmoothScrollProps) {
  const lenisRef = useRef<Lenis | null>(null);
  const rafRef = useRef<number | null>(null);
  // `null` means the OS has expressed no preference; only an explicit
  // "reduce" turns the smooth wheel off.
  const reduceMotion = useReducedMotion() === true;
  const [location] = useLocation();

  useEffect(() => {
    // Respect prefers-reduced-motion: no scroll hijacking, no per-frame rAF.
    // The browser's own (instant) scrolling takes over, which is what someone
    // who asked for less motion is asking for.
    if (reduceMotion) {
      lenisRef.current = null;
      return;
    }

    const lenis = new Lenis({
      duration: 1.2,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      orientation: 'vertical',
      smoothWheel: true,
      wheelMultiplier: 1,
      touchMultiplier: 2,
      infinite: false,
    });

    lenisRef.current = lenis;

    function raf(time: number) {
      lenis.raf(time);
      rafRef.current = requestAnimationFrame(raf);
    }

    rafRef.current = requestAnimationFrame(raf);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lenis.destroy();
      lenisRef.current = null;
    };
  }, [reduceMotion]);

  // Start every screen at its top. The app is a single page, so without this a
  // navigation left the new screen scrolled to wherever the last one was --
  // land on a short page halfway down, or on a long one at a position that
  // belonged to a different page. Jump (never animate) to the top on each route
  // change, through Lenis when it is running so its internal position stays in
  // sync, and through the window otherwise.
  useEffect(() => {
    const lenis = lenisRef.current;
    if (lenis) {
      lenis.scrollTo(0, { immediate: true });
    } else if (typeof window !== 'undefined') {
      window.scrollTo(0, 0);
    }
  }, [location]);

  return <>{children}</>;
}
