import { ReactNode } from "react";
import { useLocation } from "wouter";

/**
 * A short, subtle entrance on each route change, so a screen arrives rather
 * than snaps into place. Keying a wrapper on the current path remounts it on
 * every navigation, which replays the `route-transition` CSS animation
 * (index.css): a ~160ms fade with a few pixels of upward travel.
 *
 * The animation is defined under `@media (prefers-reduced-motion: no-preference)`
 * only, so anyone who has asked for less motion gets the new screen at full
 * opacity immediately, with no movement. It is CSS, not a JS animation, so it
 * costs nothing on the main thread and never blocks the content from painting.
 */
export default function RouteTransition({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return (
    <div key={location} className="route-transition">
      {children}
    </div>
  );
}
