import { useEffect, useState, useMemo } from "react";
import { motion, useScroll, useTransform, useSpring } from "framer-motion";

// Animated particle field - creates depth and movement
const ParticleField = ({ scrollY }: { scrollY: any }) => {
  // Memoize particles to prevent regeneration on every render
  const particles = useMemo(() => 
    Array.from({ length: 150 }, (_, i) => {
      const randomX = Math.random() * 100;
      const randomY = Math.random() * 100;
      const randomSize = 1 + Math.random() * 3;
      const randomDuration = 8 + Math.random() * 15;
      const randomDelay = Math.random() * 8;
      const layer = Math.floor(i / 50); // 3 layers for depth
      
      return {
        id: i,
        x: randomX,
        y: randomY,
        size: randomSize,
        duration: randomDuration,
        delay: randomDelay,
        layer,
        opacity: 0.2 + (layer * 0.15),
      };
    }), []);

  const y1 = useTransform(scrollY, [0, 1000], [0, 100]);
  const y2 = useTransform(scrollY, [0, 1000], [0, 200]);
  const y3 = useTransform(scrollY, [0, 1000], [0, 300]);

  const getYTransform = (layer: number) => {
    if (layer === 0) return y1;
    if (layer === 1) return y2;
    return y3;
  };

  return (
    <motion.div className="absolute inset-0 overflow-hidden">
      {particles.map((particle) => {
        const scrollY = getYTransform(particle.layer);
        
        return (
          <motion.div
            key={particle.id}
            className="absolute rounded-full bg-gradient-to-br from-cyan/40 to-magenta/30 blur-[1px]"
            style={{
              left: `${particle.x}%`,
              top: `${particle.y}%`,
              width: `${particle.size}px`,
              height: `${particle.size}px`,
              y: scrollY,
            }}
            animate={{
              x: [-15, 15, -15],
              scale: [1, 1.3, 1],
              opacity: [particle.opacity, particle.opacity * 1.5, particle.opacity],
            }}
            transition={{
              duration: particle.duration,
              repeat: Infinity,
              delay: particle.delay,
              ease: "easeInOut",
            }}
          />
        );
      })}
    </motion.div>
  );
};

// Flowing geometric grid with perspective
const GeometricGrid = ({ scrollY }: { scrollY: any }) => {
  const gridY = useTransform(scrollY, [0, 2000], [0, 400]);

  return (
    <motion.div 
      className="absolute inset-0 overflow-hidden"
      style={{ y: gridY }}
    >
      <svg className="w-full h-full opacity-15" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="gridGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgb(6, 182, 212)" stopOpacity="0.05" />
            <stop offset="50%" stopColor="rgb(6, 182, 212)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(236, 72, 153)" stopOpacity="0.1" />
          </linearGradient>
          
          <pattern id="smallGrid" width="30" height="30" patternUnits="userSpaceOnUse">
            <path d="M 30 0 L 0 0 0 30" fill="none" stroke="rgb(6, 182, 212)" strokeWidth="0.3" opacity="0.4" />
          </pattern>
          
          <pattern id="grid" width="150" height="150" patternUnits="userSpaceOnUse">
            <rect width="150" height="150" fill="url(#smallGrid)" />
            <path d="M 150 0 L 0 0 0 150" fill="none" stroke="rgb(6, 182, 212)" strokeWidth="1" opacity="0.6" />
          </pattern>
        </defs>
        
        <rect width="100%" height="100%" fill="url(#grid)" />
        
        {/* Animated grid lines */}
        {Array.from({ length: 12 }).map((_, i) => (
          <motion.line
            key={`h-${i}`}
            x1="0"
            y1={`${i * 10}%`}
            x2="100%"
            y2={`${i * 10}%`}
            stroke="url(#gridGrad)"
            strokeWidth="0.5"
            animate={{
              opacity: [0.1, 0.4, 0.1],
              strokeWidth: [0.5, 1, 0.5],
            }}
            transition={{
              duration: 5 + i * 0.3,
              repeat: Infinity,
              delay: i * 0.2,
              ease: "easeInOut",
            }}
          />
        ))}
        
        {Array.from({ length: 12 }).map((_, i) => (
          <motion.line
            key={`v-${i}`}
            x1={`${i * 10}%`}
            y1="0"
            x2={`${i * 10}%`}
            y2="100%"
            stroke="url(#gridGrad)"
            strokeWidth="0.5"
            animate={{
              opacity: [0.1, 0.3, 0.1],
            }}
            transition={{
              duration: 6 + i * 0.2,
              repeat: Infinity,
              delay: i * 0.3,
              ease: "easeInOut",
            }}
          />
        ))}
      </svg>
    </motion.div>
  );
};

