/**
 * The banner every Mythos page opens with: a serif title and a one-line creed
 * over a warm temple ground, with a right-hand rail of the four verbs and the
 * "greater clarity" sign-off.
 *
 * The temple is a real plate now -- a bank of lit marble halls in gold on
 * obsidian, one per page mood -- sat behind the copy and scrimmed on the left
 * so the title always reads. Pass `background` to pick the hall.
 */
import { ReactNode } from "react";
import templeVista from "@assets/mythos/temple-vista.webp";
import templeSunburst from "@assets/mythos/temple-sunburst.webp";
import templeStorm from "@assets/mythos/temple-storm.webp";
import templeLibrary from "@assets/mythos/temple-library.webp";
import templeOwlSeal from "@assets/mythos/temple-owl-seal.webp";
import templeCouncil from "@assets/mythos/temple-council.webp";
import templeAstrolabe from "@assets/mythos/temple-astrolabe.webp";

export type HeroBackground =
  | "vista"
  | "sunburst"
  | "storm"
  | "library"
  | "owl-seal"
  | "council"
  | "astrolabe";

const BACKGROUNDS: Record<HeroBackground, string> = {
  vista: templeVista,
  sunburst: templeSunburst,
  storm: templeStorm,
  library: templeLibrary,
  "owl-seal": templeOwlSeal,
  council: templeCouncil,
  astrolabe: templeAstrolabe,
};

interface PageHeroProps {
  title: string;
  subtitle: string;
  /** Which temple hall sits behind the copy. Defaults to the mountain vista. */
  background?: HeroBackground;
  /** The vertical verb rail, e.g. ["Scan","Analyze","Evidence","Deploy"]. */
  verbs?: string[];
  /** The gold sign-off lines, default "Greater / Clarity" + muted "Athena". */
  signoff?: { gold: string[]; muted: string };
  children?: ReactNode;
}

export default function PageHero({
  title,
  subtitle,
  background = "vista",
  verbs,
  signoff = { gold: ["Greater", "Clarity"], muted: "Athena" },
  children,
}: PageHeroProps) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/50">
      {/* temple plate */}
      <img
        src={BACKGROUNDS[background]}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full object-cover object-right"
      />
      {/* scrims: warm ground under the plate, then a left-to-right fade so the
          title reads over the brightest part of the hall */}
      <div className="pointer-events-none absolute inset-0 bg-background/40" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background/70 to-transparent" />

      <div className="relative flex flex-wrap items-start justify-between gap-6 px-6 py-7 md:px-8">
        <div className="max-w-2xl">
          <h1 className="font-serif text-[42px] font-semibold leading-none tracking-tight text-foreground [text-shadow:0_2px_18px_hsl(var(--background)/0.8)]">
            {title}
          </h1>
          <p className="mt-3 text-[15px] text-muted-foreground">{subtitle}</p>
          {children}
        </div>

        <div className="flex items-start gap-8 pt-1">
          {verbs && (
            <ul className="hidden space-y-1 text-[10px] uppercase tracking-[0.24em] text-muted-foreground/70 sm:block">
              {verbs.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          )}
          <div className="space-y-1 border-l border-border/50 pl-8 text-[10px] uppercase tracking-[0.24em]">
            {signoff.gold.map((g) => (
              <p key={g} className="text-gold">
                {g}
              </p>
            ))}
            <p className="pt-1 text-muted-foreground/70">{signoff.muted}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
