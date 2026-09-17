/**
 * The Mythos shell: a fixed left rail of navigation and a top bar of context,
 * with every screen rendered into the panel between them.
 *
 * The rail is the marquee -- the eight destinations a customer is sold on --
 * mapped onto the routes that already exist, so the rename is a rename and not
 * a rebuild. Everything the product also does but does not lead with (the
 * pentest bench, the classifiers, the audit trail) lives under a Tools heading
 * below the fold, reachable and out of the way. Admin-only destinations are not
 * dimmed for everyone else, they are absent -- a link to a page whose API will
 * 403 is a worse experience than no link.
 */
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Boxes,
  FileCheck2,
  AlertTriangle,
  ScrollText,
  Users,
  Settings as SettingsIcon,
  ShieldHalf,
  ShieldAlert,
  ShieldQuestion,
  ListChecks,
  FolderOpen,
  Brain,
  Bug,
  Activity,
  MessageSquare,
  SlidersHorizontal,
  FileText,
  Trash2,
  Search,
  Bell,
  ChevronDown,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { ReactNode } from "react";
import ThemeToggle from "./ThemeToggle";
import { cn } from "@/lib/utils";
import athenaStatue from "@assets/mythos/athena-statue.webp";
import mythosGlyph from "@assets/mythos/mark-glyph.webp";
import navOverview from "@assets/mythos/nav/overview.webp";
import navAthena from "@assets/mythos/nav/athena.webp";
import navDeployments from "@assets/mythos/nav/deployments.webp";
import navEvidence from "@assets/mythos/nav/evidence.webp";
import navRisks from "@assets/mythos/nav/risks.webp";
import navCompliance from "@assets/mythos/nav/compliance.webp";
import navTeams from "@assets/mythos/nav/teams.webp";
import navSettings from "@assets/mythos/nav/settings.webp";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Optional struck-brass icon; falls back to the lucide `icon` when absent. */
  img?: string;
  admin?: boolean;
}

/** The eight the product leads with. Order is the pitch: see it, scan it,
 *  trace the estate, hold the evidence, weigh the risk, prove compliance,
 *  run the team, tune the machine. */
const PRIMARY: NavItem[] = [
  { path: "/dashboard", label: "Overview", icon: LayoutDashboard, img: navOverview },
  { path: "/athena", label: "Athena", icon: ShieldHalf, img: navAthena },
  { path: "/clients", label: "Deployments", icon: Boxes, img: navDeployments },
  { path: "/evidence", label: "Evidence", icon: FileCheck2, img: navEvidence, admin: true },
  { path: "/findings", label: "Risks", icon: AlertTriangle, img: navRisks },
  { path: "/compliance", label: "Compliance", icon: ScrollText, img: navCompliance },
  { path: "/admin", label: "Teams", icon: Users, img: navTeams, admin: true },
  { path: "/settings", label: "Settings", icon: SettingsIcon, img: navSettings, admin: true },
];

/** Everything else the app can do, kept reachable without crowding the pitch. */
const TOOLS: NavItem[] = [
  { path: "/assurance", label: "Assurance", icon: ShieldQuestion },
  { path: "/pentest", label: "Pentest", icon: ShieldHalf },
  { path: "/tests", label: "Tests", icon: ListChecks },
  { path: "/documents", label: "Documents", icon: FolderOpen },
  { path: "/classifiers", label: "Classifiers", icon: Brain },
  { path: "/classify-cve", label: "CVE Classifier", icon: Bug },
  { path: "/ai-health", label: "AI Health", icon: Activity },
  { path: "/ai-chat", label: "AI Chat", icon: MessageSquare },
  { path: "/ai-control", label: "AI Control", icon: SlidersHorizontal, admin: true },
  { path: "/audit-logs", label: "Audit Logs", icon: FileText, admin: true },
  { path: "/deletion", label: "Deletion", icon: Trash2, admin: true },
  { path: "/failsafe", label: "Failsafe", icon: ShieldAlert, admin: true },
];

interface AppShellProps {
  children: ReactNode;
  onLogout: () => void;
  isAdmin: boolean;
  username: string;
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.path}
      data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-surface-1/60 hover:text-foreground",
      )}
    >
        {/* The lit rail. Present on the active row, and a whisper on hover so
            the pointer has something to land on before the click. */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r",
            active
              ? "bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.7)]"
              : "bg-transparent group-hover:bg-primary/40",
          )}
        />
        {item.img ? (
          <img
            src={item.img}
            alt=""
            aria-hidden="true"
            className={cn(
              "h-[22px] w-[22px] shrink-0 select-none object-contain transition-opacity",
              active ? "opacity-100" : "opacity-70 group-hover:opacity-100",
            )}
          />
        ) : (
          <Icon
            className={cn(
              "h-[18px] w-[18px] shrink-0",
              active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
            )}
          />
        )}
        <span className="truncate">{item.label}</span>
    </Link>
  );
}