// Floating 3D-like geometric shapes - Fixed SVG attributes
const FloatingGeometry = ({ scrollY, mouseX, mouseY }: { scrollY: any; mouseX: number; mouseY: number }) => {
  const [dimensions, setDimensions] = useState({ width: 1920, height: 1080 });

  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({ width: window.innerWidth, height: window.innerHeight });
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  const shapes = [
    { type: 'circle', x: 0.15, y: 0.20, size: 120, color: 'cyan', rotation: 0 },
    { type: 'polygon', x: 0.75, y: 0.35, size: 100, color: 'magenta', rotation: 0 },
    { type: 'rect', x: 0.45, y: 0.70, size: 80, color: 'purple', rotation: 45 },
    { type: 'circle', x: 0.85, y: 0.75, size: 90, color: 'cyan', rotation: 0 },
    { type: 'polygon', x: 0.25, y: 0.60, size: 70, color: 'magenta', rotation: 30 },
  ];

  const y = useTransform(scrollY, [0, 1500], [0, -250]);

  return (
    <motion.div className="absolute inset-0 overflow-hidden" style={{ y }}>
      <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          
          <linearGradient id="cyanGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgb(6, 182, 212)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(6, 182, 212)" stopOpacity="0.1" />
          </linearGradient>
          
          <linearGradient id="magentaGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgb(236, 72, 153)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(236, 72, 153)" stopOpacity="0.1" />
          </linearGradient>
          
          <linearGradient id="purpleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgb(168, 85, 247)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(168, 85, 247)" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        
        {shapes.map((shape, i) => {
          const absoluteX = shape.x * dimensions.width;
          const absoluteY = shape.y * dimensions.height;
          const parallaxX = (mouseX - 0.5) * (20 + i * 5);
          const parallaxY = (mouseY - 0.5) * (20 + i * 5);
          
          if (shape.type === 'circle') {
            return (
              <motion.circle
                key={i}
                cx={absoluteX}
                cy={absoluteY}
                r={shape.size / 2}
                fill={`url(#${shape.color}Grad)`}
                stroke={shape.color === 'cyan' ? 'rgb(6, 182, 212)' : 'rgb(236, 72, 153)'}
                strokeWidth="2"
                filter="url(#glow)"
                animate={{
                  r: [shape.size / 2, shape.size / 2 + 15, shape.size / 2],
                  opacity: [0.3, 0.6, 0.3],
                  cx: [absoluteX + parallaxX, absoluteX + parallaxX + 10, absoluteX + parallaxX],
                  cy: [absoluteY + parallaxY, absoluteY + parallaxY - 10, absoluteY + parallaxY],
                }}
                transition={{
                  duration: 8 + i * 2,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: i * 0.5,
                }}
              />
            );
          }
          
          if (shape.type === 'polygon') {
            const points = Array.from({ length: 6 }, (_, j) => {
              const angle = (j / 6) * Math.PI * 2;
              const r = shape.size / 2;
              return `${absoluteX + r * Math.cos(angle)},${absoluteY + r * Math.sin(angle)}`;
            }).join(' ');
            
            return (
              <motion.polygon
                key={i}
                points={points}
                fill={`url(#${shape.color}Grad)`}
                stroke={shape.color === 'magenta' ? 'rgb(236, 72, 153)' : 'rgb(168, 85, 247)'}
                strokeWidth="2"
                filter="url(#glow)"
                style={{
                  transformOrigin: `${absoluteX}px ${absoluteY}px`,
                }}
                animate={{
                  rotate: [shape.rotation, shape.rotation + 360],
                  scale: [1, 1.15, 1],
                  opacity: [0.3, 0.5, 0.3],
                }}
                transition={{
                  duration: 12 + i,
                  repeat: Infinity,
                  ease: "linear",
                  delay: i * 0.7,
                }}
              />
            );
          }
          
          return (
            <motion.rect
              key={i}
              x={absoluteX - shape.size / 2}
              y={absoluteY - shape.size / 2}
              width={shape.size}
              height={shape.size}
              fill={`url(#${shape.color}Grad)`}
              stroke="rgb(168, 85, 247)"
              strokeWidth="2"
              filter="url(#glow)"
              style={{
                transformOrigin: `${absoluteX}px ${absoluteY}px`,
              }}
              animate={{
                rotate: [shape.rotation, shape.rotation + 180, shape.rotation + 360],
                scale: [1, 1.1, 1],
                opacity: [0.3, 0.5, 0.3],
              }}
              transition={{
                duration: 10 + i,
                repeat: Infinity,
                ease: "easeInOut",
                delay: i * 0.6,
              }}
            />
          );
        })}
      </svg>
    </motion.div>
  );
};

