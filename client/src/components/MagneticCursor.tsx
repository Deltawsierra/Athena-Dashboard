import { useEffect, useRef, useState } from 'react';
import { motion, useSpring, useMotionValue, useReducedMotion } from 'framer-motion';

export default function MagneticCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const cursorDotRef = useRef<HTMLDivElement>(null);
  // `null` means no stated preference; only an explicit "reduce" turns the
  // custom cursor off. When it is off, index.css restores the native cursor
  // (which this component normally replaces), so the pointer is never lost.
  const reduceMotion = useReducedMotion() === true;

  const cursorX = useMotionValue(0);
  const cursorY = useMotionValue(0);

  // Faster, more responsive spring config
  const springConfig = { damping: 15, stiffness: 500, mass: 0.3 };
  const cursorXSpring = useSpring(cursorX, springConfig);
  const cursorYSpring = useSpring(cursorY, springConfig);

  const dotX = useMotionValue(0);
  const dotY = useMotionValue(0);
  const dotXSpring = useSpring(dotX, { damping: 10, stiffness: 700, mass: 0.2 });
  const dotYSpring = useSpring(dotY, { damping: 10, stiffness: 700, mass: 0.2 });

  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    // No pointer tracking, and no per-move spring work, under reduced motion.
    if (reduceMotion) return;

    const moveCursor = (e: MouseEvent) => {
      cursorX.set(e.clientX);
      cursorY.set(e.clientY);
      dotX.set(e.clientX);
      dotY.set(e.clientY);
    };

    const handleMouseEnter = () => setIsHovering(true);
    const handleMouseLeave = () => setIsHovering(false);

    const interactiveElements = document.querySelectorAll(
      'button, a, input, textarea, select, [role="button"], [data-magnetic], label'
    );

    interactiveElements.forEach((el) => {
      el.addEventListener('mouseenter', handleMouseEnter);
      el.addEventListener('mouseleave', handleMouseLeave);
    });

    window.addEventListener('mousemove', moveCursor);

    return () => {
      window.removeEventListener('mousemove', moveCursor);
      interactiveElements.forEach((el) => {
        el.removeEventListener('mouseenter', handleMouseEnter);
        el.removeEventListener('mouseleave', handleMouseLeave);
      });
    };
  }, [cursorX, cursorY, dotX, dotY, reduceMotion]);

  // Reduced motion: render no custom cursor at all; the native one is shown.
  if (reduceMotion) return null;

  return (
    <>
      {/* Outer ring */}
      <motion.div
        ref={cursorRef}
        data-testid="cursor-ring"
        className="fixed top-0 left-0 pointer-events-none z-[9999]"
        style={{
          x: cursorXSpring,
          y: cursorYSpring,
          translateX: '-50%',
          translateY: '-50%',
        }}
      >
        <motion.div
          className="rounded-full border-2 transition-colors"
          animate={{
            width: isHovering ? 48 : 32,
            height: isHovering ? 48 : 32,
            borderColor: isHovering ? 'rgb(236, 72, 153)' : 'rgb(6, 182, 212)',
            opacity: isHovering ? 0.9 : 0.7,
          }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        />
      </motion.div>

      {/* Center dot */}
      <motion.div
        ref={cursorDotRef}
        data-testid="cursor-dot"
        className="fixed top-0 left-0 pointer-events-none z-[9999]"
        style={{
          x: dotXSpring,
          y: dotYSpring,
          translateX: '-50%',
          translateY: '-50%',
        }}
      >
        <motion.div
          className="rounded-full transition-colors"
          animate={{
            width: isHovering ? 8 : 6,
            height: isHovering ? 8 : 6,
            backgroundColor: isHovering ? 'rgb(236, 72, 153)' : 'rgb(6, 182, 212)',
          }}
          transition={{ duration: 0.15, ease: 'easeOut' }}
        />
      </motion.div>
    </>
  );
}