export default function AppShell({ children, onLogout, isAdmin, username }: AppShellProps) {
  const [location] = useLocation();
  const isActive = (p: string) => location === p || location.startsWith(p + "/");
  const visible = (items: NavItem[]) => items.filter((i) => !i.admin || isAdmin);
  const initials =
    username
      ?.split(/[\s._-]+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "U";

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* ---- Rail --------------------------------------------------------- */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border/60 bg-surface-0/70 backdrop-blur-md md:flex">
        {/* Brand */}
        <Link href="/dashboard" className="flex items-center gap-3 px-5 pb-5 pt-6" data-testid="link-brand">
          <img src={mythosGlyph} alt="" aria-hidden="true" className="h-8 w-8 shrink-0 select-none object-contain" />
          <div className="flex flex-col leading-none">
            <span className="text-[17px] font-semibold tracking-[0.18em] text-foreground">
              MYTHOS
            </span>
          </div>
        </Link>
        <p className="px-5 pb-5 text-[10px] uppercase leading-relaxed tracking-[0.22em] text-muted-foreground/70">
          AI security for
          <br />a more human tomorrow.
        </p>

        {/* Nav */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {visible(PRIMARY).map((item) => (
            <NavRow key={item.path} item={item} active={isActive(item.path)} />
          ))}

          <p className="athena-label px-3 pb-1 pt-5">Tools</p>
          {visible(TOOLS).map((item) => (
            <NavRow key={item.path} item={item} active={isActive(item.path)} />
          ))}
        </nav>

        {/* Emblem + creed */}
        <div className="relative overflow-hidden border-t border-border/40 px-5 py-6">
          <img
            src={athenaStatue}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-8 -right-6 h-40 w-auto opacity-[0.22] [mask-image:linear-gradient(to_top,transparent,black_45%)]"
          />
          <div className="relative flex flex-col gap-1 text-[10px] uppercase tracking-[0.22em] text-muted-foreground/60">
            <span>Wisdom</span>
            <span>finds</span>
            <span className="text-gold-dim">a safer path.</span>
          </div>
        </div>
      </aside>

      {/* ---- Column ------------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-40 flex h-16 items-center gap-4 border-b border-border/60 bg-background/80 px-4 backdrop-blur-md md:px-6">
          {/* Search */}
          <label className="relative hidden max-w-md flex-1 items-center sm:flex">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search deployments, scans, or findings…"
              className="h-9 w-full rounded-lg border border-border/70 bg-surface-1/50 pl-9 pr-14 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
              data-testid="input-global-search"
            />
            <kbd className="pointer-events-none absolute right-3 hidden items-center gap-1 rounded border border-border/70 bg-surface-2/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground lg:flex">
              ⌘K
            </kbd>
          </label>

          <div className="ml-auto flex items-center gap-2 md:gap-3">
            {/* Org switcher */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface-1/50 px-3 py-1.5 text-left hover:border-primary/50"
                  data-testid="button-org-switcher"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded bg-primary/15 text-[11px] font-semibold text-primary">
                    AF
                  </span>
                  <span className="hidden flex-col leading-tight sm:flex">
                    <span className="text-xs font-medium text-foreground">Acme Financial</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Enterprise
                    </span>
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                <DropdownMenuItem>Acme Financial</DropdownMenuItem>
                <DropdownMenuItem className="text-muted-foreground">
                  Add organization…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <ThemeToggle />

            {/* Notifications */}
            <button
              className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-border/70 bg-surface-1/50 text-muted-foreground hover:border-primary/50 hover:text-foreground"
              aria-label="Notifications"
              data-testid="button-notifications"
            >
              <Bell className="h-[18px] w-[18px]" />
              <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.9)]" />
            </button>

            {/* Account */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-gold-dim/50 bg-gradient-to-br from-primary/25 to-surface-2 text-xs font-semibold text-foreground"
                  data-testid="button-account"
                >
                  {initials}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="truncate">{username}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <Link href="/settings">
                  <DropdownMenuItem>Settings</DropdownMenuItem>
                </Link>
                <DropdownMenuItem onClick={onLogout} data-testid="button-logout">
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page */}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