// Animated gradient orbs with 3D depth
const GradientOrbs = ({ scrollY }: { scrollY: any }) => {
  const orb1Y = useTransform(scrollY, [0, 1500], [0, -150]);
  const orb2Y = useTransform(scrollY, [0, 1500], [0, -250]);
  const orb3Y = useTransform(scrollY, [0, 1500], [0, -200]);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <motion.div 
        className="absolute top-[10%] left-[15%] w-[500px] h-[500px] bg-cyan/20 rounded-full blur-[120px]"
        style={{ y: orb1Y }}
        animate={{
          scale: [1, 1.3, 1],
          opacity: [0.2, 0.4, 0.2],
          x: [-50, 50, -50],
        }}
        transition={{
          duration: 20,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      
      <motion.div 
        className="absolute top-[60%] right-[10%] w-[600px] h-[600px] bg-magenta/15 rounded-full blur-[140px]"
        style={{ y: orb2Y }}
        animate={{
          scale: [1, 1.4, 1],
          opacity: [0.15, 0.35, 0.15],
          x: [50, -50, 50],
        }}
        transition={{
          duration: 25,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 2,
        }}
      />
      
      <motion.div 
        className="absolute bottom-[20%] left-[40%] w-[700px] h-[700px] bg-purple/10 rounded-full blur-[160px]"
        style={{ y: orb3Y }}
        animate={{
          scale: [1, 1.2, 1],
          opacity: [0.1, 0.3, 0.1],
          rotate: [0, 180, 360],
        }}
        transition={{
          duration: 30,
          repeat: Infinity,
          ease: "linear",
        }}
      />
    </div>
  );
};

// Sound visualizer
const SoundVisualizer = () => {
  // Memoize bar configurations to prevent re-randomization
  const barConfigs = useMemo(() => 
    Array.from({ length: 5 }, (_, i) => ({
      id: i,
      minHeight: 10 + Math.random() * 10,
      maxHeight: 30 + Math.random() * 40,
      duration: 0.5 + Math.random() * 0.5,
      delay: i * 0.1,
    })), []);

  return (
    <div className="absolute bottom-8 left-8 flex items-end gap-1.5 opacity-40" data-testid="sound-visualizer">
      {barConfigs.map((config) => (
        <motion.div
          key={config.id}
          className="bg-gradient-to-t from-cyan/60 to-cyan/20 rounded-t-sm"
          style={{ width: '8px', minHeight: '4px' }}
          animate={{
            height: [`${config.minHeight}px`, `${config.maxHeight}px`, `${config.minHeight}px`],
          }}
          transition={{
            duration: config.duration,
            repeat: Infinity,
            delay: config.delay,
            ease: "easeInOut",
          }}
        />
      ))}
    </div>
  );
};

// Spinning rings
const SpinningRings = () => (
  <div className="absolute top-8 left-8 opacity-30" data-testid="spinning-rings">
    <motion.div className="absolute inset-0 w-24 h-24 rounded-full border-2 border-cyan/40" animate={{ rotate: 360 }} transition={{ duration: 8, repeat: Infinity, ease: "linear" }} style={{ borderStyle: 'dashed' }} />
    <motion.div className="absolute inset-0 w-24 h-24 rounded-full border border-magenta/40" animate={{ rotate: -360 }} transition={{ duration: 12, repeat: Infinity, ease: "linear" }} style={{ transform: 'scale(0.7)', borderStyle: 'dotted' }} />
    <motion.div className="absolute inset-0 w-24 h-24 rounded-full border border-primary/40" animate={{ rotate: 360 }} transition={{ duration: 5, repeat: Infinity, ease: "linear" }} style={{ transform: 'scale(0.4)' }} />
    <motion.div className="absolute inset-0 w-24 h-24 flex items-center justify-center">
      <motion.div className="w-2 h-2 rounded-full bg-cyan/60" animate={{ scale: [1, 1.5, 1], opacity: [0.6, 1, 0.6] }} transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }} />
    </motion.div>
  </div>
);

