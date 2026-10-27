/**
 * The ambient layer behind every screen.
 *
 * A single full-screen quad running one fragment shader: a slow drifting
 * gradient with a faint grid and a vignette. One draw call, no geometry, no
 * lights, no per-frame allocation -- it has to be affordable enough to leave
 * running under every page, on a laptop that is also running a scan.
 *
 * It is deliberately almost invisible. Background that competes with the
 * foreground is a background that makes the numbers harder to read, and the
 * numbers are what somebody is buying.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision mediump float;

  uniform float uTime;
  uniform vec2  uResolution;
  uniform float uAlert;   // 0 = calm, 1 = something needs attention
  varying vec2  vUv;

  // Cheap value noise. Not the prettiest, but it costs three sines and this
  // runs behind everything, every frame, on unknown hardware.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2(uv.x * aspect, uv.y);

    // Two slow drifting fields, out of phase, so the motion never loops
    // visibly on a screen somebody stares at for an hour.
    float drift =
      noise(p * 2.2 + vec2(uTime * 0.020, uTime * -0.014)) * 0.6 +
      noise(p * 4.7 + vec2(uTime * -0.011, uTime * 0.017)) * 0.4;

    vec3 calm  = vec3(0.031, 0.078, 0.114);
    vec3 lift  = vec3(0.043, 0.180, 0.216);
    vec3 alarm = vec3(0.180, 0.035, 0.070);

    vec3 base = mix(calm, lift, smoothstep(0.35, 0.85, drift));
    base = mix(base, alarm, uAlert * 0.5 * smoothstep(0.3, 0.9, drift));

    // A grid, well under the threshold where it reads as a pattern. It exists
    // to give the eye a sense of a surface rather than a void.
    vec2 grid = abs(fract(p * 26.0) - 0.5);
    float line = smoothstep(0.48, 0.5, max(grid.x, grid.y));
    base += line * 0.012;

    // Vignette, so the panels sitting on top always have a darker ground
    // under their edges than at the centre of the screen.
    float d = distance(uv, vec2(0.5));
    base *= 1.0 - smoothstep(0.35, 0.95, d) * 0.55;

    gl_FragColor = vec4(base, 1.0);
  }
`;

function Field({ alert }: { alert: number }) {
  const material = useRef<THREE.ShaderMaterial>(null);
  const { size, viewport } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uAlert: { value: 0 },
    }),
    [],
  );

  useFrame((_, delta) => {
    if (!material.current) return;
    const u = material.current.uniforms;
    u.uTime.value += delta;
    u.uResolution.value.set(size.width, size.height);
    // Eased rather than snapped: the ground turning red instantly is
    // startling, and startling the operator is not the same as informing them.
    u.uAlert.value += (alert - u.uAlert.value) * Math.min(1, delta * 1.5);
  });

  return (
    <mesh scale={[viewport.width, viewport.height, 1]}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={material}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        depthWrite={false}
      />
    </mesh>
  );
}

export interface AmbientFieldProps {
  /** True when something in the estate is critical. Warms the ground. */
  alert?: boolean;
}

/**
 * Whether the dark palette is in force, kept current as the toggle is used.
 *
 * The class is the source of truth rather than a stored preference, because
 * the toggle sets the class directly and a component reading localStorage
 * would be a frame behind it.
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() =>
      setDark(root.classList.contains("dark")),
    );
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export default function AmbientField({ alert = false }: AmbientFieldProps) {
  // Under reduced motion the field is drawn once and then left still: the
  // shader's slow drift is motion, and someone who asked for less of it gets a
  // static ground instead of a per-frame render loop running behind every page.
  const reduceMotion = useReducedMotion() === true;

  // Not drawn in light mode, and this is the reason light mode looked broken:
  // the canvas is `alpha: false`, so it paints an opaque near-black field over
  // the whole viewport at z-index -1. Every token could be light and the page
  // still came out dark, because the body's background was behind this.
  //
  // It is not made translucent instead, because the effect is a dark-ground
  // idea -- a soft glow needs something to glow against. On paper the same
  // shader is a grey smear over the data, which is the opposite of what an
  // instrument wants.
  if (!useIsDark()) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
      }}
    >
      <Canvas
        // Half resolution. It is a soft gradient; nobody can tell, and it
        // leaves the GPU budget for the globe on the page above it.
        dpr={[0.5, 1]}
        // Reduced motion: render on demand (once) rather than every frame, so
        // the drift freezes and nothing animates behind the page.
        frameloop={reduceMotion ? "demand" : "always"}
        gl={{ antialias: false, alpha: false, powerPreference: "low-power" }}
        // No camera work is needed for a full-screen quad, and skipping the
        // default frameloop when nothing is on screen would cost more in
        // complexity than the shader costs to run.
        camera={{ position: [0, 0, 1] }}
      >
        <Field alert={alert ? 1 : 0} />
      </Canvas>
    </div>
  );
}