// AI Brain Map
const AIBrainMap = ({ scrollY, mouseX, mouseY }: { scrollY: any; mouseX: number; mouseY: number }) => {
  const nodes = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2;
    const radius = 80;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, index: i };
  });

  const scrollOffsetX = useTransform(scrollY, [0, 1000], [0, 30]);
  const scrollOffsetY = useTransform(scrollY, [0, 1000], [0, -20]);
  const cursorParallaxX = useSpring((mouseX - 0.5) * 30, { stiffness: 100, damping: 20 });
  const cursorParallaxY = useSpring((mouseY - 0.5) * 30, { stiffness: 100, damping: 20 });
  const glowScale = useSpring(0.9 + mouseX * 0.4, { stiffness: 150, damping: 25 });

  return (
    <motion.div className="absolute top-1/2 left-1/2 opacity-20 pointer-events-none" style={{ x: scrollOffsetX, y: scrollOffsetY }} data-testid="ai-brain-map">
      <motion.div style={{ x: cursorParallaxX, y: cursorParallaxY }}>
        <svg width="400" height="400" viewBox="-200 -200 400 400" className="overflow-visible">
          {nodes.map((node, i) => nodes.slice(i + 1).map((target, j) => (
            <motion.line key={`${i}-${j}`} x1={node.x} y1={node.y} x2={target.x} y2={target.y} stroke="url(#brainGrad)" strokeWidth="0.5"
              animate={{ opacity: [0.1, 0.3, 0.1], strokeWidth: [0.5, 1, 0.5] }}
              transition={{ duration: 3 + Math.random() * 2, repeat: Infinity, delay: Math.random() * 2, ease: "easeInOut" }}
            />
          )))}
          {nodes.map((node, i) => (
            <motion.g key={i}>
              <motion.circle cx={node.x} cy={node.y} r="3" fill="currentColor" className="text-cyan"
                animate={{ r: [3, 5, 3], opacity: [0.4, 0.8, 0.4] }}
                transition={{ duration: 2 + Math.random(), repeat: Infinity, delay: i * 0.2, ease: "easeInOut" }}
              />
              <motion.circle cx={node.x} cy={node.y} r="3" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-magenta"
                animate={{ r: [3, 12, 3], opacity: [0.6, 0, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, delay: i * 0.15, ease: "easeOut" }}
              />
            </motion.g>
          ))}
          <motion.circle cx="0" cy="0" r="8" fill="url(#coreGrad)"
            animate={{ r: [8, 12, 8], opacity: [0.6, 0.9, 0.6] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />
          <defs>
            <linearGradient id="brainGrad"><stop offset="0%" stopColor="rgb(6, 182, 212)" stopOpacity="0.3" /><stop offset="100%" stopColor="rgb(236, 72, 153)" stopOpacity="0.3" /></linearGradient>
            <radialGradient id="coreGrad"><stop offset="0%" stopColor="rgb(6, 182, 212)" stopOpacity="0.8" /><stop offset="100%" stopColor="rgb(236, 72, 153)" stopOpacity="0.4" /></radialGradient>
          </defs>
        </svg>
        <motion.div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full blur-[80px]" style={{ scale: glowScale }}
          animate={{ background: ['radial-gradient(circle, rgba(6,182,212,0.2) 0%, transparent 70%)', 'radial-gradient(circle, rgba(236,72,153,0.2) 0%, transparent 70%)', 'radial-gradient(circle, rgba(6,182,212,0.2) 0%, transparent 70%)'] }}
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>
    </motion.div>
  );
};

export default function HolographicBackground() {
  const [mousePosition, setMousePosition] = useState({ x: 0.5, y: 0.5 });
  const { scrollY } = useScroll();

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({
        x: e.clientX / window.innerWidth,
        y: e.clientY / window.innerHeight,
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-background">
      {/* Gradient base */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background/95 to-background" />
      
      {/* 3D-like elements with depth */}
      <GradientOrbs scrollY={scrollY} />
      <GeometricGrid scrollY={scrollY} />
      <FloatingGeometry scrollY={scrollY} mouseX={mousePosition.x} mouseY={mousePosition.y} />
      <ParticleField scrollY={scrollY} />
      
      {/* Interactive UI elements */}
      <SoundVisualizer />
      <SpinningRings />
      <AIBrainMap scrollY={scrollY} mouseX={mousePosition.x} mouseY={mousePosition.y} />
      
      {/* Vignette overlay */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_0%,_var(--background)_100%)] opacity-60 pointer-events-none" />
    </div>
  );
}
