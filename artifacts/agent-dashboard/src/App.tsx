import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import Papa from "papaparse";
import companyLogo from "./assets/company-logo.jpeg";
import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from "framer-motion";
import { createContext, useContext, Fragment, useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  RefreshCw,
  Rocket,
  Search,
  Calendar,
  Phone,
  Clock,
  CalendarDays,
  Users,
  Download,
  Lock,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Info,
  ChevronLeft,
  ChevronRight,
  PhoneCall,
  LogOut,
  Upload,
  ShieldCheck,
  UserCog,
  Eye,
  EyeOff,
  Pencil,
  ShieldAlert,
  X,
  Plus,
  KeyRound,
  UserCheck,
  UserX,
  Trash2,
  PhoneOff,
  Filter,
  Moon,
  MessageCircle,
  Send,
  Sun,
  Sparkles,
  Paperclip,
  Minimize2,
  Maximize2,
  ChevronDown,
  Activity,
  BarChart3,
  TrendingUp,
  CheckCircle2,
  Wrench,
  Layers,
  XCircle,
  Receipt,
  FileSpreadsheet,
  Loader2,
  ArrowLeftRight,
  MoreVertical,
  type LucideIcon,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend as RLegend,
} from "recharts";
import { OnboardingPanel } from "./OnboardingPanel";

type ThemeMode = "light" | "dark";

const ThemeContext = createContext<{
  theme: ThemeMode;
  toggleTheme: () => void;
} | null>(null);

function getInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem("backend-tracker-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [hasSavedPreference, setHasSavedPreference] = useState(() => {
    if (typeof window === "undefined") return false;
    const saved = window.localStorage.getItem("backend-tracker-theme");
    return saved === "light" || saved === "dark";
  });

  useEffect(() => {
    applyTheme(theme);
    if (hasSavedPreference) {
      window.localStorage.setItem("backend-tracker-theme", theme);
    }
  }, [hasSavedPreference, theme]);

  useEffect(() => {
    if (hasSavedPreference) return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? "light" : "dark");
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [hasSavedPreference]);

  const toggleTheme = useCallback(() => {
    setHasSavedPreference(true);
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function useThemeMode() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useThemeMode must be used within ThemeProvider");
  return context;
}

function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useThemeMode();
  const isDark = theme === "dark";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-secondary text-secondary-foreground shadow-xs",
            className,
          )}
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{isDark ? "Light mode" : "Dark mode"}</TooltipContent>
    </Tooltip>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

// ─── Auth Context ────────────────────────────────────────────────────────────

type Permission = "view_metrics" | "view_attendance" | "edit_attendance" | "manage_members" | "view_missed_tables";
const ALL_PERMISSIONS: { key: Permission; label: string; desc: string }[] = [
  { key: "view_metrics",      label: "View Metrics",        desc: "See Retention, NSF, CS & Quo Lines tabs" },
  { key: "view_attendance",   label: "View Attendance",     desc: "See the Attendance grid" },
  { key: "edit_attendance",   label: "Edit Attendance",     desc: "Click cells to mark status & add notes" },
  { key: "manage_members",    label: "Manage Members",      desc: "Add, edit, or remove attendance members" },
  { key: "view_missed_tables", label: "View Missed Tables", desc: "See Today's Missed by Hour and Daily Missed history (managers only)" },
];

const ALL_TABS: { value: string; label: string }[] = [
  { value: "backend-stats",   label: "Backend Statistics" },
  { value: "retention",       label: "Retention" },
  { value: "cs",              label: "Internal CS" },
  { value: "nsf",             label: "NSF" },
  { value: "rmk",             label: "Ready-Mode Killers" },
  { value: "missed-no-cb",    label: "Missed / No CB" },
  { value: "callback-review", label: "CB Review" },
  { value: "violations",      label: "Violations" },
  { value: "qa",              label: "Retention QA" },
  { value: "onboarding",      label: "Onboarding" },
];

const TAB_ICONS: Record<string, LucideIcon> = {
  retention:         ShieldCheck,
  cs:                MessageCircle,
  nsf:               Receipt,
  rmk:               Rocket,
  "missed-no-cb":    PhoneMissed,
  "callback-review": PhoneCall,
  violations:        ShieldAlert,
  qa:                CheckCircle2,
  onboarding:        UserCheck,
};

const TAB_EMOJIS: Record<string, string> = {
  retention: "🛡️",
  cs: "💬",
  nsf: "🧾",
  rmk: "🚀",
  "missed-no-cb": "☎️",
  "callback-review": "🔁",
  violations: "⚠️",
  qa: "✅",
  onboarding: "👋",
};

type AnimatedSelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  icon?: LucideIcon;
  emoji?: string;
};

function AnimatedDashboardSelect<T extends string>({
  value,
  options,
  onChange,
  label = "Choose view",
  className,
}: {
  value: T;
  options: AnimatedSelectOption<T>[];
  onChange: (value: T) => void;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const selected = options.find((item) => item.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <MotionConfig
      transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 28 }}
    >
      <div ref={ref} className={cn("relative z-[120]", className)}>
        <motion.button
          type="button"
          layoutId="dashboard-view-dropdown"
          onClick={() => setOpen((current) => !current)}
          whileTap={shouldReduceMotion ? undefined : { scale: 0.97 }}
          className="group flex h-10 min-w-[168px] items-center justify-between gap-3 rounded-full border border-border bg-secondary px-3 text-left text-secondary-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={label}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background/70">
              <span className="text-sm leading-none" aria-hidden="true">{selected?.emoji ?? "📌"}</span>
            </span>
            <span className="truncate text-sm font-semibold">{selected?.label}</span>
          </span>
          <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform duration-200", open && "rotate-180")} />
        </motion.button>

        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }}
              className="absolute right-0 top-full z-[130] mt-2 w-[min(400px,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border bg-popover py-2 text-popover-foreground shadow-xl"
              role="listbox"
            >
              <div className="flex items-center justify-between px-4 pb-2 pt-2">
                <strong className="text-sm text-foreground">{label}</strong>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  aria-label="Close view menu"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="max-h-[320px] overflow-y-auto px-1">
                {options.map((item, index) => {
                  const active = item.value === value;
                  return (
                    <motion.button
                      key={item.value}
                      type="button"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 10 }}
                      transition={shouldReduceMotion ? { duration: 0 } : { delay: index * 0.035, duration: 0.22 }}
                      onClick={() => {
                        onChange(item.value);
                        setOpen(false);
                      }}
                      className={cn(
                        "group flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        active && "bg-accent text-accent-foreground",
                      )}
                      role="option"
                      aria-selected={active}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-background/70 transition-transform duration-200 group-hover:scale-105">
                          <span className="text-lg leading-none" aria-hidden="true">{item.emoji ?? "📌"}</span>
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-foreground">{item.label}</span>
                          {item.description && (
                            <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                          )}
                        </span>
                      </span>
                      {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

function AnimatedValueSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  triggerClassName,
  menuClassName,
  align = "left",
  disabled = false,
}: {
  value: T;
  options: AnimatedSelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  align?: "left" | "right";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuRect, setMenuRect] = useState<React.CSSProperties>({});
  const shouldReduceMotion = useReducedMotion();
  const selected = options.find((item) => item.value === value) ?? options[0];

  const updateMenuRect = useCallback(() => {
    const trigger = ref.current?.getBoundingClientRect();
    if (!trigger) return;
    const minWidth = Math.max(trigger.width, 120);
    const left = align === "right"
      ? Math.max(12, Math.min(window.innerWidth - minWidth - 12, trigger.right - minWidth))
      : Math.max(12, Math.min(window.innerWidth - minWidth - 12, trigger.left));
    setMenuRect({
      position: "fixed",
      top: trigger.bottom + 8,
      left,
      minWidth,
      zIndex: 9999,
    });
  }, [align]);

  useEffect(() => {
    if (!open) return;
    updateMenuRect();

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updateMenuRect);
    window.addEventListener("scroll", updateMenuRect, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updateMenuRect);
      window.removeEventListener("scroll", updateMenuRect, true);
    };
  }, [open, updateMenuRect]);

  const menu = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={menuRef}
          data-animated-calendar-menu
          initial={{ opacity: 0, y: -6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.98 }}
          transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.17, ease: "easeOut" }}
          style={menuRect}
          className={cn(
            "max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl",
            menuClassName,
          )}
          role="listbox"
        >
          {options.map((item, index) => {
            const active = item.value === value;
            return (
              <motion.button
                key={item.value}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={shouldReduceMotion ? { duration: 0 } : { delay: index * 0.025, duration: 0.18 }}
                onClick={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  active && "bg-accent text-accent-foreground",
                )}
                role="option"
                aria-selected={active}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {item.emoji && <span className="shrink-0 leading-none" aria-hidden="true">{item.emoji}</span>}
                  <span className="truncate">{item.label}</span>
                </span>
                {active && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </motion.button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <MotionConfig transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 340, damping: 28 }}>
      <div ref={ref} data-animated-select className={cn("relative z-[70] inline-block", className)}>
        <motion.button
          type="button"
          whileTap={shouldReduceMotion ? undefined : { scale: 0.97 }}
          onClick={() => !disabled && setOpen((current) => !current)}
          disabled={disabled}
          className={cn(
            "flex h-8 min-w-[120px] items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 text-left text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            disabled && "cursor-not-allowed opacity-50 hover:bg-card hover:text-foreground",
            triggerClassName,
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {selected?.emoji && <span className="shrink-0 leading-none" aria-hidden="true">{selected.emoji}</span>}
            <span className="truncate">{selected?.label}</span>
          </span>
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200", open && "rotate-180")} />
        </motion.button>
        {typeof document === "undefined" ? menu : createPortal(menu, document.body)}
      </div>
    </MotionConfig>
  );
}

const AVATAR_PALETTES = [
  "from-rose-500 to-orange-400",
  "from-amber-400 to-lime-500",
  "from-emerald-400 to-teal-500",
  "from-sky-400 to-blue-500",
  "from-violet-400 to-fuchsia-500",
  "from-pink-400 to-rose-500",
  "from-cyan-400 to-indigo-500",
  "from-stone-400 to-zinc-600",
];

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function personInitials(name: string) {
  const clean = name.replace(/[^a-zA-Z0-9\s-]/g, " ").trim();
  const parts = clean.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function AvatarIcon({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const palette = AVATAR_PALETTES[hashString(name || "user") % AVATAR_PALETTES.length];
  const sizeClass =
    size === "xs" ? "h-6 w-6 text-[10px]" :
    size === "sm" ? "h-7 w-7 text-[11px]" :
    size === "lg" ? "h-10 w-10 text-sm" :
                    "h-8 w-8 text-xs";

  return (
    <motion.span
      initial={{ scale: 0.82, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 350, damping: 28 }}
      className={cn(
        "avatar-initial inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white shadow-sm ring-1 ring-white/15",
        palette,
        sizeClass,
        className,
      )}
      aria-hidden="true"
    >
      {personInitials(name)}
    </motion.span>
  );
}

function AvatarName({
  name,
  subtitle,
  size = "md",
  className,
  textClassName,
  subtitleClassName,
}: {
  name: string;
  subtitle?: React.ReactNode;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  textClassName?: string;
  subtitleClassName?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <AvatarIcon name={name} size={size} />
      <span className="min-w-0">
        <span className={cn("block truncate", textClassName)}>{name}</span>
        {subtitle && <span className={cn("block truncate text-xs text-muted-foreground", subtitleClassName)}>{subtitle}</span>}
      </span>
    </span>
  );
}

function AnimatedMetricsNav({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="w-full overflow-x-auto pb-1">
      <div className="ops-panel flex w-full min-w-[960px] items-stretch rounded-xl p-1 backdrop-blur">
        {tabs.map((tab) => {
          const emoji = TAB_EMOJIS[tab.value] ?? "📌";
          const active = tab.value === value;
          return (
            <button
              key={tab.value}
              type="button"
              data-testid={`tab-${tab.value}`}
              onClick={() => onChange(tab.value)}
              className={cn(
                "relative flex min-h-12 flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active ? "text-primary-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              aria-pressed={active}
            >
              {active && (
                <motion.span
                  layoutId="metrics-tab-active"
                  className="absolute inset-0 rounded-lg bg-primary shadow-[0_0_24px_rgba(52,211,153,.18)]"
                  transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <span className="relative z-10 flex min-w-0 items-center justify-center gap-2">
                <span className="text-base leading-none" aria-hidden="true">{emoji}</span>
                <span className="truncate">{tab.label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

type TeamAccess = "retention" | "nsf" | "cs";
interface AuthUser { id: number; username: string; role: "admin" | "edit" | "view"; permissions: Permission[]; teamAccess?: TeamAccess | null; allowedTabs?: string[] | null; allowedAgents?: string[] | null; allowedSubTabs?: string[] | null; lockToToday?: boolean; hideBackendStats?: boolean; }
interface AuthCtx { user: AuthUser; token: string; logout: () => void; can: (p: Permission) => boolean; canSeeTab: (tab: string) => boolean; }
const UserContext = createContext<AuthCtx | null>(null);
function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used inside LoginGate");
  return ctx;
}
function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

// ─── Roster Context ──────────────────────────────────────────────────────────
// The team roster (`team_agents` DB table) is the canonical identity registry.
// Adding an agent here automatically makes them appear in Google Sheets matching
// AND OpenPhone/PBX call matching — no code change required.

type RosterTeam = "retention" | "nsf" | "cs" | "killers";
interface RosterAgent { id: number; name: string; arabicName: string | null; shift: string | null; team: RosterTeam; active: boolean; notes?: string | null; }
interface RosterIndex {
  agents: RosterAgent[];
  version: number; // bump on any roster mutation; included in React Query keys for invalidation
  teamNames: Record<RosterTeam, Set<string>>;        // normalized name aliases per team (active only) — for "current visibility"
  teamNamesAll: Record<RosterTeam, Set<string>>;     // normalized name aliases per team (active + inactive) — for historical attribution
  phoneAliases: Record<string, string>;              // normalized arabic name → normalized english name (all agents)
  allowlist: Record<RosterTeam, Set<string>>;        // normalized phone keys allowed per team (active only)
  // Reverse lookup table: any normalized name (en or ar, full or compound segment) → roster agent.
  // Includes inactive agents so historical sheet rows still attribute correctly.
  byName: Map<string, RosterAgent>;
  // Sheet-only aliases used by Google Sheets submission names. Kept separate
  // from byName/allowlist so call matching remains unchanged.
  sheetByName: Map<string, RosterAgent>;
  ambiguousSheetNames: Set<string>;
  // Helpers (resolve undefined when the roster has no entry for that name).
  lookupByAnyName(rawName: string): RosterAgent | null;
  teamForAgent(rawName: string): RosterTeam | null;
  agentsForTeam(team: RosterTeam, opts?: { includeInactive?: boolean }): RosterAgent[];
}

function emptyRosterIndex(): RosterIndex {
  const idx: RosterIndex = {
    agents: [],
    version: 0,
    teamNames: { retention: new Set(), nsf: new Set(), cs: new Set(), killers: new Set() },
    teamNamesAll: { retention: new Set(), nsf: new Set(), cs: new Set(), killers: new Set() },
    phoneAliases: {},
    allowlist: { retention: new Set(), nsf: new Set(), cs: new Set(), killers: new Set() },
    byName: new Map(),
    sheetByName: new Map(),
    ambiguousSheetNames: new Set(),
    lookupByAnyName: () => null,
    teamForAgent: () => null,
    agentsForTeam: () => [],
  };
  return idx;
}

function normalizeSheetAgentName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[\\/|,()[\]]+/g, " ")
    .replace(/[-_]+/g, " ")
    .replace(/\b\d{3,6}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return normalizeAgent(normalized);
}

function sheetAgentCandidates(rawName: string): string[] {
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (!trimmed || /^\d+$/.test(trimmed)) return;
    for (const candidate of [
      normalizeSheetAgentName(trimmed),
      normalizeAgent(trimmed),
      trimmed.toLowerCase(),
    ]) {
      if (candidate && !/^\d+$/.test(candidate)) seen.add(candidate);
    }
  };

  const dashNormalized = rawName.normalize("NFKC").replace(/[‐‑‒–—―]/g, "-");
  add(dashNormalized);
  const noTrailingExtension = dashNormalized.replace(/(?:[-_/|\s]+)\d{3,6}\s*$/g, "");
  if (noTrailingExtension !== dashNormalized) add(noTrailingExtension);
  for (const seg of noTrailingExtension.split(/[-\\/|,()[\]]+/g)) add(seg);
  for (const seg of dashNormalized.split(/[-\\/|,()[\]]+/g)) add(seg);
  return Array.from(seen);
}

function addSheetAlias(idx: RosterIndex, alias: string, agent: RosterAgent) {
  for (const candidate of sheetAgentCandidates(alias)) {
    const existing = idx.sheetByName.get(candidate);
    if (existing && existing.id !== agent.id) {
      idx.ambiguousSheetNames.add(candidate);
      continue;
    }
    if (!idx.ambiguousSheetNames.has(candidate)) idx.sheetByName.set(candidate, agent);
  }
}

function addSheetTeamAliases(target: Set<string>, alias: string) {
  for (const candidate of sheetAgentCandidates(alias)) target.add(candidate);
}

function resolveSheetAgent(rawName: string, roster: RosterIndex): RosterAgent | null {
  if (!rawName) return null;
  const matches = new Map<number, RosterAgent>();
  for (const candidate of sheetAgentCandidates(rawName)) {
    if (roster.ambiguousSheetNames.has(candidate)) continue;
    const hit = roster.sheetByName.get(candidate);
    if (hit) matches.set(hit.id, hit);
  }
  return matches.size === 1 ? Array.from(matches.values())[0] ?? null : null;
}

type SheetAgentDebug = {
  agentColumn?: string | null;
  resolvedTeam?: RosterTeam | null;
  counted?: boolean;
  row?: Row;
};

function sheetCandidateMatchesTeamNames(
  rawName: string,
  teamNames: Set<string>,
  roster?: RosterIndex | null,
  team?: RosterTeam,
  debug?: { source: string; agentColumn?: string | null; row?: Row },
): boolean {
  if (!rawName) return false;
  const candidates = sheetAgentCandidates(rawName);
  const hit = roster ? resolveSheetAgent(rawName, roster) : null;
  if (hit) {
    const counted = !team || hit.team === team;
    if (debug) {
      debugSheetAgentResolution(debug.source, rawName, candidates, hit, counted ? "matched-roster-team" : `resolved-team-${hit.team}-not-${team}`, {
        agentColumn: debug.agentColumn,
        row: debug.row,
        counted,
      });
    }
    return counted;
  }
  const counted = candidates.some((candidate) => teamNames.has(candidate));
  if (debug) {
    debugSheetAgentResolution(debug.source, rawName, candidates, null, counted ? "matched-legacy-team-set" : "not-in-roster-or-team-set", {
      agentColumn: debug.agentColumn,
      row: debug.row,
      counted,
    });
  }
  return counted;
}

function debugSheetAgentResolution(
  source: string,
  rawName: string,
  candidates: string[],
  resolved: RosterAgent | null,
  reason: string,
  details: SheetAgentDebug = {},
) {
  if (typeof window === "undefined") return;
  if (window.localStorage.getItem("debug-sheet-agent-resolution") !== "1") return;
  const isJeremy = /jeremy|romano/i.test(rawName);
  const payload = {
    source,
    rawName,
    agentColumn: details.agentColumn,
    candidates,
    resolved,
    resolvedTeam: details.resolvedTeam ?? resolved?.team ?? null,
    counted: details.counted,
    reason,
    rowAgentName: details.row?.["Agent Name"],
    row: isJeremy ? details.row : undefined,
  };
  const log = resolved && details.counted !== false ? console.info : console.warn;
  log("[sheet-agent-resolution]", payload);
}

function debugUnresolvedSheetAgent(source: string, rawName: string, candidates = sheetAgentCandidates(rawName)) {
  debugSheetAgentResolution(source, rawName, candidates, null, "unresolved");
}

// Roster-backed sheet resolver examples:
// Given roster name "Anna Stone" with arabicName "Anisa", these exact sheet
// "Agent Name" values resolve to Anna Stone: "Anna Stone", "Anisa",
// "Anna Stone / Anisa", "Anisa - Anna Stone", "Anna Stone-Anisa-2382".
// Given roster name "Jeremy Romano", "Jeremy Romano" resolves to Jeremy Romano.
function rosterSheetAliases(agent: RosterAgent): string[] {
  const aliases = [agent.name];
  if (agent.arabicName) {
    aliases.push(
      agent.arabicName,
      `${agent.name} ${agent.arabicName}`,
      `${agent.arabicName} ${agent.name}`,
      `${agent.name} / ${agent.arabicName}`,
      `${agent.arabicName} / ${agent.name}`,
      `${agent.name} - ${agent.arabicName}`,
      `${agent.arabicName} - ${agent.name}`,
      `${agent.name}-${agent.arabicName}`,
      `${agent.arabicName}-${agent.name}`,
      `${agent.name} / ${agent.name} / ${agent.arabicName}`,
    );
  }
  return aliases;
}

function buildRosterIndex(agents: RosterAgent[]): RosterIndex {
  const idx = emptyRosterIndex();
  idx.agents = agents;
  // Mutation-sensitive hash: changes on any add/remove/team/active/name/arabic/shift edit
  // so React Query keys keyed on `version` reliably re-fetch dependent sheet queries.
  idx.version = agents.reduce((acc, a) => {
    const s = `${a.id}|${a.team}|${a.active ? 1 : 0}|${a.name}|${a.arabicName ?? ""}|${a.shift ?? ""}|${a.notes ?? ""}`;
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return (acc + h) | 0;
  }, agents.length);
  for (const a of agents) {
    const enNorm = a.name.replace(/\s+/g, " ").trim().toLowerCase();
    const arNorm = a.arabicName ? a.arabicName.replace(/\s+/g, " ").trim().toLowerCase() : "";
    // Identity mappings (used for historical attribution) include EVERY agent, active or not —
    // so a deactivated person's past sheet rows still attribute to them and their team.
    if (enNorm) {
      idx.teamNamesAll[a.team].add(enNorm);
      idx.byName.set(enNorm, a);
    }
    if (arNorm) {
      idx.teamNamesAll[a.team].add(arNorm);
      idx.byName.set(arNorm, a);
      if (enNorm) idx.phoneAliases[arNorm] = enNorm;
    }
    // Google Sheets examples this resolves without fuzzy matching:
    // "Anna Stone / Anisa", "Anna Stone-Anisa-2382",
    // "Anisa-Anna Stone-2382", and repeated pair forms.
    for (const alias of rosterSheetAliases(a)) {
      addSheetTeamAliases(idx.teamNamesAll[a.team], alias);
      addSheetAlias(idx, alias, a);
    }
    // Active-only sets drive "current visibility" — which agents show up on tiles & phone allowlists.
    if (a.active) {
      if (enNorm) {
        idx.teamNames[a.team].add(enNorm);
        idx.allowlist[a.team].add(enNorm);
      }
      if (arNorm) {
        idx.teamNames[a.team].add(arNorm);
        idx.allowlist[a.team].add(arNorm);
      }
      for (const alias of rosterSheetAliases(a)) {
        addSheetTeamAliases(idx.teamNames[a.team], alias);
      }
    }
  }

  // Bind helpers (use Map closures so call sites get a clean API).
  function norm(s: string): string { return s.replace(/\s+/g, " ").trim().toLowerCase(); }
  idx.lookupByAnyName = (rawName: string): RosterAgent | null => {
    if (!rawName) return null;
    const n = norm(rawName);
    const direct = idx.byName.get(n);
    if (direct) return direct;
    // Compound "Ahmed Ayman-Levi Miller-1234" → try each "-" segment.
    for (const seg of n.split("-").map(s => s.trim()).filter(Boolean)) {
      const hit = idx.byName.get(seg);
      if (hit) return hit;
    }
    return null;
  };
  idx.teamForAgent = (rawName: string): RosterTeam | null => idx.lookupByAnyName(rawName)?.team ?? null;
  idx.agentsForTeam = (team: RosterTeam, opts?: { includeInactive?: boolean }): RosterAgent[] => {
    const includeInactive = opts?.includeInactive ?? false;
    return agents.filter(a => a.team === team && (includeInactive || a.active));
  };
  return idx;
}

const RosterContext = createContext<RosterIndex>(emptyRosterIndex());
function useRoster(): RosterIndex { return useContext(RosterContext); }

function RosterProvider({ children }: { children: React.ReactNode }) {
  const { token } = useUser();
  const q = useQuery<RosterAgent[]>({
    queryKey: ["roster"],
    queryFn: async () => {
      const r = await fetch("/api/team-agents", { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return [];
      return r.json() as Promise<RosterAgent[]>;
    },
    staleTime: 15_000,
    refetchInterval: 30_000, // poll every 30s so new roster entries appear within ~30s
    refetchOnWindowFocus: true,
  });
  const idx = useMemo(() => buildRosterIndex(q.data ?? []), [q.data]);
  return <RosterContext.Provider value={idx}>{children}</RosterContext.Provider>;
}

// Roster-authoritative resolver per team. The AUTHORITY switch is based on
// whether the roster has ANY entries (active or inactive) for this team —
// not on active count. This means once a team has been populated in the
// Roster, the roster is the canonical source of truth, and the hardcoded
// fallback is permanently bypassed. Deactivating the last active agent on
// a team does NOT re-enable the hardcoded fallback (that would silently
// resurrect deactivated historical names).
// The MEMBERSHIP set is always active-only, so deactivating an agent
// symmetrically hides them on the next refresh.
// The hardcoded list is used only as a safety net when the team has zero
// roster rows at all (e.g. fresh DB, before any roster entry has been added).
function unionTeamSet(
  hardcoded: Set<string> | undefined,
  fromRoster: Set<string> | undefined,
  rosterHasAny: boolean,
): Set<string> {
  if (rosterHasAny) return new Set(fromRoster ?? []);
  return new Set(hardcoded ?? []);
}

// Roster-authoritative membership for a team. Authority is based on ANY roster
// entries for the team (active or inactive). Membership is active-only so
// deactivating an agent hides them from sheet matching on the next refresh.
// Note: roster.byName still includes inactive agents so historical sheet rows
// resolve to the correct identity for display, but inactive agents are excluded
// from the team membership set used for filtering.
function rosterTeamMembers(
  hardcoded: Set<string>,
  roster: RosterIndex | null | undefined,
  team: RosterTeam,
): Set<string> {
  // Union of roster + hardcoded. The roster is the source of truth for
  // active membership, but hardcoded sets carry historical English/Arabic
  // aliases and compound Discord-bot submission names (e.g.
  // "youssef nady-jacob xander") that the roster does not enumerate. Bypassing
  // hardcoded names when the roster is populated caused team submissions made
  // under compound aliases to silently drop out of stats.
  const out = new Set<string>(hardcoded);
  if (roster) {
    for (const n of roster.teamNames[team] ?? []) out.add(n);
  }
  return out;
}

// Per-team check: does the roster have ANY entries (active or inactive)?
// When true, the roster is authoritative and hardcoded fallbacks are bypassed.
function rosterHasAnyForTeam(roster: RosterIndex | null | undefined, team: RosterTeam): boolean {
  if (!roster) return false;
  return (roster.teamNamesAll[team]?.size ?? 0) > 0;
}

// Per-team check: is the roster actively driving this team's visible membership?
// Mirrors rosterHasAnyForTeam so callers that gate hardcoded "seed" name lists
// on this signal also bypass the seed when only inactive roster rows exist.
function rosterDrivesTeam(roster: RosterIndex | null | undefined, team: RosterTeam): boolean {
  return rosterHasAnyForTeam(roster, team);
}

const RETENTION = {
  status: "https://docs.google.com/spreadsheets/d/1qF5Dc5quGrAywf5Rtx4q7DrX91VlNIFOfKr-REoSkII/export?format=csv&gid=0",
};
const NEW_RETENTION_URL =
  "https://docs.google.com/spreadsheets/d/1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o/export?format=csv&gid=837339339";
const NEW_NSF_URL =
  "https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=0";
// IDP-Handled submissions tab in the same Discord-bot spreadsheet — all rows count as IDP-Handled.
// Browser fetches of this tab fail silently when fetched concurrently with gid=0 (same spreadsheet).
// Route through the API server proxy so the server fetches it without browser CORS constraints.
const IDP_RETENTION_URL =
  `/api/csv-proxy?url=${encodeURIComponent("https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=871007220")}`;
// IDP Cancel Retained tab — same spreadsheet, fetched sequentially to avoid silent drops.
// Every row counts as "Retained" (file was ultimately retained via the IDP cancel path).
const IDP_CANCEL_RETAINED_URL =
  `/api/csv-proxy?url=${encodeURIComponent("https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=1018337469")}`;
// Records on/after this date come from the new Discord-bot sheets; older records from the old sheets.
const RETENTION_CUTOVER = new Date("2026-05-04T00:00:00");
const NSF = {
  status: "https://docs.google.com/spreadsheets/d/16qoZESE0gGQPdOXQUSh2JsadWDmUE7OyCajRwBy0E38/export?format=csv&gid=0",
};

type Row = Record<string, string>;
type LoadedSheetDebugRow = {
  sourceName: string;
  spreadsheetId: string;
  gid: string;
  tabName: string;
  rawRowIndex: number;
  rawAgentName: string;
  selectedAgentColumn: string;
  rawTimestamp: string;
  selectedDateColumn: string;
  parsedDate: string;
  fileId: string;
  rawStatusUpdateValue: string;
  selectedStatusUpdateColumn: string;
  resolvedCanonicalAgent: string;
  resolvedTeam: string;
  panelTeam: string;
  passedStatusFilter: boolean;
  passedTeamFilter: boolean;
  counted: boolean;
  skipReason: string;
  row: Row;
};
type SheetData = { headers: string[]; rows: Row[]; debugRows?: LoadedSheetDebugRow[] };
type JeremyTraceRow = {
  "source name": string;
  "spreadsheet ID": string;
  gid: string;
  "tab name": string;
  "raw row index": string | number;
  "full raw row JSON": string;
  "raw Agent Name": string;
  "normalized Agent Name": string;
  "raw Timestamp": string;
  "parsed date": string;
  "raw File ID": string;
  "raw status/update": string;
  "matched search term yes/no": "yes" | "no";
  "resolved canonical agent": string;
  "resolved team": string;
  "roster active yes/no": "yes" | "no" | "";
  "current panel/team": string;
  "would pass team filter yes/no": "yes" | "no";
  "would pass date filter yes/no": "yes" | "no";
  "would pass status filter yes/no": "yes" | "no";
  "counted by current loader yes/no": "yes" | "no";
  "exact skip reason": string;
  "exact function where skipped": string;
};
const SHEET_STALE_MS = 30_000;
const SHEET_REFETCH_MS = 60_000;
const PHONE_STALE_MS = 30_000;
const PHONE_REFETCH_MS = 60_000;

const TIMESTAMP_HEADERS = [
  "Timestamp", "Time stamp", "Submitted at", "Created at", "Date",
  "Date/Time", "Submission Time", "Submit Time",
];
const AGENT_HEADERS = [
  "Agent Name", "Agent", "Rep", "Representative", "Employee", "User",
  "Submitted By", "Submitted by",
];
const CANCEL_UPDATE_HEADERS = [
  "Cancel request update", "Cancel Request Update", "Cancel Update",
  "Request Update", "Status", "Update", "Cancel Status",
];
const FILE_ID_HEADERS = ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"];

function normalizeHeaderName(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function findColumnByHeader(headers: string[], candidates: string[]): string | null {
  const normalizedCandidates = new Set(candidates.map(normalizeHeaderName));
  const normalizedHeaders = headers.map((h) => normalizeHeaderName(h));
  for (let i = 0; i < normalizedHeaders.length; i++) {
    if (normalizedCandidates.has(normalizedHeaders[i]!)) return headers[i] ?? null;
  }
  for (let i = 0; i < normalizedHeaders.length; i++) {
    const h = normalizedHeaders[i]!;
    if (candidates.some((c) => h.includes(normalizeHeaderName(c)))) return headers[i] ?? null;
  }
  return null;
}

function sheetAgentColumn(headers: string[]): string | null {
  const exact = headers.find((h) => h.trim() === "Agent Name");
  if (exact) return exact;
  return findColumnByHeader(headers, AGENT_HEADERS);
}

function sheetAgentValue(row: Row, fallbackColumnName: string | null | undefined): string {
  const exact = String(row["Agent Name"] ?? "").trim();
  if (exact) return exact;
  return cell(row, fallbackColumnName);
}

const DATE_HEADERS = [
  "Timestamp", "Date", "Day", "Call Date", "Submitted at", "Created at",
  "Submission Time", "Submit Time",
];
const STATUS_UPDATE_HEADERS = [
  "Cancel request update", "Cancel Request Update", "Cancel Update", "Request Update",
  "File Status", "Status", "Update", "Cancel Status", "Result", "Outcome", "Disposition",
];

function sheetDateColumn(headers: string[]): string | null {
  const exact = headers.find((h) => h.trim() === "Timestamp");
  if (exact) return exact;
  return findColumnByHeader(headers, DATE_HEADERS);
}

function sheetDateValue(row: Row, fallbackColumnName: string | null | undefined): string {
  const exact = String(row["Timestamp"] ?? "").trim();
  if (exact) return exact;
  return cell(row, fallbackColumnName);
}

function parseSheetDate(raw: string, selectedColumn?: string | null): Date | null {
  if (!raw.trim()) return null;
  if (selectedColumn?.trim() === "Timestamp") return parseEgyptTimestamp(raw) ?? parseDate(raw);
  return parseDate(raw) ?? parseEgyptTimestamp(raw);
}

function sheetStatusColumn(headers: string[]): string | null {
  return findColumnByHeader(headers, STATUS_UPDATE_HEADERS);
}

function sheetFileIdColumn(headers: string[]): string | null {
  return findColumnByHeader(headers, FILE_ID_HEADERS);
}

function fallbackColumn(index: number): string {
  return `__col${index}`;
}

function resolveSheetColumn(sheet: SheetData, context: string, field: string, aliases: string[], fallbackIndex: number): string {
  if (field === "Agent Name") {
    const agentColumn = sheetAgentColumn(sheet.headers);
    if (agentColumn) return agentColumn;
  }
  const found = findColumnByHeader(sheet.headers, aliases);
  if (found) return found;
  console.warn(`[backend-stats] ${context}: using column ${String.fromCharCode(65 + fallbackIndex)} fallback for ${field}; header was missing or unclear.`);
  return fallbackColumn(fallbackIndex);
}

function cell(r: Row, col: string | null | undefined): string {
  return col ? String(r[col] ?? "").trim() : "";
}

function isSubmittedRow(r: Row): boolean {
  return Object.entries(r).some(([k, v]) => k.startsWith("__col") && String(v ?? "").trim() !== "");
}

type SheetSourceMeta = {
  sourceName: string;
  spreadsheetId: string;
  gid: string;
  tabName: string;
};

const SHEET_SOURCES = {
  retentionSubmission: {
    sourceName: "Cancelation Requests Updates",
    spreadsheetId: "1Eje6BABFbmRGHa6D1ET2sMvlE8o61iJ71yOvydD-R3o",
    gid: "837339339",
    tabName: "Retention Submission",
  },
  backend: {
    sourceName: "Back-end submissions",
    spreadsheetId: "11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc",
    gid: "0",
    tabName: "backend",
  },
  idpHandled: {
    sourceName: "Back-end submissions",
    spreadsheetId: "11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc",
    gid: "871007220",
    tabName: "idp-handled",
  },
  idpCancelRetained: {
    sourceName: "Back-end submissions",
    spreadsheetId: "11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc",
    gid: "1018337469",
    tabName: "idp-cancel-retained",
  },
} as const satisfies Record<string, SheetSourceMeta>;

function makeLoadedSheetDebugRow(
  sheet: SheetData,
  row: Row,
  rawRowIndex: number,
  meta: SheetSourceMeta,
  panelTeam: RosterTeam | "backend-stats" | "rmk",
  roster: RosterIndex | null | undefined,
  statusOverride?: string,
): LoadedSheetDebugRow {
  const agentCol = sheetAgentColumn(sheet.headers);
  const dateCol = sheetDateColumn(sheet.headers);
  const statusCol = sheetStatusColumn(sheet.headers);
  const fileCol = sheetFileIdColumn(sheet.headers);
  const rawAgentName = sheetAgentValue(row, agentCol);
  const rawTimestamp = sheetDateValue(row, dateCol);
  const parsedDate = parseSheetDate(rawTimestamp, dateCol);
  const rawStatus = statusOverride ?? cell(row, statusCol);
  const resolved = roster && rawAgentName ? resolveSheetAgent(rawAgentName, roster) : null;
  return {
    ...meta,
    rawRowIndex,
    rawAgentName,
    selectedAgentColumn: agentCol ?? "",
    rawTimestamp,
    selectedDateColumn: dateCol ?? "",
    parsedDate: parsedDate ? toIsoDate(parsedDate) : "",
    fileId: cell(row, fileCol),
    rawStatusUpdateValue: rawStatus,
    selectedStatusUpdateColumn: statusCol ?? "",
    resolvedCanonicalAgent: resolved?.name ?? "",
    resolvedTeam: resolved?.team ?? "",
    panelTeam,
    passedStatusFilter: false,
    passedTeamFilter: false,
    counted: false,
    skipReason: "unclassified",
    row,
  };
}

function hasJeremyCell(row: Row, rawAgentName: string): boolean {
  if (/jeremy|romano/i.test(rawAgentName)) return true;
  return Object.values(row).some((value) => /jeremy|romano/i.test(String(value ?? "")));
}

function finishLoadedSheetDebugRow(
  debugRow: LoadedSheetDebugRow,
  patch: Partial<Pick<LoadedSheetDebugRow, "passedStatusFilter" | "passedTeamFilter" | "counted" | "skipReason">>,
): LoadedSheetDebugRow {
  const next = { ...debugRow, ...patch };
  if (
    typeof window !== "undefined" &&
    window.localStorage.getItem("debug-sheet-agent-resolution") === "1" &&
    hasJeremyCell(next.row, next.rawAgentName)
  ) {
    console.warn("[sheet-agent-resolution:loaded-row]", {
      sourceName: next.sourceName,
      spreadsheetId: next.spreadsheetId,
      gid: next.gid,
      tabName: next.tabName,
      rawAgentName: next.rawAgentName,
      rawTimestamp: next.rawTimestamp,
      parsedDate: next.parsedDate,
      resolvedCanonicalAgent: next.resolvedCanonicalAgent,
      resolvedTeam: next.resolvedTeam,
      counted: next.counted,
      skipReason: next.skipReason,
      row: next.row,
    });
  }
  return next;
}

type DebugStatusMode = "retention-update" | "retained-only" | "fixed" | "idp-handled" | "idp-cancel-retained";

function debugRowsForRequiredSheet({
  sheet,
  meta,
  panelTeam,
  roster,
  teamNames,
  statusMode,
}: {
  sheet: SheetData;
  meta: SheetSourceMeta;
  panelTeam: RosterTeam;
  roster: RosterIndex | null | undefined;
  teamNames: Set<string>;
  statusMode: DebugStatusMode;
}): LoadedSheetDebugRow[] {
  const out: LoadedSheetDebugRow[] = [];
  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i]!;
    const kw = detectKeywordStatus(row);
    const derivedStatus =
      statusMode === "fixed" ? (kw ?? "Fixed") :
      statusMode === "idp-handled" ? "IDP-Handled" :
      statusMode === "idp-cancel-retained" ? "Retained" :
      statusMode === "retention-update" ? (kw ?? deriveNewRetentionStatus(row["Cancel request update"] ?? "")) :
      kw ?? cell(row, sheetStatusColumn(sheet.headers));
    const base = makeLoadedSheetDebugRow(sheet, row, i + 2, meta, panelTeam, roster, derivedStatus);
    const parsed = base.parsedDate ? parseDate(base.parsedDate) : null;
    const resolvedTeam = base.resolvedTeam as RosterTeam | "";
    const passedTeamFilter = resolvedTeam
      ? resolvedTeam === panelTeam
      : sheetCandidateMatchesTeamNames(base.rawAgentName, teamNames, roster, panelTeam);
    const passedStatusFilter =
      statusMode === "retained-only" ? isRetainedStatus(derivedStatus) :
      statusMode === "retention-update" ? !!derivedStatus :
      true;
    let skipReason = "counted";
    if (!base.rawAgentName) skipReason = "missing-agent-name";
    else if (!base.rawTimestamp) skipReason = "missing-timestamp";
    else if (!parsed) skipReason = "invalid-timestamp";
    else if (!derivedStatus) skipReason = "missing-status";
    else if (!passedStatusFilter) skipReason = statusMode === "retained-only" ? "unrecognized-status" : "missing-status";
    else if (!passedTeamFilter) skipReason = base.resolvedTeam ? "resolved-team-mismatch" : "unresolved-agent";
    out.push(finishLoadedSheetDebugRow(base, {
      passedStatusFilter,
      passedTeamFilter,
      counted: skipReason === "counted",
      skipReason,
    }));
  }
  return out;
}

function teamNamesForPanel(panelTeam: AggregationMode, roster: RosterIndex): Set<string> {
  if (panelTeam === "retention") return rosterTeamMembers(RETENTION_AGENTS_NORM_EARLY, roster, "retention");
  if (panelTeam === "nsf") return rosterTeamMembers(NSF_AGENT_NAMES, roster, "nsf");
  if (panelTeam === "cs") return rosterTeamMembers(CS_AGENT_NAMES, roster, "cs");
  return new Set(RMK_AGENT_NAMES);
}

function classifyTraceRowForPanel(
  sheet: SheetData,
  row: Row,
  rawRowIndex: number,
  meta: SheetSourceMeta,
  panelTeam: AggregationMode,
  roster: RosterIndex,
  fromDate: Date | null,
  toDate: Date | null,
): JeremyTraceRow {
  const agentCol = sheetAgentColumn(sheet.headers);
  const dateCol = sheetDateColumn(sheet.headers);
  const statusCol = sheetStatusColumn(sheet.headers);
  const fileCol = sheetFileIdColumn(sheet.headers);
  const rawAgentName = sheetAgentValue(row, agentCol);
  const normalizedAgentName = normalizeSheetAgentName(rawAgentName);
  const rawTimestamp = sheetDateValue(row, dateCol);
  const parsed = parseSheetDate(rawTimestamp, dateCol);
  const parsedDate = parsed ? toIsoDate(parsed) : "";
  const rawStatus = cell(row, statusCol);
  const resolved = rawAgentName ? resolveSheetAgent(rawAgentName, roster) : null;
  const candidates = sheetAgentCandidates(rawAgentName);
  const matchedSearchTerm = /jeremy|romano/i.test(rawAgentName)
    || candidates.includes("jeremy romano")
    || Object.values(row).some((value) => /jeremy|romano/i.test(String(value ?? "")))
    || resolved?.name === "Jeremy Romano";
  const rosterTeam = panelTeam === "rmk" ? "killers" : panelTeam;
  const teamNames = teamNamesForPanel(panelTeam, roster);
  const wouldPassTeam = !!rawAgentName && (
    resolved ? resolved.team === rosterTeam : sheetCandidateMatchesTeamNames(rawAgentName, teamNames, roster, rosterTeam)
  );
  const wouldPassDate = !!parsed && (!fromDate || parsed >= fromDate) && (!toDate || parsed <= toDate);
  const derivedStatus =
    meta.gid === SHEET_SOURCES.idpHandled.gid ? "IDP-Handled" :
    meta.gid === SHEET_SOURCES.idpCancelRetained.gid ? "Retained" :
    meta.gid === SHEET_SOURCES.backend.gid ? (detectKeywordStatus(row) ?? "Fixed") :
    detectKeywordStatus(row) ?? deriveNewRetentionStatus(row["Cancel request update"] ?? rawStatus);
  const wouldPassStatus = !!derivedStatus;
  let functionWhereSkipped = "not-skipped";
  let skipReason = "counted";
  if (!rawAgentName) { skipReason = "missing-agent-name"; functionWhereSkipped = "sheetAgentValue"; }
  else if (!rawTimestamp) { skipReason = "missing-timestamp"; functionWhereSkipped = "sheetDateValue"; }
  else if (!parsed) { skipReason = "invalid-timestamp"; functionWhereSkipped = "parseSheetDate"; }
  else if (!resolved) { skipReason = "unresolved-agent"; functionWhereSkipped = "resolveSheetAgent"; }
  else if (!wouldPassTeam) { skipReason = "resolved-team-mismatch"; functionWhereSkipped = "sheetCandidateMatchesTeamNames"; }
  else if (!wouldPassDate) { skipReason = "outside-date-range"; functionWhereSkipped = "aggregate"; }
  else if (!wouldPassStatus) { skipReason = "missing-status"; functionWhereSkipped = "source-loader"; }
  const counted = skipReason === "counted";
  return {
    "source name": meta.sourceName,
    "spreadsheet ID": meta.spreadsheetId,
    gid: meta.gid,
    "tab name": meta.tabName,
    "raw row index": rawRowIndex,
    "full raw row JSON": JSON.stringify(row),
    "raw Agent Name": rawAgentName,
    "normalized Agent Name": normalizedAgentName,
    "raw Timestamp": rawTimestamp,
    "parsed date": parsedDate,
    "raw File ID": cell(row, fileCol),
    "raw status/update": rawStatus || derivedStatus,
    "matched search term yes/no": matchedSearchTerm ? "yes" : "no",
    "resolved canonical agent": resolved?.name ?? "",
    "resolved team": resolved?.team ?? "",
    "roster active yes/no": resolved ? (resolved.active ? "yes" : "no") : "",
    "current panel/team": panelTeam,
    "would pass team filter yes/no": wouldPassTeam ? "yes" : "no",
    "would pass date filter yes/no": wouldPassDate ? "yes" : "no",
    "would pass status filter yes/no": wouldPassStatus ? "yes" : "no",
    "counted by current loader yes/no": counted ? "yes" : "no",
    "exact skip reason": skipReason,
    "exact function where skipped": functionWhereSkipped,
  };
}

// Reads a Google Sheet tab through the API server's authenticated Sheets
// endpoint (/api/sheet), so the source spreadsheets can stay private. Accepts
// any Google Sheets URL (or the legacy /api/csv-proxy?url=... wrapper) and
// extracts the spreadsheet id + gid from it.
async function fetchHeaderCsv(url: string): Promise<SheetData> {
  const decoded = decodeURIComponent(url);
  const idMatch = decoded.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const gidMatch = decoded.match(/[?&]gid=(\d+)/);
  if (!idMatch) throw new Error("Unrecognized Google Sheets URL.");
  const id = idMatch[1];
  const gid = gidMatch?.[1] ?? "0";
  const params = new URLSearchParams({ id, gid, _: String(Date.now()) });
  const res = await fetch(`/api/sheet?${params.toString()}`, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`Failed to load sheet (HTTP ${res.status}).`);
  const data = (await res.json()) as SheetData;
  return { headers: data.headers ?? [], rows: data.rows ?? [] };
}


// Derives a normalised status label from the new sheet's "Cancel request update" column.
function deriveNewRetentionStatus(val: string): string {
  const lower = val.toLowerCase();
  if (/retain/.test(lower)) return "Retained";
  if (/\bidp\b/.test(lower)) return "IDP-Handled";
  return "Cancelled";
}

// Inspects every plausible text column on a submission row for the retain/cancel
// keywords. Used across all 4 sheet sources so the rule is consistent.
function detectKeywordStatus(r: Row): "Retained" | "Cancelled" | null {
  const fields = [
    r["Cancel request update"], r["File Status"], r["Status"],
    r["Notes"], r["Note"], r["Notes "], r["Note "],
    r["Comments"], r["Comment"], r["Reason"], r["Action"], r["Result"],
  ];
  let hasRetain = false;
  let hasCancel = false;
  for (const v of fields) {
    if (!v) continue;
    const s = v.toLowerCase();
    if (/retain|retention form|stopped\s*payment|revok/.test(s)) hasRetain = true;
    if (/\bcancel(?:l?ed|ling)?\b/.test(s)) hasCancel = true;
  }
  // Retain wins over cancel — an ultimately retained file overrides a cancel-flagged note.
  if (hasRetain) return "Retained";
  if (hasCancel) return "Cancelled";
  return null;
}

// Normalized set of Retention agent names for fast membership checks.
// Defined here (before fetchRetentionCombinedSheet) but after normalizeAgent.
const RETENTION_AGENTS_NORM_EARLY = new Set([
  "levi miller", "ahmed ayman-levi miller", "henry hart", "ryan henderson", "michael belfort",
  "jacob stephenson", "katherine adams", "talia morgan", "rick miller", "dean lewis", "haythem",
  // Moved NSF → Retention (May 2026). Aliases cover her compound Discord-bot name.
  "kayla navarro", "jana", "jana-kayla navarro-2718",
]);

// Fetches old + new retention sheets AND the Discord-bot sheet (which Retention agents
// can now also submit to) AND the IDP-Handled tab, merging them all together.
// Agents who were temporarily on NSF but whose old NSF-sheet rows belong in the Retention panel.
const RETENTION_TEMP_NSF_AGENTS = new Set(["talia morgan", "tuqa hossam"]);

// NSF-origin agents who now sit on the Retention team (per roster) but whose
// Discord-bot (gid=0) submissions are file FIXES, not retains. Their non-keyword
// Discord rows default to "Fixed" (like the NSF panel) instead of "Retained".
// Genuine retains still classify correctly: a retain/cancel keyword on the row,
// the IDP-Handled tab, or the IDP-Cancel-Retained tab all override this default.
const RETENTION_FIX_DEFAULT_AGENTS = new Set(["kayla navarro", "jana", "jana-kayla navarro-2718"]);

async function fetchRetentionCombinedSheet(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<SheetData> {
  // Authority switch is based on ACTIVE roster presence — a team with only inactive
  // roster rows falls back to the hardcoded list (membership never goes empty).
  const rosterDrivesRetention = rosterDrivesTeam(roster, "retention");
  // Membership = active + inactive when roster is authoritative (so historical rows
  // for deactivated agents still route correctly when viewing past dates).
  const retentionNames = rosterTeamMembers(RETENTION_AGENTS_NORM_EARLY, roster, "retention");
  const nsfExcludeNames = rosterTeamMembers(RETENTION_SHEET_NSF_AGENTS, roster, "nsf");
  const csExcludeNames = rosterTeamMembers(RETENTION_SHEET_CS_AGENTS, roster, "cs");
  // Helper: should this raw "Agent Name" cell flow into the Retention panel?
  // Roster-authoritative when populated; otherwise legacy "exclude NSF/CS" behaviour.
  // Inactive-agent rows are dropped from CURRENT views only (opts.includeInactive=true
  // preserves them for past-date views — identity in roster.byName is always intact).
  const hideInactive = !opts.includeInactive;
  const includeForRetention = (agentRaw: string, source = "retention", row?: Row, agentColumn?: string | null): boolean => {
    const hit = roster ? resolveSheetAgent(agentRaw, roster) : null;
    if (hideInactive && hit && hit.active === false) {
      debugSheetAgentResolution(source, agentRaw, sheetAgentCandidates(agentRaw), hit, "inactive-hidden", {
        agentColumn,
        row,
        counted: false,
      });
      return false;
    }
    if (rosterDrivesRetention) {
      const counted = hit?.team === "retention";
      debugSheetAgentResolution(source, agentRaw, sheetAgentCandidates(agentRaw), hit ?? null, counted ? "matched-retention-roster" : "not-retention-roster-agent", {
        agentColumn,
        row,
        counted,
      });
      return counted;
    }
    const nsfExcluded = sheetCandidateMatchesTeamNames(agentRaw, nsfExcludeNames, roster, "nsf", { source: `${source}:nsf-exclude`, agentColumn, row });
    const csExcluded = sheetCandidateMatchesTeamNames(agentRaw, csExcludeNames, roster, "cs", { source: `${source}:cs-exclude`, agentColumn, row });
    const counted = !nsfExcluded && !csExcluded;
    debugSheetAgentResolution(source, agentRaw, sheetAgentCandidates(agentRaw), hit ?? null, counted ? "legacy-retention-include" : "legacy-retention-excluded", {
      agentColumn,
      row,
      counted,
    });
    return counted;
  };
  // Fetch the first four sheets in parallel (all from different spreadsheets).
  // IDP_RETENTION_URL shares the same spreadsheet as NEW_NSF_URL — fetching them
  // concurrently causes Google to silently drop one, so fetch IDP sequentially after.
  const [oldSheet, newSheet, discordSheet, oldNsfSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status),
    fetchHeaderCsv(NEW_RETENTION_URL),
    fetchHeaderCsv(NEW_NSF_URL),
    fetchHeaderCsv(NSF.status).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const idpSheet = await fetchHeaderCsv(IDP_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const idpCancelSheet = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const debugRows: LoadedSheetDebugRow[] = [
    ...debugRowsForRequiredSheet({ sheet: newSheet, meta: SHEET_SOURCES.retentionSubmission, panelTeam: "retention", roster, teamNames: retentionNames, statusMode: "retention-update" }),
    ...debugRowsForRequiredSheet({ sheet: discordSheet, meta: SHEET_SOURCES.backend, panelTeam: "retention", roster, teamNames: retentionNames, statusMode: "fixed" }),
    ...debugRowsForRequiredSheet({ sheet: idpSheet, meta: SHEET_SOURCES.idpHandled, panelTeam: "retention", roster, teamNames: retentionNames, statusMode: "idp-handled" }),
    ...debugRowsForRequiredSheet({ sheet: idpCancelSheet, meta: SHEET_SOURCES.idpCancelRetained, panelTeam: "retention", roster, teamNames: retentionNames, statusMode: "idp-cancel-retained" }),
  ];

  const oldAgentCol = sheetAgentColumn(oldSheet.headers);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);
  const oldFileIdCol = findColumn(oldSheet.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);

  const rows: Row[] = [];

  // Keep every row from the old sheet exactly as it was
  // — but skip agents who belong to NSF (they're counted there instead).
  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = sheetAgentValue(r, oldAgentCol);
      if (!includeForRetention(agentRaw, "retention:old", r, oldAgentCol)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      // Apply keyword override: Notes/other text fields containing retain/cancel
      // override the explicit Status column.
      const kw = detectKeywordStatus(r);
      rows.push({
        Agent: agentRaw,
        Status: kw ?? (r[oldStatusCol] ?? "").trim(),
        Date: d ? toIsoDate(d) : dateStr,
        "File ID": oldFileIdCol ? (r[oldFileIdCol] ?? "").trim() : "",
      });
    }
  }

  // Add new retention-specific sheet rows on/after the cutover date.
  // Skip NSF/CS cross-over agents here too.
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    if (caDate < "2026-05-04") continue;
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!includeForRetention(agentRaw, "retention:new", r, "Agent Name")) continue;
    const kw = detectKeywordStatus(r);
    rows.push({
      Agent: agentRaw,
      Status: kw ?? deriveNewRetentionStatus(r["Cancel request update"] ?? ""),
      Date: caDate,
      "File ID": (r["File ID"] ?? "").trim(),
    });
  }

  // Add Discord-bot sheet (same spreadsheet NSF uses, gid=0) rows for Retention agents.
  // Retention agents can now also submit there.
  for (const r of discordSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    if (caDate < "2026-05-04") continue;
    const agentRaw = (r["Agent Name"] ?? "").trim();
    // Roster-aware team gate: respects rosterDrives + inactive hide + segment lookup.
    if (!includeForRetention(agentRaw, "retention:discord", r, "Agent Name")) {
      const segHit = sheetCandidateMatchesTeamNames(agentRaw, retentionNames, roster, "retention", { source: "retention:discord:fallback", agentColumn: "Agent Name", row: r });
      if (!segHit) continue;
    }
    // Keyword wins, then fall back to the structured File Status mapping.
    const kw = detectKeywordStatus(r);
    let derivedStatus: string;
    if (kw) {
      derivedStatus = kw;
    } else {
      const fileStatus = (r["File Status"] ?? "").toLowerCase();
      // NSF-origin retention agents (e.g. Kayla Navarro): their non-keyword
      // Discord-bot submissions are fixes, so default to "Fixed" not "Retained".
      const isFixDefault = sheetAgentCandidates(agentRaw).some(s => RETENTION_FIX_DEFAULT_AGENTS.has(s));
      derivedStatus = /cancel|revok/.test(fileStatus)
        ? "Cancelled"
        : /\bfixed\b|\bidp\b/.test(fileStatus)
        ? "IDP-Handled"
        : isFixDefault
        ? "Fixed"
        : "Retained";
    }
    rows.push({
      Agent: agentRaw,
      Status: derivedStatus,
      Date: caDate,
      "File ID": (r["File ID"] ?? "").trim(),
    });
  }

  // Add IDP-Handled tab rows (gid=871007220) — every row from Retention agents = IDP-Handled,
  // unless Notes explicitly say retain/cancel.
  // Compound names like "nour-michael belfort-2900" are matched by checking each segment.
  for (const r of idpSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    // Roster-aware team gate (with segment fallback for compound names).
    if (!includeForRetention(agentRaw, "retention:idp", r, "Agent Name")) {
      if (!sheetCandidateMatchesTeamNames(agentRaw, retentionNames, roster, "retention", { source: "retention:idp:fallback", agentColumn: "Agent Name", row: r })) continue;
    }
    // IDP-Handled tab is its own classification; keyword override does NOT apply here
    // (every submission to this sheet is by definition an IDP-Handled action).
    rows.push({ Agent: agentRaw, Status: "IDP-Handled", Date: caDate, "File ID": (r["File ID"] ?? "").trim() });
  }

  // Add IDP Cancel Retained tab rows (gid=1018337469) — EVERY row counts as a
  // Retained for the submitting agent. No matter what.
  //
  // Per user: any file submitted on this tab is a retain for the agent. The only
  // routing we do here is "is this row clearly an NSF or CS crossover agent's row"
  // — if so, skip it because the NSF/CS crossover loaders below will pick it up.
  // Otherwise the row lands in the Retention panel even if the agent isn't in any
  // roster (so unknown / new / typo'd names don't silently disappear).
  for (const r of idpCancelSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    // Use the same retention-eligibility predicate the other loaders use, with
    // the same segment fallback as the Discord/IDP loaders: even if the
    // compound name is in a legacy CS/NSF exclude list, if ANY "-" segment is
    // a known retention agent (e.g. "Youssef Nady-Jacob Xander" → "jacob
    // xander" ∈ retentionNames), the row counts here. Without this, retains
    // for agents like Jacob Xander, Ella Monroe, Leo Carter, Carla Bennet
    // silently disappear because their compound forms live in
    // RETENTION_SHEET_CS_AGENTS.
    if (!includeForRetention(agentRaw, "retention:idp-cancel-retained", r, "Agent Name")) {
      if (!sheetCandidateMatchesTeamNames(agentRaw, retentionNames, roster, "retention", { source: "retention:idp-cancel-retained:fallback", agentColumn: "Agent Name", row: r })) continue;
    }
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate, "File ID": (r["File ID"] ?? "").trim(), __sourceTab: "IDP-Cancel-Retained" });
  }

  // Pull Talia Morgan / Tuqa Hossam rows from the old NSF sheet.
  // She was temporarily on NSF; all her NSF submissions count as "Fixed" in Retention.
  const nsfAgentCol = sheetAgentColumn(oldNsfSheet.headers);
  const nsfDateCol = findColumn(oldNsfSheet.headers, ["Date", "Day", "Call Date"]);
  const nsfFileIdCol = findColumn(oldNsfSheet.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);
  if (nsfAgentCol) {
    for (const r of oldNsfSheet.rows) {
      const agentRaw = sheetAgentValue(r, nsfAgentCol);
      if (!agentRaw || /total$/i.test(agentRaw)) continue;
      const matches = sheetAgentCandidates(agentRaw).some(seg => RETENTION_TEMP_NSF_AGENTS.has(seg));
      if (!matches) continue;
      const dateStr = nsfDateCol ? (r[nsfDateCol] ?? "").trim() : "";
      const d = parseDate(dateStr);
      rows.push({
        Agent: "Talia Morgan",
        Status: "Fixed",
        Date: d ? toIsoDate(d) : dateStr,
        "File ID": nsfFileIdCol ? (r[nsfFileIdCol] ?? "").trim() : "",
      });
    }
  }

  // Manually added retained files not present in CRM portal (added 2026-05-13)
  const MANUAL_RETAINED: Row[] = [
    { Agent: "Ahmed Ayman-Levi Miller", Status: "Retained", Date: "2026-05-12", "File ID": "1178162824" },
    { Agent: "Ahmed Ayman-Levi Miller", Status: "Retained", Date: "2026-05-12", "File ID": "1206222742" },
  ];
  rows.push(...MANUAL_RETAINED);

  return { headers: ["Agent", "Status", "Date", "File ID"], rows, debugRows };
}

// Pulls Retention-sheet rows for NSF cross-over agents (e.g. Katie Miller) and maps
// their *retained* submissions to "Fixed" so they count in the NSF panel.
async function fetchRetentionSheetNSFCrossoverRows(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<Row[]> {
  // Membership preserves history (active + inactive when roster authoritative).
  const nsfNames = rosterTeamMembers(RETENTION_SHEET_NSF_AGENTS, roster, "nsf");
  // Current-view hide is gated — past-date callers pass includeInactive=true.
  const hideInactive = !opts.includeInactive;
  const isInactive = (raw: string) => hideInactive && !!roster && resolveSheetAgent(raw, roster)?.active === false;
  // Spreadsheet 11kOhk8x is shared with IDP Cancel Retained — fetch sequentially
  // so Google doesn't drop concurrent requests on the same workbook.
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status),
    fetchHeaderCsv(NEW_RETENTION_URL),
  ]);
  const idpCancelSheet = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));

  const oldAgentCol = sheetAgentColumn(oldSheet.headers);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);
  const oldFileCol = findColumn(oldSheet.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);

  const rows: Row[] = [];
  // Roster-aware membership (segment-aware for compound names like "amr-katie miller-2900").
  const matchesTeam = (agentRaw: string, source: string, row?: Row, agentColumn?: string | null): boolean => {
    if (!agentRaw) return false;
    return sheetCandidateMatchesTeamNames(agentRaw, nsfNames, roster, "nsf", { source, agentColumn, row });
  };

  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = sheetAgentValue(r, oldAgentCol);
      if (!matchesTeam(agentRaw, "nsf-crossover:old-retention", r, oldAgentCol)) continue;
      if (isInactive(agentRaw)) continue;
      const kw = detectKeywordStatus(r);
      const rawStatus = kw ?? (r[oldStatusCol] ?? "").trim();
      if (!isRetainedStatus(rawStatus)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      rows.push({ Agent: agentRaw, Status: "Retained", Date: d ? toIsoDate(d) : dateStr, "File ID": oldFileCol ? (r[oldFileCol] ?? "").trim() : "" });
    }
  }

  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!matchesTeam(agentRaw, "nsf-crossover:new-retention", r, "Agent Name")) continue;
    if (isInactive(agentRaw)) continue;
    const kw = detectKeywordStatus(r);
    const derived = kw ?? deriveNewRetentionStatus(r["Cancel request update"] ?? "");
    if (!isRetainedStatus(derived)) continue;
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate, "File ID": (r["File ID"] ?? "").trim() });
  }

  // IDP Cancel Retained → every row counts as Retained for the routed team member.
  // Tagged for Export Rows to surface as IDP-Cancel-Handled.
  for (const r of idpCancelSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!matchesTeam(agentRaw, "nsf-crossover:idp-cancel-retained", r, "Agent Name")) continue;
    if (isInactive(agentRaw)) continue;
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate, "File ID": (r["File ID"] ?? "").trim(), __sourceTab: "IDP-Cancel-Retained" });
  }

  return rows;
}

// Pulls Retention-sheet rows for CS/NSF cross-over agents and maps their retained
// submissions to "Retained". Cancelled rows are intentionally dropped.
async function fetchRetentionSheetCSCrossoverRows(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<Row[]> {
  // Membership preserves history (active + inactive when roster authoritative).
  const csNames = rosterTeamMembers(RETENTION_SHEET_CS_AGENTS, roster, "cs");
  // Current-view hide is gated — past-date callers pass includeInactive=true.
  const hideInactive = !opts.includeInactive;
  const isInactive = (raw: string) => hideInactive && !!roster && resolveSheetAgent(raw, roster)?.active === false;
  // Spreadsheet 11kOhk8x is shared with IDP Cancel Retained — fetch sequentially.
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status),
    fetchHeaderCsv(NEW_RETENTION_URL),
  ]);
  const idpCancelSheet = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));

  const oldAgentCol = sheetAgentColumn(oldSheet.headers);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);
  const oldFileCol = findColumn(oldSheet.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);

  const rows: Row[] = [];
  // Roster-aware CS membership with segment fallback for compound names.
  const matchesTeam = (agentRaw: string, source: string, row?: Row, agentColumn?: string | null): boolean => {
    if (!agentRaw) return false;
    return sheetCandidateMatchesTeamNames(agentRaw, csNames, roster, "cs", { source, agentColumn, row });
  };

  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = sheetAgentValue(r, oldAgentCol);
      if (!matchesTeam(agentRaw, "cs-crossover:old-retention", r, oldAgentCol)) continue;
      if (isInactive(agentRaw)) continue;
      const kw = detectKeywordStatus(r);
      const rawStatus = kw ?? (r[oldStatusCol] ?? "").trim();
      if (!isRetainedStatus(rawStatus)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      rows.push({ Agent: agentRaw, Status: "Retained", Date: d ? toIsoDate(d) : dateStr, "File ID": oldFileCol ? (r[oldFileCol] ?? "").trim() : "" });
    }
  }

  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!matchesTeam(agentRaw, "cs-crossover:new-retention", r, "Agent Name")) continue;
    if (isInactive(agentRaw)) continue;
    const kw = detectKeywordStatus(r);
    const derived = kw ?? deriveNewRetentionStatus(r["Cancel request update"] ?? "");
    if (!isRetainedStatus(derived)) continue;
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate, "File ID": (r["File ID"] ?? "").trim() });
  }

  // IDP Cancel Retained → Retained for the routed CS team member.
  // Tagged for Export Rows to surface as IDP-Cancel-Handled.
  for (const r of idpCancelSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!matchesTeam(agentRaw, "cs-crossover:idp-cancel-retained", r, "Agent Name")) continue;
    if (isInactive(agentRaw)) continue;
    rows.push({ Agent: agentRaw, Status: "Retained", Date: caDate, "File ID": (r["File ID"] ?? "").trim(), __sourceTab: "IDP-Cancel-Retained" });
  }

  return rows;
}

const NAME_ALIASES: Record<string, string> = {
  "kaite miller": "katie miller",
  "kevin michael": "kevin micheal",
  // Compound Discord-bot names → canonical English display name
  // Ensures aggregate() merges submissions under one row and sheetToPhoneKey resolves correctly.
  "ahmed gamal-austin white":      "austin white",
  "raneem-renee solomon-3209":     "renee solomon",
  "omar badr-kevin micheal-3140":  "kevin micheal",
  "yousef taher-raymond reed-2977":"raymond reed",
  "engy-ellie moser-2046":         "ellie moser",
  "abdelrahman-tyler grant-3139":  "tyler grant",
  "omar-otto klein-3239":          "otto klein",
  "seif eslam-alex miller-3210":   "alex miller",
  "ziad-zach carter-2917":         "zach carter",
  "ayaat ahmed":                   "jenny morgan",
  "bassant emad- carla bennet-2098":"carla bennet",
  "bassant emad-carla bennet-2098":"carla bennet",
  // Retention: Arabic OpenPhone / Discord names → compound display name
  // Needed so submissions using the Arabic name merge into the same agent row as the compound name.
  "ahmed ayman":       "ahmed ayman-levi miller",
  "tuqa hossam":       "talia morgan",
  "abdulrhman isawi":          "jacob stephenson",
  "abdlrhman":                 "jacob stephenson",
  "adam maxwell":              "jacob stephenson",
  "abdlrhman-adam maxwell":    "jacob stephenson",
  "abdlrhman-jacob stephenson":"jacob stephenson",
  // Youssef Nasser / Youssef-John Marcus → John Marcus
  "youssef nasser":            "john marcus",
  "youssef-john marcus":       "john marcus",
  // Haythem → Dean Lewis
  "haythem":                   "dean lewis",
  "haythem-dean lewis-2089":   "dean lewis",
  "zeiad fouad":       "rick miller",
  "karma farouk":      "katherine adams",
  "karma":             "katherine adams",
  "karma-katherine adams-3195":"katherine adams",
  "muhamed walid":     "ryan henderson",
  "muhamed":           "ryan henderson",
  "muhamed-ryan henderson":    "ryan henderson",
  "nouralden":         "michael belfort",
  "saif aziz":         "henry hart",
  "saif aziz-henry hart-2450": "henry hart",
};

// Egypt shift number → label (Egypt local time)
// Shift 4 = 4pm–12am EGY, Shift 5 = 5pm–1am EGY, Shift 6 = 6pm–2am EGY,
// Shift 7 = 7pm–3am EGY, Shift 8 = 8pm–4am EGY
const SHIFT_COLORS: Record<number, string> = {
  4: "bg-stone-700",
  5: "bg-zinc-700",
  6: "bg-neutral-700",
  7: "bg-stone-600",
  8: "bg-zinc-800",
};

const AGENT_SHIFTS: Record<string, { num: number; label: string; color: string }> = {
  // CS
  "ella monroe":       { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "chase miller":      { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "leo carter":        { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "nora adam":         { num: 6, label: "Shift 6 · 6pm EGY", color: SHIFT_COLORS[6]! },
  "jacob xander":      { num: 8, label: "Shift 8 · 8pm EGY", color: SHIFT_COLORS[8]! },
  "carla bennet":      { num: 8, label: "Shift 8 · 8pm EGY", color: SHIFT_COLORS[8]! },
  // Retention
  "levi miller":            { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "ahmed ayman":            { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "ahmed ayman-levi miller":{ num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "henry hart":        { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "rick miller":       { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "zeiad fouad":       { num: 4, label: "Shift 4 · 4pm EGY", color: SHIFT_COLORS[4]! },
  "michael belfort":   { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "ryan henderson":    { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "katherine adams":   { num: 5, label: "Shift 5 · 5pm EGY", color: SHIFT_COLORS[5]! },
  "talia morgan":      { num: 6, label: "Shift 6 · 6pm EGY", color: SHIFT_COLORS[6]! },
  "jacob stephenson":  { num: 7, label: "Shift 7 · 7pm EGY", color: SHIFT_COLORS[7]! },
  "abdulrhman isawi":  { num: 7, label: "Shift 7 · 7pm EGY", color: SHIFT_COLORS[7]! },
};

function ShiftDot({ agentName }: { agentName: string }) {
  const shift = AGENT_SHIFTS[agentName.toLowerCase().trim()];
  if (!shift) return null;
  return (
    <span
      title={shift.label}
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-extrabold text-white leading-none shadow-sm ring-1 ring-border ${shift.color}`}
      style={{ verticalAlign: "middle", flexShrink: 0 }}
    >
      {shift.num}
    </span>
  );
}

// Agents who submit files in the Retention sheet but actually belong to the NSF team.
// Their rows are EXCLUDED from Retention stats and counted as "Fixed" in NSF instead.
const RETENTION_SHEET_NSF_AGENTS = new Set([
  "katie miller", "sama farouk",
  "zach carter", "ziad",
  "austin white", "ahmed gamal", "ahmed gamal-austin white",
  "rika hart", "riham samir",
  "jenny morgan", "ayaat",
  "renee solomon", "raneem", "raneem-renee solomon-3209",
  "ellie moser", "engy mahmoud",
  "estella cruz", "eman khamis",
  "kevin micheal", "omar badr", "omar badr-kevin micheal-3140",
  "raymond reed", "yousef taher", "yousef taher-raymond reed-2977",
  // New agents — May 2026
  // (Kayla Navarro / "jana" moved NSF → Retention; see RETENTION_AGENTS_NORM_EARLY.)
  "alex miller", "seif eslam",
  "tyler grant", "abdelrahman",
  "otto klein", "omar",
]);

// Agents who submit files in the Retention sheet but actually belong to the CS team.
// Their RETAINED submissions are counted as "Fixed" in CS; CANCELLED rows are dropped entirely.
const RETENTION_SHEET_CS_AGENTS = new Set([
  // English display names
  "ella monroe", "chase miller", "leo carter", "nora adam", "jacob xander", "carla bennet",
  // Arabic / alias names
  "hiba kamil", "nour eldin atef", "nour eldin", "fares", "nourhan ame", "nourhan amr", "youssef nady", "bassant emad",
  // Compound old-sheet names
  "youssef nady-jacob xander",
  "nour eldin-chase miller-2787",
  "hiba kamil-ella monroe-2882",
  "nourhan amr-nora adam-2186",
  // New agents — May 2026
  "anna stone", "anisa", "anisa-anna stone-2382",
]);

// NSF agent display names (normalized lowercase) — used to split the shared
// Discord-bot sheet between NSF and CS.
const NSF_AGENT_NAMES = new Set([
  // English display names
  "zach carter", "austin white", "rika hart", "jenny morgan",
  "renee solomon", "ellie moser", "estella cruz", "katie miller",
  "kevin micheal", "kevin michael", "raymond reed",
  // Arabic / alias names
  "ziad", "ahmed gamal", "riham samir", "ayaat",
  "raneem", "engy mahmoud", "eman khamis", "sama farouk",
  "omar badr", "yousef taher",
  // Compound Discord-bot names
  "raneem-renee solomon-3209",
  "ahmed gamal-austin white",
  "omar badr-kevin micheal-3140",
  "yousef taher-raymond reed-2977",
  // New agents — May 2026
  // (Kayla Navarro / "jana" moved NSF → Retention; see RETENTION_AGENTS_NORM_EARLY.)
  "alex miller", "seif eslam",
  "tyler grant", "abdelrahman",
  "otto klein", "omar",
]);
// CS agent display names (normalized lowercase)
const CS_AGENT_NAMES = new Set([
  // English display names
  "ella monroe", "chase miller", "leo carter", "nora adam", "jacob xander", "carla bennet",
  // Arabic / alias names
  "hiba kamil", "nour eldin atef", "nour eldin", "fares", "nourhan amr", "nourhan ame", "youssef nady", "bassant emad",
  // Compound old-sheet names (submitted in retention / IDP sheets)
  "youssef nady-jacob xander",
  "nour eldin-chase miller-2787",
  "hiba kamil-ella monroe-2882",
  "nourhan amr-nora adam-2186",
  // New agents — May 2026
  "anna stone", "anisa", "anisa-anna stone-2382",
]);

type CancelViolation = {
  key: string; agent: string; team: "CS" | "NSF"; date: string; rawStatus: string; fileId: string;
};

// Scans the retention sheets (Sheet 1 old + Sheet 1 new) for CS/NSF agents who submitted
// a Cancelled row. Returns one entry per unique agent+date+fileId combination.
async function fetchCancelViolations(
  roster?: RosterIndex,
  _opts: { includeInactive?: boolean } = {},
): Promise<CancelViolation[]> {
  // Violations always preserve history (membership = active + inactive when roster
  // authoritative). Currently we don't hide inactive here since the violation list
  // surfaces past offences regardless of current employment.
  const csNames = rosterTeamMembers(RETENTION_SHEET_CS_AGENTS, roster, "cs");
  const nsfNames = rosterTeamMembers(RETENTION_SHEET_NSF_AGENTS, roster, "nsf");
  const [oldSheet, newSheet] = await Promise.all([
    fetchHeaderCsv(RETENTION.status).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
    fetchHeaderCsv(NEW_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const violations: CancelViolation[] = [];
  const seen = new Set<string>();

  const oldAgentCol  = sheetAgentColumn(oldSheet.headers);
  const oldStatusCol = findColumn(oldSheet.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const oldDateCol   = findColumn(oldSheet.headers, ["Date", "Day", "Call Date"]);
  const oldFileCol   = findColumn(oldSheet.headers, ["File ID", "File Id", "FileID", "file id"]);
  // Roster-aware team classifier (uses roster.teamForAgent + segment-aware fallback
  // so compound names like "nour-ella monroe-2900" are correctly routed).
  const classifyTeam = (agentRaw: string, source: string, row?: Row, agentColumn?: string | null): "CS" | "NSF" | null => {
    if (!agentRaw) return null;
    const rosterTeam = roster ? resolveSheetAgent(agentRaw, roster)?.team : null;
    if (rosterTeam === "cs") {
      debugSheetAgentResolution(source, agentRaw, sheetAgentCandidates(agentRaw), roster ? resolveSheetAgent(agentRaw, roster) : null, "violation-classified-cs", { agentColumn, row, counted: true });
      return "CS";
    }
    if (rosterTeam === "nsf") {
      debugSheetAgentResolution(source, agentRaw, sheetAgentCandidates(agentRaw), roster ? resolveSheetAgent(agentRaw, roster) : null, "violation-classified-nsf", { agentColumn, row, counted: true });
      return "NSF";
    }
    if (sheetCandidateMatchesTeamNames(agentRaw, csNames, roster, "cs", { source: `${source}:cs`, agentColumn, row })) return "CS";
    if (sheetCandidateMatchesTeamNames(agentRaw, nsfNames, roster, "nsf", { source: `${source}:nsf`, agentColumn, row })) return "NSF";
    debugSheetAgentResolution(source, agentRaw, sheetAgentCandidates(agentRaw), null, "violation-not-cs-or-nsf", { agentColumn, row, counted: false });
    return null;
  };

  if (oldAgentCol && oldStatusCol) {
    for (const r of oldSheet.rows) {
      const agentRaw = sheetAgentValue(r, oldAgentCol);
      const agentNorm = normalizeAgent(agentRaw);
      const team = classifyTeam(agentRaw, "violations:old-retention", r, oldAgentCol);
      if (!team) continue;
      const kw = detectKeywordStatus(r);
      if (kw === "Retained") continue; // keyword override says retained → not a violation
      const rawStatus = kw ?? (r[oldStatusCol] ?? "").trim();
      if (!rawStatus || isRetainedStatus(rawStatus)) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "") : "";
      const d = oldDateCol ? parseDate(dateStr) : null;
      const date = d ? toIsoDate(d) : dateStr;
      const fileId = (oldFileCol ? (r[oldFileCol] ?? "") : "").trim();
      const key = `cancel:old:${agentNorm}:${date}:${fileId}`;
      if (!seen.has(key)) { seen.add(key); violations.push({ key, agent: agentRaw, team, date, rawStatus, fileId }); }
    }
  }

  const newFileCol = findColumn(newSheet.headers, ["File ID", "File Id", "FileID", "file id"]);
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    const agentNorm = normalizeAgent(agentRaw);
    const team = classifyTeam(agentRaw, "violations:new-retention", r, "Agent Name");
    if (!team) continue;
    const kw = detectKeywordStatus(r);
    if (kw === "Retained") continue;
    const updateVal = (r["Cancel request update"] ?? "").trim();
    if (kw !== "Cancelled") {
      if (!updateVal) continue; // blank = still pending, not yet confirmed cancelled
      const derived = deriveNewRetentionStatus(updateVal);
      if (isRetainedStatus(derived)) continue;
    }
    const fileId = (newFileCol ? (r[newFileCol] ?? "") : "").trim();
    const key = `cancel:new:${agentNorm}:${caDate}:${fileId}`;
    if (!seen.has(key)) { seen.add(key); violations.push({ key, agent: agentRaw, team, date: caDate, rawStatus: "Cancelled", fileId }); }
  }

  return violations.sort((a, b) => b.date.localeCompare(a.date));
}

// Shared helper: parses the Discord-bot sheet (gid=0) and returns rows belonging to a team.
// Submissions to the Discord/NSF backend sheet — normally count as "Fixed".
// EXCEPTION: if the "Cancel request update" or "File Status" or "Notes" field
// contains "retain" / "retention", the file was ultimately retained and should
// count as "Retained" instead so it appears in the retention metrics.
async function fetchNewSheetForTeam(teamNames: Set<string>, roster?: RosterIndex | null, team?: RosterTeam, preloadedSheet?: SheetData): Promise<Row[]> {
  const newSheet = preloadedSheet ?? await fetchHeaderCsv(NEW_NSF_URL);
  const rows: Row[] = [];
  for (const r of newSheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!sheetCandidateMatchesTeamNames(agentRaw, teamNames, roster, team, { source: `discord-bot:${team ?? "unknown"}`, agentColumn: "Agent Name", row: r })) {
      continue;
    }
    // Keyword override (retain/cancel) across all text fields, including Notes.
    const kw = detectKeywordStatus(r);
    rows.push({ Agent: agentRaw, Status: kw ?? "Fixed", Date: caDate, "File ID": (r["File ID"] ?? "").trim() });
  }
  return rows;
}

// Shared helper: parses the IDP-Handled tab (gid=871007220) and returns rows for a team.
// Every submission to this sheet counts as "IDP-Handled".
// Compound agent names like "riham samir-rika hart-1234" are matched by checking each
// dash-separated segment against teamNames so new formats are handled automatically.
async function fetchIDPSheetForTeam(teamNames: Set<string>, roster?: RosterIndex | null, team?: RosterTeam, preloadedSheet?: SheetData): Promise<Row[]> {
  const sheet = preloadedSheet ?? await fetchHeaderCsv(IDP_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const rows: Row[] = [];
  for (const r of sheet.rows) {
    const tsRaw = (r["Timestamp"] ?? "").trim();
    const d = parseEgyptTimestamp(tsRaw);
    if (!d) continue;
    const caDate = toCaliforniaDateStr(d);
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw) continue;
    // Also try each segment of compound names (e.g. "riham samir-rika hart-1234" → ["riham samir", "rika hart", "1234"])
    if (!sheetCandidateMatchesTeamNames(agentRaw, teamNames, roster, team, { source: `idp-handled:${team ?? "unknown"}`, agentColumn: "Agent Name", row: r })) {
      continue;
    }
    // IDP-Handled tab is its own classification; keyword override does NOT apply here
    // (every submission to this sheet is by definition an IDP-Handled action).
    rows.push({ Agent: agentRaw, Status: "IDP-Handled", Date: caDate, "File ID": (r["File ID"] ?? "").trim() });
  }
  return rows;
}

// Fetches NSF submissions from the same 3 sources as CS:
//   – Old retention sheet (Sheet 1, gid=837339339) → Retained (via crossover)
//   – Discord-bot gid=0 (Sheet 2)                  → Fixed
//   – IDP-Handled tab (Sheet 3, gid=871007220)      → IDP-Handled
async function fetchNSFCombinedSheet(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<SheetData> {
  // Membership preserves history (active + inactive when roster authoritative).
  const teamNames = rosterTeamMembers(NSF_AGENT_NAMES, roster, "nsf");
  const hideInactive = !opts.includeInactive;
  // fetchNewSheetForTeam (gid=0) and fetchIDPSheetForTeam (gid=871007220) use the same
  // spreadsheet — serialize to avoid Google dropping the concurrent second request.
  const [backendSheet, crossoverRows, oldNsfSheet, retentionSubmissionSheet] = await Promise.all([
    fetchHeaderCsv(NEW_NSF_URL),
    fetchRetentionSheetNSFCrossoverRows(roster, { includeInactive: opts.includeInactive }),
    fetchHeaderCsv(NSF.status).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
    fetchHeaderCsv(NEW_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const newRows = await fetchNewSheetForTeam(teamNames, roster, "nsf", backendSheet);
  const idpSheet = await fetchHeaderCsv(IDP_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const idpRows = await fetchIDPSheetForTeam(teamNames, roster, "nsf", idpSheet);
  const idpCancelSheet = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const debugRows: LoadedSheetDebugRow[] = [
    ...debugRowsForRequiredSheet({ sheet: backendSheet, meta: SHEET_SOURCES.backend, panelTeam: "nsf", roster, teamNames, statusMode: "fixed" }),
    ...debugRowsForRequiredSheet({ sheet: idpSheet, meta: SHEET_SOURCES.idpHandled, panelTeam: "nsf", roster, teamNames, statusMode: "idp-handled" }),
    ...debugRowsForRequiredSheet({ sheet: idpCancelSheet, meta: SHEET_SOURCES.idpCancelRetained, panelTeam: "nsf", roster, teamNames, statusMode: "idp-cancel-retained" }),
    ...debugRowsForRequiredSheet({ sheet: retentionSubmissionSheet, meta: SHEET_SOURCES.retentionSubmission, panelTeam: "nsf", roster, teamNames, statusMode: "retained-only" }),
  ];

  // Pull pre-cutover rows from the old NSF sheet (where agents tracked files before the Discord-bot sheet).
  // All rows map to "Fixed" since every row represents a file the agent submitted/handled.
  const oldNsfRows: Row[] = [];
  const oldAgentCol = sheetAgentColumn(oldNsfSheet.headers);
  const oldDateCol = findColumn(oldNsfSheet.headers, ["Date", "Day", "Call Date"]);
  const oldNsfFileCol = findColumn(oldNsfSheet.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);
  if (oldAgentCol) {
    for (const r of oldNsfSheet.rows) {
      const agentRaw = sheetAgentValue(r, oldAgentCol);
      if (!agentRaw || /total$/i.test(agentRaw)) continue;
      if (!sheetCandidateMatchesTeamNames(agentRaw, teamNames, roster, "nsf", { source: "nsf:old-sheet", agentColumn: oldAgentCol, row: r })) continue;
      if (hideInactive && !!roster && resolveSheetAgent(agentRaw, roster)?.active === false) continue;
      const dateStr = oldDateCol ? (r[oldDateCol] ?? "").trim() : "";
      const d = parseDate(dateStr);
      const kw = detectKeywordStatus(r);
      oldNsfRows.push({ Agent: agentRaw, Status: kw ?? "Fixed", Date: d ? toIsoDate(d) : dateStr, "File ID": oldNsfFileCol ? (r[oldNsfFileCol] ?? "").trim() : "" });
    }
  }

  // Current-view hide is gated by hideInactive. Past-date views (includeInactive=true)
  // keep deactivated agents' rows so historical totals stay intact.
  const keep = (r: Row) => !hideInactive || !roster || resolveSheetAgent((r["Agent"] ?? "") as string, roster)?.active !== false;
  // NSF agents are not allowed to cancel files — only the Retention team is.
  // Any Cancelled row that bleeds in here (via keyword detection on Notes/Status)
  // is a policy violation, surfaced separately by fetchCancelViolations. Drop it
  // from the per-agent stats so non-Retention agents never get a "Cancelled" tally.
  const notCancelled = (r: Row) => !/cancel/i.test(String(r["Status"] ?? ""));
  const merged = [...newRows, ...crossoverRows, ...idpRows, ...oldNsfRows].filter(keep).filter(notCancelled);
  return { headers: ["Agent", "Status", "Date", "File ID"], rows: merged, debugRows };
}

// Fetches CS submissions from all 3 sources:
//   – Discord-bot gid=0 (Sheet 2) → Fixed
//   – Old retention sheet (Sheet 1) → Fixed (retained only)
//   – IDP-Handled tab (Sheet 3)    → IDP-Handled
async function fetchCSCombinedSheet(
  roster?: RosterIndex,
  opts: { includeInactive?: boolean } = {},
): Promise<SheetData> {
  // Membership preserves history (active + inactive when roster authoritative).
  const teamNames = rosterTeamMembers(CS_AGENT_NAMES, roster, "cs");
  const hideInactive = !opts.includeInactive;
  // fetchNewSheetForTeam (gid=0) and fetchIDPSheetForTeam (gid=871007220) use the same
  // spreadsheet — serialize to avoid Google dropping the concurrent second request.
  const [backendSheet, crossoverRows, retentionSubmissionSheet] = await Promise.all([
    fetchHeaderCsv(NEW_NSF_URL),
    fetchRetentionSheetCSCrossoverRows(roster, { includeInactive: opts.includeInactive }),
    fetchHeaderCsv(NEW_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const newRows = await fetchNewSheetForTeam(teamNames, roster, "cs", backendSheet);
  const idpSheet = await fetchHeaderCsv(IDP_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const idpRows = await fetchIDPSheetForTeam(teamNames, roster, "cs", idpSheet);
  const idpCancelSheet = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const debugRows: LoadedSheetDebugRow[] = [
    ...debugRowsForRequiredSheet({ sheet: backendSheet, meta: SHEET_SOURCES.backend, panelTeam: "cs", roster, teamNames, statusMode: "fixed" }),
    ...debugRowsForRequiredSheet({ sheet: idpSheet, meta: SHEET_SOURCES.idpHandled, panelTeam: "cs", roster, teamNames, statusMode: "idp-handled" }),
    ...debugRowsForRequiredSheet({ sheet: idpCancelSheet, meta: SHEET_SOURCES.idpCancelRetained, panelTeam: "cs", roster, teamNames, statusMode: "idp-cancel-retained" }),
    ...debugRowsForRequiredSheet({ sheet: retentionSubmissionSheet, meta: SHEET_SOURCES.retentionSubmission, panelTeam: "cs", roster, teamNames, statusMode: "retained-only" }),
  ];
  // Current-view hide is gated by hideInactive. Past-date views (includeInactive=true)
  // keep deactivated agents' rows so historical totals stay intact.
  const keep = (r: Row) => !hideInactive || !roster || resolveSheetAgent((r["Agent"] ?? "") as string, roster)?.active !== false;
  // CS agents cannot cancel files — only Retention can. Cancelled rows are
  // surfaced via fetchCancelViolations instead of counted in per-agent stats.
  const notCancelled = (r: Row) => !/cancel/i.test(String(r["Status"] ?? ""));
  const merged = [...newRows, ...crossoverRows, ...idpRows].filter(keep).filter(notCancelled);
  return { headers: ["Agent", "Status", "Date", "File ID"], rows: merged, debugRows };
}

function findColumn(headers: string[], candidates: string[]): string | null {
  return findColumnByHeader(headers, candidates);
}

const NAME_DISPLAY: Record<string, string> = {
  "katie miller": "Katie Miller",
};
function normalizeAgent(s: string): string {
  const base = s.replace(/\s+/g, " ").trim().toLowerCase();
  return NAME_ALIASES[base] ?? base;
}

// Display names to always exclude everywhere across all panels.
// Use normalized lowercase display names — these are matched against normalizeAgent(agentName).
// NOTE: "Leo Maxwell" is intentionally NOT here. He is an admin who covers calls on
// multiple lines. The Quo Lines tab uses a behavioral filter (outbound===0 && answered===0)
// to hide him when he's inactive. When he IS making calls, he should show.
// NOTE: Do NOT put OpenPhone user IDs here — they are never matched (the check
// compares against display names, not IDs).
const PHONE_BLOCKLIST = new Set(["shahin ."]);

// Extra phone-only agents per team (not in the Google Sheet, but on the team)
// Keys must match OpenPhone agent names (normalized lowercase)
const TEAM_PHONE_EXTRAS: Record<string, string[]> = {
  retention: ["Michael Ross"],
  nsf: [],
  cs: [],
};

// Strict allowlist per team — normalized phone key variants for each real agent.
// Only agents whose phoneData key appears here will be shown in any view.
const TEAM_ALLOWLIST: Record<string, Set<string>> = {
  retention: new Set([
    // Levi Miller / Ahmed Ayman
    "levi miller", "ahmed ayman",
    // Henry Hart / Saif Aziz
    "henry hart", "saif aziz",
    // Ryan Henderson / Muhamed Walid
    "ryan henderson", "muhamed walid",
    // Michael Belfort / Nouralden
    "michael belfort", "nouralden",
    // Jacob Stephenson / Abdlrhman / Adam Maxwell
    "jacob stephenson", "abdulrhman isawi", "adam maxwell",
    // John Marcus / Youssef Nasser / Youssef-John Marcus
    "john marcus", "youssef nasser", "youssef-john marcus",
    // Katherine Adams / Karma Farouk
    "katherine adams", "karma farouk",
    // Rick Miller / Zeiad Fouad
    "rick miller", "zeiad fouad",
    // Talia Morgan / Tuqa Hossam
    "talia morgan", "tuqa hossam",
    // Michael Belfort / Nour (Nour-Michael Belfort-2900 line)
    "michael belfort", "nouralden",
    // Dean Lewis / Haythem (ext 2089)
    "dean lewis", "haythem",
    // Legacy extras kept for historical data
    "max francis", "michael ross",
  ]),
  nsf: new Set([
    // Zach Carter / Ziad
    "zach carter", "ziad",
    // Austin White / Ahmed Gamal
    "austin white", "ahmed gamal",
    // Rika Hart / Riham Samir
    "rika hart", "riham samir",
    // Jenny Morgan / Ayaat
    "jenny morgan", "ayaat",
    // Renee Solomon / Raneem
    "renee solomon", "raneem",
    // Ellie Moser / Engy Mahmoud
    "ellie moser", "engy mahmoud",
    // Estella Cruz / Eman Khamis
    "estella cruz", "eman khamis",
    // Katie Miller / Sama Farouk
    "katie miller", "sama farouk",
    // Kevin Micheal / Omar Badr
    "kevin micheal", "omar badr", "omar badr-kevin micheal-3140",
    // Raymond Reed / Yousef Taher
    "raymond reed", "yousef taher", "yousef taher-raymond reed-2977",
    // Austin White / Ahmed Gamal (compound Discord name)
    "ahmed gamal-austin white",
  ]),
  cs: new Set([
    // Ella Monroe / Hiba Kamil
    "ella monroe", "hiba kamil",
    // Chase Miller / Nour Eldin Atef
    "chase miller", "nour eldin atef",
    // Leo Carter / Fares
    "leo carter", "fares",
    // Nora Adam / Nourhan Ame
    "nora adam", "nourhan ame",
    // Jacob Xander / Youssef Nady
    "jacob xander", "youssef nady",
    // Carla Bennet / Bassant Emad
    "carla bennet", "bassant emad",
    // Anna Stone / Anisa
    "anna stone", "anisa", "anisa-anna stone-2382",
  ]),
};

// Merges duplicate phone accounts that belong to the same real person
const PHONE_ALIASES: Record<string, string> = {
  // Retention: Arabic OpenPhone name → English display name
  "abdulrhman isawi": "jacob stephenson",
  "zeiad fouad": "rick miller",
  "ahmed ayman": "levi miller",
  "ahmed ayman-levi miller": "levi miller",
  "saif aziz": "henry hart",
  "muhamed walid": "ryan henderson",
  "nouralden": "michael belfort",
  "karma farouk": "katherine adams",
  "tuqa hossam": "talia morgan",
  // Internal CS: Arabic OpenPhone name → English display name
  "hiba kamil": "ella monroe",
  "nour eldin atef": "chase miller",
  "fares": "leo carter",
  "nourhan ame": "nora adam",
  "youssef nady": "jacob xander",
  "bassant emad": "carla bennet",
  "anisa-anna stone-2382": "anna stone",
  "anisa": "anna stone",
  // NSF: Arabic OpenPhone name → English display name
  "ziad": "zach carter",
  "ahmed gamal": "austin white",
  "riham samir": "rika hart",
  "ayaat": "jenny morgan",
  "raneem": "renee solomon",
  "engy mahmoud": "ellie moser",
  "eman khamis": "estella cruz",
  "sama farouk": "katie miller",
  "omar badr": "kevin micheal",
  "yousef taher": "raymond reed",
  "jana": "kayla navarro",
  "jana-kayla navarro-2718": "kayla navarro",
  "seif eslam": "alex miller",
  "abdelrahman": "tyler grant",
  "omar": "otto klein",
};

// ReadyMode CSV-side aliases: CSV name spelling → canonical dashboard key.
// Applied before PHONE_ALIASES when folding ReadyMode dialer calls in.
const RM_CSV_ALIASES: Record<string, string> = {
  "kevin michael": "kevin micheal", // dashboard uses the misspelled form
  "jacob stephenson": "jacob stephenson", // already canonical (Retention; AKA Adam Maxwell)
};

// ReadyMode CSV rows to ignore — not real agents.
const RM_CSV_SKIP: Set<string> = new Set([
  "m.johnson",
  "manager",
  "summary",
  "test",
  "tester",
]);

// Maps normalized SHEET agent name → normalized PBX (VoSLogic) agent name
// Format: "QuoName-PBXAlias" sheet entries decode as QuoName=Quo key, PBXAlias=PBX key
// Roster-aware PBX key resolver. Tries the roster first (English or Arabic name,
// active or inactive — historical attribution included), then falls back to the
// legacy SHEET_TO_PBX alias table for any name the roster doesn't know.
function resolvePbxKey(rawAgent: string, roster: RosterIndex | null | undefined): string {
  const norm = normalizeAgent(rawAgent);
  if (roster) {
    const hit = roster.lookupByAnyName(rawAgent);
    if (hit) {
      const enNorm = hit.name.replace(/\s+/g, " ").trim().toLowerCase();
      return SHEET_TO_PBX[enNorm] ?? enNorm;
    }
  }
  return SHEET_TO_PBX[norm] ?? norm;
}

const SHEET_TO_PBX: Record<string, string> = {
  "ahmed ayman-levi miller": "levi miller",       // PBX: Levi Miller = Ahmed Ayman
  "youssef nady-jacob xander": "jacob xander",    // PBX: Jacob Xander = Youssef Nady
  "zeiad fouad-zack ford": "rick miller",          // PBX: Rick Miller = Zeiad Fouad
  "nour-michael belfort-2900": "michael belfort",  // PBX: Michael Belfort = Nour/Michael
  "mohammed ayman-max francis-2268": "max francis",
  "engy-ellie moser-2046": "ellie moser",
  "haythem-dean lewis-2089": "haythem",           // PBX: Haythem = Dean Lewis
  "dean lewis": "haythem",                         // lookup by display name → PBX key
  "muhamed-ryan henderson": "jacob ahmed",         // PBX: Jacob Ahmed = Ryan Henderson
  "abdlrhman-jacob stephenson": "abdulrhman isawi",
  "abdlrhman-adam maxwell": "abdulrhman isawi",
  "adam maxwell": "jacob stephenson",
  "youssef-john marcus": "john marcus",
  "youssef nasser": "john marcus",
};

// Maps normalized SHEET agent name → normalized PHONE (OpenPhone) agent name
const SHEET_TO_PHONE: Record<string, string> = {
  "abdlrhman-jacob stephenson": "abdulrhman isawi",
  "abdlrhman-adam maxwell": "abdulrhman isawi",
  "youssef-john marcus": "john marcus",
  "youssef nasser": "john marcus",
  "muhamed-ryan henderson": "ryan henderson",
  "zeiad fouad-zack ford": "zeiad fouad",
  "youssef nady-jacob xander": "youssef nady",
  "ahmed ayman-levi miller": "levi miller",
  "haythem-dean lewis-2089": "dean lewis",
  "nour-michael belfort-2900": "michael belfort",
  "mohammed ayman-max francis-2268": "max francis",
  // NSF combined OpenPhone display names
  "engy-ellie moser-2046": "ellie moser",
  // Note: jacob stephenson, rick miller, levi miller, ella monroe, jacob xander
  // no longer need entries here — PHONE_ALIASES now maps their Arabic OpenPhone names
  // directly to these English display-name keys in the phone data map.
};

function sheetToPhoneKey(sheetAgent: string): string {
  const norm = normalizeAgent(sheetAgent);
  return SHEET_TO_PHONE[norm] ?? norm;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(trimmed);
  if (us) {
    let year = Number(us[3]);
    if (year < 100) year += 2000;
    const d = new Date(year, Number(us[1]) - 1, Number(us[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  const fallback = new Date(trimmed);
  return isNaN(fallback.getTime()) ? null : fallback;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const CA_TZ = "America/Los_Angeles";

/** Returns today's date as "YYYY-MM-DD" in PDT, regardless of device timezone. */
function todayPDT(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CA_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** Returns current year/month(0-indexed)/date components in PDT. */
function nowPDTParts(): { year: number; month: number; date: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CA_TZ,
    year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, date: get("day") };
}

/** Formats a timestamp string for display in PDT. */
function formatPDTTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: CA_TZ,
  });
}

/** Formats a Date for display as a short date in PDT. */
function formatPDTDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: CA_TZ });
}

// Discord-bot sheets record timestamps in Egypt local time (EET = UTC+2, no DST since 2011).
// This parses those timestamps and returns a proper UTC Date so the California date can be derived.
// Google Forms timestamp format is typically "M/D/YYYY HH:MM:SS".
function parseEgyptTimestamp(s: string): Date | null {
  if (!s) return null;
  const trimmed = s.trim();

  let year: number, month: number, day: number, hour = 0, minute = 0, second = 0;

  // "M/D/YYYY HH:MM:SS" (Google Forms default)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);
  // "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS"
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);

  if (us) {
    month  = Number(us[1]); day    = Number(us[2]); year   = Number(us[3]);
    hour   = Number(us[4]); minute = Number(us[5]); second = Number(us[6] ?? 0);
  } else if (iso) {
    year   = Number(iso[1]); month  = Number(iso[2]); day    = Number(iso[3]);
    hour   = Number(iso[4]); minute = Number(iso[5]); second = Number(iso[6] ?? 0);
  } else {
    // Date-only string — no time means no timezone conversion needed
    return parseDate(trimmed);
  }

  // Egypt is permanently UTC+2 → subtract 2 h to get UTC
  const utcMs = Date.UTC(year, month - 1, day, hour - 2, minute, second);
  const d = new Date(utcMs);
  return isNaN(d.getTime()) ? null : d;
}

// Given a UTC Date, return the YYYY-MM-DD date string in California time (America/Los_Angeles).
// This correctly handles Pacific Standard Time (UTC-8) and Pacific Daylight Time (UTC-7).
const _caFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
});
function toCaliforniaDateStr(d: Date): string {
  return _caFmt.format(d); // returns "YYYY-MM-DD"
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseDuration(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(":").map((p) => Number(p.trim()));
  if (parts.some((p) => isNaN(p))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 3600 + parts[1] * 60;
  return parts[0] * 60;
}

function formatDuration(sec: number): string {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatHours(sec: number): string {
  if (!sec) return "0h";
  const h = sec / 3600;
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

function formatElapsedSince(isoStr: string, now: number): string {
  const diff = Math.max(0, now - new Date(isoStr).getTime());
  const totalSecs = Math.floor(diff / 1000);
  const d = Math.floor(totalSecs / 86400);
  const h = Math.floor((totalSecs % 86400) / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function AvailableSince({ isoStr }: { isoStr?: string }) {
  const now = useNow(15000);
  if (!isoStr) return <span className="text-muted-foreground/40">—</span>;
  const diff = now - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  const color = mins < 30 ? "metric-good" : mins < 120 ? "metric-warn" : "metric-bad";
  return (
    <span className={`tabular-nums font-mono ${color}`} title={`Last valid call ${formatPDTTime(isoStr)}`}>
      {formatElapsedSince(isoStr, now)}
    </span>
  );
}

// ---------- Aggregation ----------

type TeamMode = "retention" | "nsf" | "cs";
type AggregationMode = TeamMode | "rmk";

type DayBreakdown = {
  iso: string;
  date: Date;
  calls: number;
  seconds: number;
  byStatus: Map<string, number>;
  total: number;
};

type AgentBreakdown = {
  agent: string;
  calls: number;
  seconds: number;
  byStatus: Map<string, number>;
  total: number;
};

type Aggregated = {
  mode: AggregationMode;
  statusColumn: string;
  agentColumn: string;
  dateColumn: string | null;
  statuses: string[];
  retainedStatuses: Set<string>;
  byDay: DayBreakdown[];
  byAgent: AgentBreakdown[];
  // agent display name → per-day breakdown for that agent (used by ByDayView's
  // per-agent filter). Days are keyed by ISO date string.
  byAgentDay: Map<string, DayBreakdown[]>;
  totals: {
    calls: number;
    seconds: number;
    byStatus: Map<string, number>;
    grand: number;
    agents: number;
    retained: number;
  };
  todayRetained: number;
  monthRetained: number;
  monthCancelled: number;
  todayFixed: number;
  monthFixed: number;
  todayCount: number;
  monthCount: number;
  totalRowCount: number;
  filteredRowCount: number;
  minDate: Date | null;
  maxDate: Date | null;
};

function isRetainedStatus(s: string): boolean {
  const lower = s.toLowerCase();
  return /retain/.test(lower) || /\bidp\b/.test(lower) || /stopped\s*payment/.test(lower) || /revok/.test(lower);
}

// For counts (daily / monthly / all-time tiles): IDP is excluded.
// IDP still counts toward retention RATE via isRetainedStatus above.
function isPureRetainedStatus(s: string): boolean {
  const lower = s.toLowerCase();
  if (/\bidp\b/.test(lower)) return false;
  return /retain/.test(lower) || /stopped\s*payment/.test(lower) || /revok/.test(lower);
}

// Collapse legacy/inconsistent status spellings from old sheets into
// canonical values so they don't appear as duplicate columns.
function normalizeStatus(s: string): string {
  const t = s.trim();
  const l = t.toLowerCase().replace(/[\s\-_]+/g, "");
  if (/^retain(ed)?$/.test(l)) return "Retained";
  if (/^cancel(led)?$/.test(l)) return "Cancelled";
  if (/^idp/.test(l)) return "IDP-Handled";
  if (/^activehandled$/.test(l)) return "IDP-Handled";
  return t;
}

function retentionRate(retained: number, total: number): string {
  if (!total) return "—";
  return `${((retained / total) * 100).toFixed(1)}%`;
}

function aggregate(
  status: SheetData,
  mode: AggregationMode,
  fromDate: Date | null,
  toDate: Date | null,
  roster?: RosterIndex,
): Aggregated | { error: string } {
  const agentColumn = sheetAgentColumn(status.headers);
  const statusColumn = findColumn(status.headers, ["Status", "Result", "Outcome", "Disposition"]);
  const dateColumn = sheetDateColumn(status.headers);
  if (!agentColumn) return { error: `Couldn't find "Agent" column.` };
  if (!statusColumn) return { error: `Couldn't find "Status" column.` };

  // Determine global date range from status sheet for the filter UI
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  const consider = (d: Date) => {
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  };
  if (dateColumn) {
    for (const r of status.rows) {
      const d = parseSheetDate(sheetDateValue(r, dateColumn), dateColumn);
      if (d) consider(d);
    }
  }

  const inRange = (d: Date) => {
    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };

  // Filter status rows
  const filteredStatus = status.rows.filter((r) => {
    const agent = sheetAgentValue(r, agentColumn);
    if (!agent) return false;
    if (/total$/i.test(agent)) return false;
    if (dateColumn && (fromDate || toDate)) {
      const d = parseSheetDate(sheetDateValue(r, dateColumn), dateColumn);
      if (!d) return false;
      if (!inRange(d)) return false;
    }
    return true;
  });

  // Build status counts — statuses pass through as-is for all modes.
  // For retention/cs, seed the canonical column set so layout stays consistent
  // (zero-value columns still render) even when a status is absent in the
  // current date window.
  const allStatuses = new Set<string>();
  if (mode === "retention" || mode === "nsf" || mode === "cs") {
    allStatuses.add("Retained");
    allStatuses.add("Cancelled");
    allStatuses.add("IDP-Handled");
    allStatuses.add("Fixed");
  }
  const dayMap = new Map<string, DayBreakdown>();
  const agentMap = new Map<string, AgentBreakdown>();
  const totalsByStatus = new Map<string, number>();
  // agent display name → (iso date → DayBreakdown) for the per-agent ByDay filter
  const agentDayMap = new Map<string, Map<string, DayBreakdown>>();

  const ensureDay = (iso: string, d: Date): DayBreakdown => {
    if (!dayMap.has(iso)) {
      dayMap.set(iso, {
        iso,
        date: d,
        calls: 0,
        seconds: 0,
        byStatus: new Map(),
        total: 0,
      });
    }
    return dayMap.get(iso)!;
  };
  const ensureAgent = (a: string, sourceRow?: Row): AgentBreakdown => {
    // Sheet-specific identity: rows like "Anna Stone / Anisa" or
    // "Anisa-Anna Stone-2382" roll up under the canonical roster name.
    const rosterHit = roster ? resolveSheetAgent(a, roster) : null;
    if (roster && !rosterHit) {
      debugSheetAgentResolution(`aggregate:${mode}`, a, sheetAgentCandidates(a), null, "unresolved-before-count", {
        agentColumn,
        row: sourceRow,
        counted: true,
      });
    } else if (rosterHit) {
      debugSheetAgentResolution(`aggregate:${mode}`, a, sheetAgentCandidates(a), rosterHit, "counted-under-canonical-agent", {
        agentColumn,
        row: sourceRow,
        counted: true,
      });
    }
    const key = rosterHit
      ? normalizeAgent(rosterHit.name)
      : normalizeAgent(a);
    if (!key) return { agent: "", calls: 0, seconds: 0, byStatus: new Map(), total: 0 };
    if (!agentMap.has(key)) {
      const display = rosterHit
        ? rosterHit.name
        : NAME_DISPLAY[key] ?? a.replace(/\s+/g, " ").trim();
      agentMap.set(key, {
        agent: display,
        calls: 0,
        seconds: 0,
        byStatus: new Map(),
        total: 0,
      });
    }
    return agentMap.get(key)!;
  };

  const rosterTeamForMode: RosterTeam | null =
    mode === "retention" || mode === "nsf" || mode === "cs" ? mode : mode === "rmk" ? "killers" : null;
  if (roster && rosterTeamForMode) {
    for (const agent of roster.agentsForTeam(rosterTeamForMode)) ensureAgent(agent.name);
  }

  for (const r of filteredStatus) {
    const agent = sheetAgentValue(r, agentColumn);
    const rawStatus = normalizeStatus((r[statusColumn] ?? "").trim() || "(blank)");
    const status = rawStatus;
    allStatuses.add(status);
    const ag = ensureAgent(agent, r);
    ag.byStatus.set(status, (ag.byStatus.get(status) ?? 0) + 1);
    ag.total += 1;
    totalsByStatus.set(status, (totalsByStatus.get(status) ?? 0) + 1);
    if (dateColumn) {
      const d = parseSheetDate(sheetDateValue(r, dateColumn), dateColumn);
      if (d) {
        const iso = toIsoDate(d);
        const day = ensureDay(iso, d);
        day.byStatus.set(status, (day.byStatus.get(status) ?? 0) + 1);
        day.total += 1;
        // Per-agent-per-day accumulator
        if (ag.agent) {
          let perAgent = agentDayMap.get(ag.agent);
          if (!perAgent) {
            perAgent = new Map();
            agentDayMap.set(ag.agent, perAgent);
          }
          let aDay = perAgent.get(iso);
          if (!aDay) {
            aDay = { iso, date: d, calls: 0, seconds: 0, byStatus: new Map(), total: 0 };
            perAgent.set(iso, aDay);
          }
          aDay.byStatus.set(status, (aDay.byStatus.get(status) ?? 0) + 1);
          aDay.total += 1;
        }
      }
    }
  }

  const byAgentDay = new Map<string, DayBreakdown[]>();
  for (const [agent, days] of agentDayMap) {
    byAgentDay.set(
      agent,
      Array.from(days.values()).sort((a, b) => a.date.getTime() - b.date.getTime()),
    );
  }

  const statuses = Array.from(allStatuses).sort((a, b) => {
    const ta = totalsByStatus.get(a) ?? 0;
    const tb = totalsByStatus.get(b) ?? 0;
    if (ta !== tb) return tb - ta;
    return a.localeCompare(b);
  });

  const byDay = Array.from(dayMap.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const byAgent = Array.from(agentMap.values()).sort((a, b) =>
    a.agent.localeCompare(b.agent),
  );

  const totalCalls = byAgent.reduce((s, a) => s + a.calls, 0);
  const totalSeconds = byAgent.reduce((s, a) => s + a.seconds, 0);
  const grand = byAgent.reduce((s, a) => s + a.total, 0);
  const retainedStatuses = new Set(statuses.filter(isRetainedStatus));
  const totalRetained = Array.from(retainedStatuses).reduce(
    (s, st) => s + (totalsByStatus.get(st) ?? 0),
    0,
  );

  let todayRetained = 0;
  let monthRetained = 0;
  let monthCancelled = 0;
  let todayFixed = 0;
  let monthFixed = 0;
  let todayCount = 0;
  let monthCount = 0;
  if (dateColumn) {
    // Use California time (America/Los_Angeles) — sheet dates are stored in CA time.
    // Do NOT use browser local time here: some browsers may be in non-LA timezones,
    // always derive "today" explicitly in LA time.
    const todayIso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()); // "YYYY-MM-DD"
    const thisMonthStr = todayIso.slice(0, 7); // "YYYY-MM"
    for (const r of status.rows) {
      const d = parseSheetDate(sheetDateValue(r, dateColumn), dateColumn);
      if (!d) continue;
      const rawStatus = normalizeStatus((r[statusColumn] ?? "").trim());
      const dateStr = toIsoDate(d); // date-only, same in all TZs
      const isToday = dateStr === todayIso;
      const inThisMonth = dateStr.startsWith(thisMonthStr);
      if (isToday) todayCount += 1;
      if (inThisMonth) monthCount += 1;
      if (isPureRetainedStatus(rawStatus)) {
        if (isToday) todayRetained += 1;
        if (inThisMonth) monthRetained += 1;
      }
      if (/cancel/i.test(rawStatus) && inThisMonth) monthCancelled += 1;
      if (/\bidp\b/i.test(rawStatus)) {
        if (isToday) todayFixed += 1;
        if (inThisMonth) monthFixed += 1;
      }
    }
  }

  return {
    mode,
    agentColumn,
    statusColumn,
    dateColumn,
    statuses,
    retainedStatuses,
    byDay,
    byAgent,
    byAgentDay,
    totals: {
      calls: totalCalls,
      seconds: totalSeconds,
      byStatus: totalsByStatus,
      grand,
      agents: byAgent.length,
      retained: totalRetained,
    },
    todayRetained,
    monthRetained,
    monthCancelled,
    todayFixed,
    monthFixed,
    todayCount,
    monthCount,
    totalRowCount: status.rows.length,
    filteredRowCount: filteredStatus.length,
    minDate,
    maxDate,
  };
}

// ---------- UI ----------

type TileTone = "blue" | "emerald" | "amber" | "sky" | "rose" | "slate" | "zinc";

const TONE_STYLES: Record<TileTone, { bg: string; ring: string; text: string; glow: string }> = {
  blue: {
    bg: "bg-cyan-50/80 dark:bg-cyan-950/35",
    ring: "border-cyan-500/25 dark:border-cyan-400/25",
    text: "text-cyan-700 dark:text-cyan-100",
    glow: "shadow-sm shadow-cyan-900/10 dark:shadow-cyan-950/20",
  },
  emerald: {
    bg: "bg-emerald-50/80 dark:bg-emerald-950/45",
    ring: "border-emerald-500/25 dark:border-emerald-400/30",
    text: "text-emerald-700 dark:text-emerald-100",
    glow: "shadow-sm shadow-emerald-900/10 dark:shadow-emerald-950/20",
  },
  amber: {
    bg: "bg-amber-50/85 dark:bg-amber-950/40",
    ring: "border-amber-500/30 dark:border-amber-500/25",
    text: "text-amber-700 dark:text-amber-100",
    glow: "shadow-sm shadow-amber-900/10 dark:shadow-amber-950/20",
  },
  sky: {
    bg: "bg-sky-50/85 dark:bg-sky-950/45",
    ring: "border-sky-500/25 dark:border-sky-500/25",
    text: "text-sky-700 dark:text-sky-100",
    glow: "shadow-sm shadow-sky-900/10 dark:shadow-sky-950/20",
  },
  rose: {
    bg: "bg-rose-50/85 dark:bg-rose-950/45",
    ring: "border-rose-500/25 dark:border-rose-500/25",
    text: "text-rose-700 dark:text-rose-100",
    glow: "shadow-sm shadow-rose-900/10 dark:shadow-rose-950/20",
  },
  slate: {
    bg: "bg-card",
    ring: "border-border",
    text: "text-foreground",
    glow: "",
  },
  zinc: {
    bg: "bg-stone-100/85 dark:bg-zinc-900/40",
    ring: "border-stone-300/80 dark:border-zinc-700/40",
    text: "text-stone-600 dark:text-zinc-400",
    glow: "",
  },
};

function StatTile({
  label,
  value,
  icon,
  tone = "slate",
  sub,
}: {
  label: string;
  value: number | string;
  icon?: React.ReactNode;
  tone?: TileTone;
  sub?: string;
}) {
  const s = TONE_STYLES[tone];
  const accent = {
    blue: "bg-cyan-400/90",
    emerald: "bg-emerald-400/90",
    amber: "bg-amber-400/90",
    sky: "bg-sky-400/90",
    rose: "bg-rose-400/90",
    slate: "bg-stone-400/70",
    zinc: "bg-zinc-500/70",
  }[tone];
  return (
    <div className={`ops-card group min-h-[126px] rounded-lg border p-4 ${s.bg} ${s.ring} ${s.glow}`}>
      <div className={`absolute left-0 right-0 top-0 h-[3px] ${accent}`} />
      <div className="flex items-center gap-2">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${s.ring} bg-background/70 dark:bg-black/20 ${s.text}`}>
          {icon ?? label.slice(0, 1)}
        </span>
        <span className="min-w-0 truncate text-xs font-semibold text-muted-foreground">{label}</span>
      </div>
      <div className={`mt-3 text-[30px] leading-9 font-medium tabular-nums font-mono ${tone === "slate" ? "text-foreground" : s.text}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] font-medium text-muted-foreground">{sub}</div>}
    </div>
  );
}

function statusTone(s: string): string {
  const lower = s.toLowerCase();
  if (/retain/.test(lower)) return "metric-good";
  if (/idp/.test(lower)) return "metric-info";
  if (/cancel/.test(lower)) return "metric-bad";
  if (/fixed/.test(lower)) return "metric-good";
  return "text-foreground";
}

function RosterAgentDetailsDialog({
  rawName,
  open,
  onOpenChange,
  children,
}: {
  rawName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const { token, user } = useUser();
  const qc = useQueryClient();
  const roster = useRoster();
  const hit = resolveSheetAgent(rawName, roster) ?? roster.lookupByAnyName(rawName);
  const parts = agentNameParts(rawName, roster);
  const [agentName, setAgentName] = useState(parts.agentName);
  const [notes, setNotes] = useState(hit?.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextHit = resolveSheetAgent(rawName, roster) ?? roster.lookupByAnyName(rawName);
    const nextParts = agentNameParts(rawName, roster);
    setAgentName(nextParts.agentName);
    setNotes(nextHit?.notes ?? "");
  }, [open, rawName, roster.version]);

  const canSave = !!hit && user.role === "admin";

  async function save() {
    if (!hit || !agentName.trim()) return;
    setSaving(true);
    try {
      await fetch(`/api/team-agents/${hit.id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          name: agentName.trim(),
          notes: notes.trim() || null,
        }),
      });
      await qc.invalidateQueries({ queryKey: ["roster"] });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent Details</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <AvatarName name={agentName || rawName} size="lg" textClassName="text-foreground" />
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent Name</span>
            <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} disabled={!canSave} className="h-9" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Additional notes</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={!canSave}
              placeholder={hit ? "Add notes for this agent..." : "Add this agent in Manage Agents before saving notes."}
              className="min-h-24 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-60"
            />
          </label>
          <div>
            <div className="text-xs text-muted-foreground">Status</div>
            <Badge variant="outline" className={hit?.active === false ? "metric-warn border-border" : "metric-good border-border"}>
              {hit ? (hit.active ? "Active" : "Inactive") : "Not in roster"}
            </Badge>
          </div>
          {children}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => void save()} disabled={!canSave || saving || !agentName.trim()}>
              {saving ? "Saving..." : "Save details"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type SortState = { column: string; dir: "asc" | "desc" } | null;

function SortHeader({
  id,
  label,
  align = "left",
  sort,
  onToggle,
}: {
  id: string;
  label: string;
  align?: "left" | "right";
  sort: SortState;
  onToggle: (id: string) => void;
}) {
  const active = sort?.column === id;
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      className={`inline-flex items-center gap-1.5 font-semibold text-foreground hover-elevate active-elevate-2 px-2 py-1 -mx-2 rounded-md ${align === "right" ? "flex-row-reverse" : ""}`}
      data-testid={`button-sort-${id}`}
    >
      <span>{label}</span>
      {!active && <ArrowUpDown className="h-3.5 w-3.5 opacity-50" />}
      {active && sort?.dir === "asc" && <ArrowUp className="h-3.5 w-3.5" />}
      {active && sort?.dir === "desc" && <ArrowDown className="h-3.5 w-3.5" />}
    </button>
  );
}

function startOfWeek(d: Date): Date {
  // Group week as Monday–Sunday (Sunday is the closing day, like the old sheet)
  const day = d.getDay(); // 0=Sun..6=Sat
  const offset = day === 0 ? -6 : 1 - day; // back to Monday
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  return start;
}

function sumRetained(byStatus: Map<string, number>, retained: Set<string>): number {
  let n = 0;
  for (const s of retained) n += byStatus.get(s) ?? 0;
  return n;
}

function ByDayView({ data }: { data: Aggregated }) {
  const showRate = data.mode === "retention";
  const [agentFilter, setAgentFilter] = useState<string>("");
  // Merge every Killer agent's day breakdowns into one combined series so the
  // "⚔ Killers" filter behaves like a single (team-level) selection.
  const killerDays = useMemo<DayBreakdown[]>(() => {
    const m = new Map<number, DayBreakdown>();
    for (const [agent, days] of data.byAgentDay) {
      if (!isKillerAgentKey(normalizeAgent(agent))) continue;
      for (const d of days) {
        const t = d.date.getTime();
        let agg = m.get(t);
        if (!agg) {
          agg = { iso: d.iso, date: d.date, calls: 0, seconds: 0, total: 0, byStatus: new Map() };
          m.set(t, agg);
        }
        agg.calls += d.calls;
        agg.seconds += d.seconds;
        agg.total += d.total;
        for (const [s, n] of d.byStatus) agg.byStatus.set(s, (agg.byStatus.get(s) ?? 0) + n);
      }
    }
    return Array.from(m.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [data.byAgentDay]);
  const sourceDays: DayBreakdown[] =
    agentFilter === KILLERS_FILTER
      ? killerDays
      : agentFilter && data.byAgentDay.has(agentFilter)
      ? data.byAgentDay.get(agentFilter)!
      : data.byDay;
  // Group days into weeks (Mon–Sun) and emit a subtotal row at the end of each week
  type WeekGroup = { weekStart: Date; days: DayBreakdown[] };
  const weeks: WeekGroup[] = [];
  for (const day of sourceDays) {
    const ws = startOfWeek(day.date);
    const wsTime = ws.getTime();
    let group = weeks[weeks.length - 1];
    if (!group || group.weekStart.getTime() !== wsTime) {
      group = { weekStart: ws, days: [] };
      weeks.push(group);
    }
    group.days.push(day);
  }

  const agentOptions = useMemo(
    () => data.byAgent.map((a) => a.agent).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [data.byAgent],
  );

  const footerTotals = useMemo(() => {
    if (!agentFilter) {
      return {
        calls: data.totals.calls,
        seconds: data.totals.seconds,
        byStatus: data.totals.byStatus,
        grand: data.totals.grand,
        retained: data.totals.retained,
      };
    }
    const byStatus = new Map<string, number>();
    let calls = 0, seconds = 0, grand = 0;
    for (const d of sourceDays) {
      calls += d.calls;
      seconds += d.seconds;
      grand += d.total;
      for (const [s, n] of d.byStatus) {
        byStatus.set(s, (byStatus.get(s) ?? 0) + n);
      }
    }
    let retained = 0;
    for (const s of data.retainedStatuses) retained += byStatus.get(s) ?? 0;
    return { calls, seconds, byStatus, grand, retained };
  }, [agentFilter, sourceDays, data.totals, data.retainedStatuses]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Filter by agent:</span>
        <AnimatedValueSelect
          value={agentFilter}
          onChange={setAgentFilter}
          ariaLabel="Filter by agent"
          triggerClassName="min-w-[180px]"
          menuClassName="w-64"
          options={[
            { value: "", label: "All agents" },
            ...(agentOptions.some((n) => isKillerAgentKey(normalizeAgent(n))) ? [{ value: KILLERS_FILTER, label: "Killers" }] : []),
            ...agentOptions.map((n) => ({ value: n, label: n })),
          ]}
        />
        {agentFilter && (
          <button
            type="button"
            onClick={() => setAgentFilter("")}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear
          </button>
        )}
      </div>
    <div className="ops-table-wrap overflow-hidden">
      <div className="overflow-x-auto max-h-[65vh]">
        <Table>
          <TableHeader className="sticky top-0 backdrop-blur z-10">
            <TableRow>
              <TableHead className="whitespace-nowrap">Day</TableHead>
              <TableHead className="whitespace-nowrap">Date</TableHead>
              <TableHead className="text-right whitespace-nowrap">Calls</TableHead>
              <TableHead className="text-right whitespace-nowrap">Time on calls</TableHead>
              {data.statuses.map((s) => (
                <TableHead key={s} className={`text-right whitespace-nowrap ${statusTone(s)}`}>
                  {s}
                </TableHead>
              ))}
              <TableHead className="text-right whitespace-nowrap bg-primary/10 metric-info">Total</TableHead>
              {showRate && (
                <TableHead className="text-right whitespace-nowrap bg-primary/10 metric-info">Retention rate</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {weeks.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={data.statuses.length + 5 + (showRate ? 1 : 0)}
                  className="text-center py-12 text-muted-foreground"
                >
                  No data for the selected date range.
                </TableCell>
              </TableRow>
            )}
            {weeks.map((week, wi) => {
              const subtotal = week.days.reduce(
                (acc, d) => {
                  acc.calls += d.calls;
                  acc.seconds += d.seconds;
                  acc.total += d.total;
                  for (const [s, n] of d.byStatus) {
                    acc.byStatus.set(s, (acc.byStatus.get(s) ?? 0) + n);
                  }
                  return acc;
                },
                {
                  calls: 0,
                  seconds: 0,
                  total: 0,
                  byStatus: new Map<string, number>(),
                },
              );
              const weekEnd = new Date(week.weekStart);
              weekEnd.setDate(weekEnd.getDate() + 6);
              return (
                <Fragment key={`week-frag-${wi}`}>
                  {week.days.map((d) => (
                    <TableRow key={d.iso} className="hover-elevate">
                      <TableCell className="font-medium whitespace-nowrap">
                        {DAY_NAMES[d.date.getDay()]}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {d.date.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric" })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-mono">
                        {d.calls || ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-mono">
                        {formatDuration(d.seconds)}
                      </TableCell>
                      {data.statuses.map((s) => {
                        const v = d.byStatus.get(s) ?? 0;
                        return (
                          <TableCell
                            key={s}
                            className={`text-right tabular-nums font-mono ${v === 0 ? "text-muted-foreground/40" : statusTone(s)}`}
                          >
                            {v}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/5 metric-info">
                        {d.total || ""}
                      </TableCell>
                      {showRate && (
                        <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/10">
                          {retentionRate(sumRetained(d.byStatus, data.retainedStatuses), d.total)}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  <TableRow key={`week-${wi}`} className="bg-accent/40 font-semibold">
                    <TableCell className="whitespace-nowrap">Week of</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                      {week.weekStart.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric" })} – {weekEnd.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric" })}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-mono">
                      {subtotal.calls || ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-mono">
                      {formatDuration(subtotal.seconds)}
                    </TableCell>
                    {data.statuses.map((s) => (
                      <TableCell key={s} className="text-right tabular-nums font-mono">
                        {subtotal.byStatus.get(s) ?? 0}
                      </TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums font-mono bg-primary/10">
                      {subtotal.total}
                    </TableCell>
                    {showRate && (
                      <TableCell className="text-right tabular-nums font-mono bg-primary/10">
                        {retentionRate(sumRetained(subtotal.byStatus, data.retainedStatuses), subtotal.total)}
                      </TableCell>
                    )}
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
          {sourceDays.length > 0 && (
            <TableHeader className="sticky bottom-0 backdrop-blur z-10">
              <TableRow>
                <TableCell className="font-bold">Total</TableCell>
                <TableCell></TableCell>
                <TableCell className="text-right tabular-nums font-mono font-bold">
                  {footerTotals.calls}
                </TableCell>
                <TableCell className="text-right tabular-nums font-mono font-bold">
                  {formatDuration(footerTotals.seconds)}
                </TableCell>
                {data.statuses.map((s) => (
                  <TableCell
                    key={s}
                    className="text-right tabular-nums font-mono font-bold"
                  >
                    {footerTotals.byStatus.get(s) ?? 0}
                  </TableCell>
                ))}
                <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                  {footerTotals.grand}
                </TableCell>
                {showRate && (
                  <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                    {retentionRate(footerTotals.retained, footerTotals.grand)}
                  </TableCell>
                )}
              </TableRow>
            </TableHeader>
          )}
        </Table>
      </div>
    </div>
    </div>
  );
}

function responseRate(answered: number, total: number): string {
  if (!total) return "—";
  return `${Math.round((answered / total) * 100)}%`;
}

function avgDuration(seconds: number, calls: number): string {
  if (!calls) return "—";
  return formatDuration(Math.round(seconds / calls));
}

function ByFilesView({ data, hideTeamRow, phoneData, sheetData, fromDate, toDate }: { data: Aggregated; hideTeamRow?: boolean; phoneData?: Map<string, PhoneAgentMetrics>; sheetData?: SheetData; fromDate?: Date | null; toDate?: Date | null }) {
  const showRate = data.mode === "retention";
  const roster = useRoster();
  const { user } = useUser();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ column: "__total__", dir: "desc" });
  const [selectedAgent, setSelectedAgent] = useState<AgentBreakdown | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.byAgent;
    if (q) list = list.filter((a) => a.agent.toLowerCase().includes(q));
    if (sort) {
      list = [...list].sort((a, b) => {
        let av: number | string;
        let bv: number | string;
        if (sort.column === "__agent__") { av = a.agent; bv = b.agent; }
        else if (sort.column === "__total__") { av = a.total; bv = b.total; }
        else if (sort.column === "__rate__") {
          av = a.total ? sumRetained(a.byStatus, data.retainedStatuses) / a.total : -1;
          bv = b.total ? sumRetained(b.byStatus, data.retainedStatuses) / b.total : -1;
        } else { av = a.byStatus.get(sort.column) ?? 0; bv = b.byStatus.get(sort.column) ?? 0; }
        if (typeof av === "number" && typeof bv === "number") return sort.dir === "asc" ? av - bv : bv - av;
        const cmp = String(av).localeCompare(String(bv));
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return list;
  }, [data, search, sort]);

  function toggle(column: string) {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, dir: column === "__agent__" ? "asc" : "desc" };
      if (prev.dir === "desc") return { column, dir: "asc" };
      return null;
    });
  }

  function exportCsv() {
    // Collect all agents: sheet agents first, then phone-only agents not in the sheet
    const sheetAgents = visible.map((a) => a.agent);
    const sheetKeys = new Set(sheetAgents.map((a) => sheetToPhoneKey(a)));
    const phoneOnlyAgents: string[] = [];
    if (phoneData) {
      for (const key of phoneData.keys()) {
        if (!sheetKeys.has(key)) {
          phoneOnlyAgents.push(key.replace(/\b\w/g, (c) => c.toUpperCase()));
        }
      }
    }
    const allAgentsForExport = [...sheetAgents, ...phoneOnlyAgents];

    const rows = allAgentsForExport.map((agent) => {
      const sheetEntry = visible.find((a) => a.agent === agent);
      const record: Record<string, string | number> = { Agent: agent };
      // Sheet columns
      for (const s of data.statuses) record[s] = sheetEntry?.byStatus.get(s) ?? 0;
      record["Total Files"] = sheetEntry?.total ?? 0;
      if (showRate) {
        const retained = sheetEntry ? sumRetained(sheetEntry.byStatus, data.retainedStatuses) : 0;
        record["Retention Rate"] = sheetEntry ? retentionRate(retained, sheetEntry.total) : "—";
      }
      // Phone call columns
      const ph = phoneData?.get(sheetToPhoneKey(agent));
      record["Calls"] = ph?.calls ?? 0;
      record["Outbound"] = ph?.outbound ?? 0;
      record["Inbound"] = ph?.inbound ?? 0;
      record["Answered"] = ph?.answered ?? 0;
      record["Missed"] = ph?.missed ?? 0;
      record["VM Brief"] = ph?.vmBrief ?? 0;
      record["Talk Time"] = ph ? formatDuration(ph.seconds) : "—";
      return record;
    });
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `files_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportRawRows() {
    if (!sheetData) return;
    const agentCol = sheetAgentColumn(sheetData.headers);
    const statusCol = findColumn(sheetData.headers, ["Status", "Result", "Outcome", "Disposition"]);
    const dateCol = sheetDateColumn(sheetData.headers);
    const fileIdCol = findColumn(sheetData.headers, ["File ID", "File Id", "FileID", "File #", "Account #", "Account ID", "Loan #", "ID"]);
    const sourceCol = findColumn(sheetData.headers, ["Source", "Source Tab", "Sheet", "Type"]);
    if (!agentCol || !statusCol) return;

    const rows = sheetData.rows.filter((r) => {
      const agent = sheetAgentValue(r, agentCol);
      if (!agent || /total$/i.test(agent)) return false;
      if (dateCol && (fromDate || toDate)) {
        const d = parseSheetDate(sheetDateValue(r, dateCol), dateCol);
        if (!d) return false;
        if (fromDate && d < fromDate) return false;
        if (toDate && d > toDate) return false;
      }
      return true;
    });

    const exportRows = rows.map((r) => {
      // IDP-Cancel-Retained rows are stored as "Retained" so dashboard tiles
      // count them, but raw export keeps the exact source tab visible.
      const isIdpCancel = r["__sourceTab"] === "IDP-Cancel-Retained";
      return {
        Agent: sheetAgentValue(r, agentCol),
        Status: isIdpCancel ? "idp-cancel-retained" : (r[statusCol] ?? "").trim(),
        Source: sourceCol ? (r[sourceCol] ?? "").trim() : isIdpCancel ? "idp-cancel-retained" : "",
        Date: dateCol ? sheetDateValue(r, dateCol) : "",
        "File ID": fileIdCol ? (r[fileIdCol] ?? "").trim() : "",
      };
    });

    const csv = Papa.unparse(exportRows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `submissions_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportLoadedSheetDebug() {
    const rows = (sheetData?.debugRows ?? []).map((r) => {
      const d = r.parsedDate ? parseDate(r.parsedDate) : null;
      const insideDateRange = !!d && (!fromDate || d >= fromDate) && (!toDate || d <= toDate);
      const counted = r.counted && insideDateRange;
      const skipReason = !insideDateRange && r.counted ? "outside-date-range" : r.skipReason;
      return {
        "source name": r.sourceName,
        "spreadsheet ID": r.spreadsheetId,
        gid: r.gid,
        "tab name": r.tabName,
        "raw row index": r.rawRowIndex,
        "raw Agent Name": r.rawAgentName,
        "selected agent column": r.selectedAgentColumn,
        "raw Timestamp": r.rawTimestamp,
        "selected date column": r.selectedDateColumn,
        "parsed date": r.parsedDate,
        "File ID": r.fileId,
        "raw status/update value": r.rawStatusUpdateValue,
        "selected status/update column": r.selectedStatusUpdateColumn,
        "resolved canonical agent": r.resolvedCanonicalAgent,
        "resolved team": r.resolvedTeam,
        "panel/team": r.panelTeam,
        "inside selected date range yes/no": insideDateRange ? "yes" : "no",
        "passed status filter yes/no": r.passedStatusFilter ? "yes" : "no",
        "passed team filter yes/no": r.passedTeamFilter ? "yes" : "no",
        "counted yes/no": counted ? "yes" : "no",
        "skip reason": counted ? "counted" : skipReason,
      };
    });
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `loaded_sheet_debug_${data.mode}_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function fetchSheetSourceDirect(meta: SheetSourceMeta): Promise<SheetData> {
    const params = new URLSearchParams({ id: meta.spreadsheetId, gid: meta.gid, _: String(Date.now()) });
    const res = await fetch(`/api/sheet?${params.toString()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const loaded = (await res.json()) as SheetData;
    return { headers: loaded.headers ?? [], rows: loaded.rows ?? [] };
  }

  async function exportJeremyTrace() {
    const metas = [
      SHEET_SOURCES.retentionSubmission,
      SHEET_SOURCES.backend,
      SHEET_SOURCES.idpHandled,
      SHEET_SOURCES.idpCancelRetained,
    ];
    const traceRows: JeremyTraceRow[] = [];
    const summaries: JeremyTraceRow[] = [];

    for (const meta of metas) {
      try {
        const sheet = await fetchSheetSourceDirect(meta);
        const agentCol = sheetAgentColumn(sheet.headers);
        const rowTraces = sheet.rows.map((row, index) =>
          classifyTraceRowForPanel(sheet, row, index + 2, meta, data.mode, roster, fromDate ?? null, toDate ?? null),
        );
        const matches = rowTraces.filter((row) =>
          row["matched search term yes/no"] === "yes" ||
          row["resolved canonical agent"] === "Jeremy Romano" ||
          sheetAgentCandidates(row["raw Agent Name"]).includes("jeremy romano"),
        );
        traceRows.push(...matches);
        summaries.push({
          "source name": meta.sourceName,
          "spreadsheet ID": meta.spreadsheetId,
          gid: meta.gid,
          "tab name": meta.tabName,
          "raw row index": "summary",
          "full raw row JSON": JSON.stringify({
            totalRowsLoaded: sheet.rows.length,
            headers: sheet.headers,
            first3AgentNames: sheet.rows.slice(0, 3).map((row) => sheetAgentValue(row, agentCol)),
            last3AgentNames: sheet.rows.slice(-3).map((row) => sheetAgentValue(row, agentCol)),
            fetchedSuccessfully: true,
            rowsEmpty: sheet.rows.length === 0,
          }),
          "raw Agent Name": "",
          "normalized Agent Name": "",
          "raw Timestamp": "",
          "parsed date": "",
          "raw File ID": "",
          "raw status/update": "",
          "matched search term yes/no": "no",
          "resolved canonical agent": "",
          "resolved team": "",
          "roster active yes/no": "",
          "current panel/team": data.mode,
          "would pass team filter yes/no": "no",
          "would pass date filter yes/no": "no",
          "would pass status filter yes/no": "no",
          "counted by current loader yes/no": "no",
          "exact skip reason": "source-summary",
          "exact function where skipped": "exportJeremyTrace",
        });
      } catch (err) {
        summaries.push({
          "source name": meta.sourceName,
          "spreadsheet ID": meta.spreadsheetId,
          gid: meta.gid,
          "tab name": meta.tabName,
          "raw row index": "summary",
          "full raw row JSON": JSON.stringify({
            totalRowsLoaded: 0,
            headers: [],
            first3AgentNames: [],
            last3AgentNames: [],
            fetchedSuccessfully: false,
            rowsEmpty: true,
            error: err instanceof Error ? err.message : String(err),
          }),
          "raw Agent Name": "",
          "normalized Agent Name": "",
          "raw Timestamp": "",
          "parsed date": "",
          "raw File ID": "",
          "raw status/update": "",
          "matched search term yes/no": "no",
          "resolved canonical agent": "",
          "resolved team": "",
          "roster active yes/no": "",
          "current panel/team": data.mode,
          "would pass team filter yes/no": "no",
          "would pass date filter yes/no": "no",
          "would pass status filter yes/no": "no",
          "counted by current loader yes/no": "no",
          "exact skip reason": "source-fetch-failed",
          "exact function where skipped": "fetchSheetSourceDirect",
        });
      }
    }

    const rows = traceRows.length > 0 ? traceRows : summaries;
    console.warn("[sheet-agent-resolution:jeremy-trace]", rows);
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jeremy_trace_${data.mode}_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ops-input pl-9"
            data-testid="input-search-agent"
          />
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            {visible.length} of {data.byAgent.length} agents
          </Badge>
          {sheetData && (
            <Button variant="outline" size="sm" onClick={exportRawRows} data-testid="button-export-rows">
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export Rows
            </Button>
          )}
          {user.role === "admin" && sheetData?.debugRows && (
            <Button variant="outline" size="sm" onClick={exportLoadedSheetDebug} data-testid="button-export-loaded-sheet-debug">
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export Loaded Sheet Debug
            </Button>
          )}
          {user.role === "admin" && (
            <Button variant="outline" size="sm" onClick={() => void exportJeremyTrace()} data-testid="button-export-jeremy-trace">
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export Jeremy Trace
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="button-export-csv">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export Summary
          </Button>
        </div>
      </div>

      <div className="ops-table-wrap overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 backdrop-blur z-10">
              <TableRow>
                <TableHead className="whitespace-nowrap min-w-[180px]">
                  <SortHeader id="__agent__" label="Agent Name" sort={sort} onToggle={toggle} />
                </TableHead>
                {data.statuses.map((s) => (
                  <TableHead key={s} className={`whitespace-nowrap text-right ${statusTone(s)}`}>
                    <SortHeader id={s} label={s} align="right" sort={sort} onToggle={toggle} />
                  </TableHead>
                ))}
                <TableHead className="whitespace-nowrap text-right bg-primary/5">
                  <SortHeader id="__total__" label="Total" align="right" sort={sort} onToggle={toggle} />
                </TableHead>
                {showRate && (
                  <TableHead className="whitespace-nowrap text-right bg-primary/10">
                    <SortHeader id="__rate__" label="Retention rate" align="right" sort={sort} onToggle={toggle} />
                  </TableHead>
                )}
                <TableHead className="whitespace-nowrap text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={data.statuses.length + 3 + (showRate ? 1 : 0)} className="text-center py-12 text-muted-foreground">
                    No agents match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {visible.map((a) => {
                const parts = agentNameParts(a.agent, roster);
                return (
                <TableRow key={a.agent} className="hover-elevate">
                  <TableCell className="font-medium whitespace-nowrap">
                    <AvatarName name={parts.agentName} size="sm" textClassName="text-foreground" />
                  </TableCell>
                  {data.statuses.map((s) => {
                    const v = a.byStatus.get(s) ?? 0;
                    return (
                      <TableCell key={s} className={`text-right tabular-nums font-mono ${v === 0 ? "text-muted-foreground/40" : statusTone(s)}`}>
                        {v}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/5 metric-info">{a.total}</TableCell>
                  {showRate && (
                    <TableCell className="text-right tabular-nums font-mono font-semibold bg-primary/10">
                      {retentionRate(sumRetained(a.byStatus, data.retainedStatuses), a.total)}
                    </TableCell>
                  )}
                  <TableCell className="text-center">
                    <Button size="sm" variant="outline" className="h-8" onClick={() => setSelectedAgent(a)}>
                      <Eye className="mr-1 h-3.5 w-3.5" />
                      View Details
                    </Button>
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
            {visible.length > 0 && !hideTeamRow && (
              <TableHeader className="sticky bottom-0 backdrop-blur z-10">
                <TableRow>
                  <TableCell className="font-bold whitespace-nowrap">Whole team</TableCell>
                  {data.statuses.map((s) => (
                    <TableCell key={s} className="text-right tabular-nums font-mono font-bold">
                      {data.totals.byStatus.get(s) ?? 0}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">{data.totals.grand}</TableCell>
                  {showRate && (
                    <TableCell className="text-right tabular-nums font-mono font-bold bg-primary/10">
                      {retentionRate(data.totals.retained, data.totals.grand)}
                    </TableCell>
                  )}
                  <TableCell />
                </TableRow>
              </TableHeader>
            )}
          </Table>
        </div>
      </div>
      {selectedAgent && (
        <RosterAgentDetailsDialog rawName={selectedAgent.agent} open={!!selectedAgent} onOpenChange={(open) => !open && setSelectedAgent(null)}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <div className="text-xs text-muted-foreground">Submissions</div>
              <div className="font-medium tabular-nums">{selectedAgent.total}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Call time</div>
              <div className="font-medium tabular-nums">{formatDuration(selectedAgent.seconds)}</div>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.statuses.map((s) => (
              <div key={s} className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-3 py-2">
                <span className={statusTone(s)}>{s}</span>
                <span className="font-semibold tabular-nums">{selectedAgent.byStatus.get(s) ?? 0}</span>
              </div>
            ))}
          </div>
        </RosterAgentDetailsDialog>
      )}
    </div>
  );
}

function agentNameParts(rawName: string, roster?: RosterIndex | null): { agentName: string; aliasName: string } {
  const hit = roster ? resolveSheetAgent(rawName, roster) ?? roster.lookupByAnyName(rawName) : null;
  if (hit) return { agentName: hit.name, aliasName: "" };
  return { agentName: rawName, aliasName: "" };
}

// PBX agent name (normalized) → canonical display name used in the phone/sheet tables.
// Only needed for agents whose PBX name differs from their Quo display name.
const PBX_TO_DISPLAY_NAME: Record<string, string> = {
  "jacob ahmed": "ryan henderson",
  "haythem":     "dean lewis",
};

interface LiveCallStatus {
  quo: Set<string>; // normalized names on Quo right now
  pbx: Set<string>; // normalized PBX agent names on PBX right now
  any: Set<string>; // union — PBX names mapped to their display-name equivalent
  quoParticipant: Map<string, string>; // normName → external number they're talking to
}

function formatParticipant(num: string): string {
  const d = num.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1"))
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10)
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return num;
}

function useLiveCalls(): LiveCallStatus {
  const quoQ = useQuery<{ active: string[]; agentCalls?: { agentName: string; participant: string | null }[] }>({
    queryKey: ["liveCalls"],
    queryFn: async () => {
      const r = await fetch("/api/quo/live");
      if (!r.ok) return { active: [] };
      return r.json() as Promise<{ active: string[]; agentCalls?: { agentName: string; participant: string | null }[] }>;
    },
    refetchInterval: 15 * 1000,
    staleTime: 10 * 1000,
    refetchOnWindowFocus: true,
  });

  const vosQ = useQuery<{ liveCalls: { agentName: string | null }[]; agentStatuses: { name: string; status: string }[] }>({
    queryKey: ["vosLive"],
    queryFn: async () => {
      const r = await fetch("/api/vos/live");
      if (!r.ok) return { liveCalls: [], agentStatuses: [] };
      return r.json();
    },
    refetchInterval: 15 * 1000,
    staleTime: 10 * 1000,
    refetchOnWindowFocus: true,
  });

  return useMemo(() => {
    const quo = new Set<string>();
    const pbx = new Set<string>();
    const any = new Set<string>();
    const quoParticipant = new Map<string, string>();

    for (const name of quoQ.data?.active ?? []) {
      const norm = normalizeAgent(name);
      quo.add(norm);
      any.add(norm);
      // Expand Arabic OpenPhone names to their English display-name equivalents
      // so the retention/CS/NSF panels can match the live dot correctly.
      const alias = PHONE_ALIASES[norm];
      if (alias) { quo.add(alias); any.add(alias); }
    }

    // Populate participant map from agentCalls (DB + poll sources)
    for (const { agentName, participant } of quoQ.data?.agentCalls ?? []) {
      if (!participant) continue;
      const norm = normalizeAgent(agentName);
      quoParticipant.set(norm, participant);
      const alias = PHONE_ALIASES[norm];
      if (alias) quoParticipant.set(alias, participant);
    }

    const addPbx = (name: string) => {
      const norm = name.trim().toLowerCase();
      pbx.add(norm);
      // Map to display name if PBX name differs from the table display name
      any.add(PBX_TO_DISPLAY_NAME[norm] ?? norm);
    };

    for (const c of vosQ.data?.liveCalls ?? []) if (c.agentName) addPbx(c.agentName);
    for (const a of vosQ.data?.agentStatuses ?? []) if (a.status === "on_call") addPbx(a.name);

    return { quo, pbx, any, quoParticipant };
  }, [quoQ.data, vosQ.data]);
}

type PbxAgentEntry = {
  calls: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  durationSeconds: number;
  lastCallAt: string | null;
  groups: string[];
};
type PbxCalls = Map<string, PbxAgentEntry>;

interface VosStatsResponse {
  dashboard: { callsByAgent: { agentName: string; calls: number; inbound: number; outbound: number }[] };
  agents: { id: number; name: string }[];
  ringGroups: { id: number; name: string; agentIds: number[] }[];
  callHistory?: { agentName: string; calls: number; inbound: number; outbound: number; answered: number; missed: number; voicemail: number; durationSeconds: number; lastCallAt: string | null }[];
  ringGroupMissed?: Record<number, number>;
}

function useVosStats() {
  return useQuery<VosStatsResponse>({
    queryKey: ["vosStats"],
    queryFn: async () => {
      const r = await fetch("/api/vos/stats");
      if (!r.ok) return { dashboard: { callsByAgent: [] }, agents: [], ringGroups: [], callHistory: [], ringGroupMissed: {} };
      return r.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Returns missed call counts per ring group ID sourced from PBX voicemail/no-answer records. */
function useVosRingGroupMissed(): Map<number, number> {
  const q = useVosStats();
  return useMemo(() => {
    const raw = q.data?.ringGroupMissed ?? {};
    return new Map(Object.entries(raw).map(([k, v]) => [Number(k), v as number]));
  }, [q.data]);
}

function useVosCalls(): PbxCalls {
  const q = useVosStats();
  return useMemo(() => {
    const m: PbxCalls = new Map();
    const data = q.data;
    if (!data) return m;
    // Build agent ID → ring group names
    const agentGroups = new Map<number, string[]>();
    for (const g of data.ringGroups ?? []) {
      for (const id of g.agentIds) {
        if (!agentGroups.has(id)) agentGroups.set(id, []);
        agentGroups.get(id)!.push(g.name);
      }
    }
    // Build normalized PBX name → agent ID
    const nameToId = new Map<string, number>();
    for (const a of data.agents ?? []) {
      nameToId.set(normalizeAgent(a.name), a.id);
    }
    // Prefer callHistory (rich data) — fall back to dashboard callsByAgent
    const source = (data.callHistory?.length ? data.callHistory : data.dashboard?.callsByAgent) ?? [];
    for (const a of source) {
      const key = normalizeAgent(a.agentName);
      const id = nameToId.get(key);
      const groups = id !== undefined ? (agentGroups.get(id) ?? []) : [];
      const rich = a as { answered?: unknown; missed?: unknown; voicemail?: unknown; durationSeconds?: unknown; lastCallAt?: unknown };
      m.set(key, {
        calls: a.calls,
        inbound: a.inbound,
        outbound: a.outbound,
        answered: typeof rich.answered === "number" ? rich.answered : 0,
        missed: typeof rich.missed === "number" ? rich.missed : 0,
        voicemail: typeof rich.voicemail === "number" ? rich.voicemail : 0,
        durationSeconds: typeof rich.durationSeconds === "number" ? rich.durationSeconds : 0,
        lastCallAt: typeof rich.lastCallAt === "string" ? rich.lastCallAt : null,
        groups,
      });
    }
    return m;
  }, [q.data]);
}

interface MissedNoCallbackItem {
  id: string | number;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  ringGroupId: number;
  ringGroupName: string;
  team: "retention" | "nsf" | "cs" | "other";
  source?: "pbx" | "quo" | "readymode";
}

function useMissedNoCB() {
  return useQuery<{ items: MissedNoCallbackItem[]; fetchedAt: number }>({
    queryKey: ["missedNoCB"],
    queryFn: async () => {
      const r = await fetch("/api/vos/missed-no-callback");
      if (!r.ok) return { items: [], fetchedAt: 0 };
      return r.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

type DailyMissedDay = {
  date: string;
  retention: { quo: number; ghost: number; pbx: number };
  cs: { quo: number; ghost: number; pbx: number };
  nsf: { quo: number; ghost: number; pbx: number };
};

function useMissedDaily(mode: "times" | "numbers" = "times") {
  return useQuery<{ days: DailyMissedDay[] }>({
    queryKey: ["missedDaily", mode],
    queryFn: async () => {
      const r = await fetch(`/api/vos/missed-daily?mode=${mode}`);
      if (!r.ok) return { days: [] };
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

type HourlyMissedHour = {
  hour: number;
  retention: { quo: number; ghost: number; pbx: number };
  cs: { quo: number; ghost: number; pbx: number };
  nsf: { quo: number; ghost: number; pbx: number };
};

function useMissedHourly(date: string, mode: "times" | "numbers" = "times") {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const isToday = date === todayStr;
  return useQuery<{ hours: HourlyMissedHour[] }>({
    queryKey: ["missedHourly", date, mode],
    queryFn: async () => {
      const r = await fetch(`/api/vos/missed-hourly?date=${date}&mode=${mode}`);
      if (!r.ok) return { hours: [] };
      return r.json();
    },
    staleTime: isToday ? 60_000 : Infinity,
    refetchInterval: isToday ? 5 * 60_000 : false,
    refetchOnWindowFocus: isToday,
  });
}

function buildTeamPhoneData(teamMode: string, data: PhoneStatsResponse | null | undefined, roster?: RosterIndex): Map<string, PhoneAgentMetrics> {
  const isTeamMode = teamMode === "retention" || teamMode === "nsf" || teamMode === "cs";
  const rosterTeamAllow = roster && isTeamMode ? roster.allowlist[teamMode as RosterTeam] : undefined;
  const rosterHasAny = !!roster && isTeamMode && rosterHasAnyForTeam(roster, teamMode as RosterTeam);
  const allowlist = unionTeamSet(TEAM_ALLOWLIST[teamMode], rosterTeamAllow, rosterHasAny);
  const phoneAliases = roster?.phoneAliases ?? {};
  const map = new Map<string, PhoneAgentMetrics>();
  const agentStats = data?.allAgentStats ?? data?.teamStats?.[teamMode] ?? {};
  const lastCallMap = data?.allAgentLastCall ?? data?.agentLastCall?.[teamMode] ?? {};
  for (const [agentName, days] of Object.entries(agentStats)) {
    const rawKey = normalizeAgent(agentName);
    if (PHONE_BLOCKLIST.has(rawKey)) continue;
    // Roster is authoritative when populated; legacy PHONE_ALIASES is fallback only.
    const key = phoneAliases[rawKey] ?? PHONE_ALIASES[rawKey] ?? rawKey;
    if (rosterHasAny) {
      const hit = roster?.lookupByAnyName(key) ?? roster?.lookupByAnyName(agentName);
      if (!hit || hit.team !== teamMode) continue;
    } else if (allowlist && !allowlist.has(key)) continue;
    const acc: PhoneAgentMetrics = { calls: 0, seconds: 0, answered: 0, missed: 0, voicemail: 0, vmBrief: 0, inbound: 0, outbound: 0, uniqueContacts: 0, lastCallAt: lastCallMap[agentName] };
    for (const day of Object.values(days)) {
      acc.calls += day.totalCalls ?? 0;
      acc.seconds += day.talkSeconds ?? 0;
      acc.answered += day.answered ?? 0;
      acc.missed += day.missed ?? 0;
      acc.voicemail += day.voicemail ?? 0;
      acc.vmBrief += day.vmBrief ?? 0;
      acc.inbound += day.inbound ?? 0;
      acc.outbound += day.outbound ?? 0;
      acc.uniqueContacts += day.uniqueContacts ?? 0;
    }
    if (acc.calls > 0 || acc.seconds > 0) {
      const e = map.get(key);
      if (e) {
        const mergedLast = e.lastCallAt && acc.lastCallAt ? (e.lastCallAt > acc.lastCallAt ? e.lastCallAt : acc.lastCallAt) : (e.lastCallAt ?? acc.lastCallAt);
        map.set(key, { calls: e.calls + acc.calls, seconds: e.seconds + acc.seconds, answered: e.answered + acc.answered, missed: e.missed + acc.missed, voicemail: e.voicemail + acc.voicemail, vmBrief: e.vmBrief + acc.vmBrief, inbound: e.inbound + acc.inbound, outbound: e.outbound + acc.outbound, uniqueContacts: e.uniqueContacts + acc.uniqueContacts, lastCallAt: mergedLast });
      } else {
        map.set(key, acc);
      }
    }
  }
  return map;
}

function phoneKeyBelongsToTeam(key: string, team: RosterTeam, roster: RosterIndex): boolean {
  if (rosterHasAnyForTeam(roster, team)) {
    return roster.lookupByAnyName(key)?.team === team;
  }
  return (TEAM_ALLOWLIST[team]?.has(key) ?? false) || (roster.allowlist[team]?.has(key) ?? false);
}

function mergeReadyModeForTeam(
  map: Map<string, PhoneAgentMetrics>,
  readymodeByKey: Map<string, { calls: number; seconds: number }>,
  roster: RosterIndex,
  team: RosterTeam,
): Map<string, PhoneAgentMetrics> {
  for (const [rmKey, rm] of readymodeByKey.entries()) {
    if (!phoneKeyBelongsToTeam(rmKey, team, roster)) continue;
    const e = map.get(rmKey);
    if (e) {
      map.set(rmKey, { ...e, calls: e.calls + rm.calls, seconds: e.seconds + rm.seconds, outbound: e.outbound + rm.calls });
    } else {
      map.set(rmKey, { calls: rm.calls, seconds: rm.seconds, answered: 0, missed: 0, voicemail: 0, vmBrief: 0, inbound: 0, outbound: rm.calls, uniqueContacts: 0 });
    }
  }
  return map;
}

function ByCallStatsView({ agentList, phoneData, directKeys, pbxData, extraMissed, agentDept, hideTeamRow, readymodeByKey, rosterPhoneAliases, phoneSourceLabel }: { agentList: string[]; phoneData: Map<string, PhoneAgentMetrics>; directKeys?: boolean; pbxData?: PbxCalls; extraMissed?: number; agentDept?: Map<string, "Retention" | "CS">; hideTeamRow?: boolean; readymodeByKey?: Map<string, { calls: number; seconds: number }>; rosterPhoneAliases?: Record<string, string>; phoneSourceLabel?: string }) {
  // Mirror the canonicalization the panels use when merging ReadyMode into
  // phoneData (see useReadymodeByKey + merge loops in TeamPanel/CSPanel/
  // RetentionPanel). Without the roster + CSV alias passes, aliased agents
  // (e.g. "kevin michael" → "kevin micheal") get folded into Calls totals but
  // show "—" in the ReadyMode column, making the column disagree with totals.
  const getRm = (agent: string) => {
    if (!readymodeByKey) return undefined;
    const norm = normalizeAgent(agent);
    const csvAliased = RM_CSV_ALIASES[norm] ?? norm;
    const aliased = (rosterPhoneAliases?.[csvAliased]) ?? PHONE_ALIASES[csvAliased] ?? csvAliased;
    return readymodeByKey.get(aliased) ?? readymodeByKey.get(csvAliased) ?? readymodeByKey.get(norm);
  };
  const liveAgents = useLiveCalls();

  // Share the ["vosLive"] query key so React Query deduplicates the request.
  const pbxLiveQ = useQuery<{ liveCalls: VosLiveCall[]; agentStatuses: VosAgentStatus[] }>({
    queryKey: ["vosLive"],
    queryFn: async () => {
      const r = await fetch("/api/vos/live");
      if (!r.ok) return { liveCalls: [], agentStatuses: [] };
      return r.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  // normalizedPbxName → live call detail (for direction + duration in pills)
  const pbxLiveByName = useMemo(() => {
    const m = new Map<string, VosLiveCall>();
    for (const c of pbxLiveQ.data?.liveCalls ?? []) {
      if (!c.agentName) continue;
      const norm = c.agentName.trim().toLowerCase();
      m.set(norm, c);
      const displayNorm = PBX_TO_DISPLAY_NAME[norm] ?? norm;
      if (displayNorm !== norm) m.set(displayNorm, c);
    }
    return m;
  }, [pbxLiveQ.data]);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "__calls__", dir: "desc" });

  const getPhone = (agent: string) =>
    directKeys ? phoneData.get(normalizeAgent(agent)) : phoneData.get(sheetToPhoneKey(agent));

  const getPbx = (agent: string) => {
    if (!pbxData) return undefined;
    const norm = normalizeAgent(agent);
    if (directKeys) return pbxData.get(norm);
    // Check explicit PBX alias map first, then fall back to phone key
    const pbxKey = SHEET_TO_PBX[norm] ?? sheetToPhoneKey(agent);
    return pbxData.get(pbxKey);
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (q ? agentList.filter((a) => a.toLowerCase().includes(q)) : agentList)
      .filter((a) => ((getPhone(a)?.calls ?? 0) + (getPbx(a)?.calls ?? 0) + (getRm(a)?.calls ?? 0)) > 0);
    return [...list].sort((a, b) => {
      const phA = getPhone(a);
      const phB = getPhone(b);
      let av: number = 0;
      let bv: number = 0;
      if (sort.col === "__calls__") { av = (phA?.calls ?? 0) + (getPbx(a)?.calls ?? 0) + (getRm(a)?.calls ?? 0); bv = (phB?.calls ?? 0) + (getPbx(b)?.calls ?? 0) + (getRm(b)?.calls ?? 0); }
      else if (sort.col === "__phone__") { av = phA?.calls ?? 0; bv = phB?.calls ?? 0; }
      else if (sort.col === "__outbound__") { av = (phA?.outbound ?? 0) + (getPbx(a)?.outbound ?? 0) + (getRm(a)?.calls ?? 0); bv = (phB?.outbound ?? 0) + (getPbx(b)?.outbound ?? 0) + (getRm(b)?.calls ?? 0); }
      else if (sort.col === "__inbound__") { av = (phA?.inbound ?? 0) + (getPbx(a)?.inbound ?? 0); bv = (phB?.inbound ?? 0) + (getPbx(b)?.inbound ?? 0); }
      else if (sort.col === "__answered__") { av = phA?.answered ?? 0; bv = phB?.answered ?? 0; }
      else if (sort.col === "__missed__") { av = phA?.missed ?? 0; bv = phB?.missed ?? 0; }
      else if (sort.col === "__vm__") { av = phA?.voicemail ?? 0; bv = phB?.voicemail ?? 0; }
      else if (sort.col === "__vmbrief__") { av = phA?.vmBrief ?? 0; bv = phB?.vmBrief ?? 0; }
      else if (sort.col === "__unique__") { av = phA?.uniqueContacts ?? 0; bv = phB?.uniqueContacts ?? 0; }
      else if (sort.col === "__time__") { av = (phA?.seconds ?? 0) + (getPbx(a)?.durationSeconds ?? 0) + (getRm(a)?.seconds ?? 0); bv = (phB?.seconds ?? 0) + (getPbx(b)?.durationSeconds ?? 0) + (getRm(b)?.seconds ?? 0); }
      else if (sort.col === "__resp__") { const ca = (phA?.calls ?? 0) + (getPbx(a)?.calls ?? 0) + (getRm(a)?.calls ?? 0); const cb = (phB?.calls ?? 0) + (getPbx(b)?.calls ?? 0) + (getRm(b)?.calls ?? 0); av = ca ? ((phA?.answered ?? 0) + (getPbx(a)?.answered ?? 0)) / ca : -1; bv = cb ? ((phB?.answered ?? 0) + (getPbx(b)?.answered ?? 0)) / cb : -1; }
      else if (sort.col === "__agent__") { return sort.dir === "asc" ? a.localeCompare(b) : b.localeCompare(a); }
      return sort.dir === "asc" ? av - bv : bv - av;
    });
  }, [agentList, search, sort, phoneData, pbxData, readymodeByKey, rosterPhoneAliases]);

  function toggle(col: string) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: col === "__agent__" ? "asc" : "desc" });
  }

  function Th({ id, label, tone = "", align = "right", tip }: { id: string; label: string; tone?: string; align?: "left" | "right"; tip?: string }) {
    const active = sort.col === id;
    return (
      <TableHead className={`whitespace-nowrap ${align === "right" ? "text-right" : ""} ${tone}`}>
        <div className={`inline-flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
          <button type="button" onClick={() => toggle(id)}
            className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${active ? "metric-info" : "text-muted-foreground"} ${align === "right" ? "flex-row-reverse" : ""}`}>
            {label}
            {active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
          </button>
          {tip && (
            <Tooltip delayDuration={100}>
              <TooltipTrigger asChild>
                <span className="cursor-help shrink-0">
                  <Info className="h-3 w-3 text-muted-foreground/50 hover:text-muted-foreground transition-colors" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[220px] text-center leading-snug">
                {tip}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TableHead>
    );
  }

  const totQuoCalls = visible.reduce((s, a) => s + (getPhone(a)?.calls ?? 0), 0);
  const totPbxCalls = visible.reduce((s, a) => s + (getPbx(a)?.calls ?? 0), 0);
  const totRmCalls = visible.reduce((s, a) => s + (getRm(a)?.calls ?? 0), 0);
  const totCalls = totQuoCalls + totPbxCalls + totRmCalls;
  const totOut = visible.reduce((s, a) => s + (getPhone(a)?.outbound ?? 0) + (getPbx(a)?.outbound ?? 0) + (getRm(a)?.calls ?? 0), 0);
  const totIn = visible.reduce((s, a) => s + (getPhone(a)?.inbound ?? 0) + (getPbx(a)?.inbound ?? 0), 0);
  const totAns = visible.reduce((s, a) => s + (getPhone(a)?.answered ?? 0) + (getPbx(a)?.answered ?? 0), 0);
  const totMissed = visible.reduce((s, a) => s + (getPhone(a)?.missed ?? 0) + (getPbx(a)?.missed ?? 0), 0) + (extraMissed ?? 0);
  const totVm = visible.reduce((s, a) => s + (getPhone(a)?.voicemail ?? 0) + (getPbx(a)?.voicemail ?? 0), 0);
  const totVmBrief = visible.reduce((s, a) => s + (getPhone(a)?.vmBrief ?? 0), 0);
  const totUniq = visible.reduce((s, a) => s + (getPhone(a)?.uniqueContacts ?? 0), 0);
  const totSecs = visible.reduce((s, a) => s + (getPhone(a)?.seconds ?? 0) + (getPbx(a)?.durationSeconds ?? 0) + (getRm(a)?.seconds ?? 0), 0);

  const liveInView = visible.filter((a) => liveAgents.any.has(normalizeAgent(a)));

  return (
    <div className="space-y-4">
      {liveInView.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Live calls right now</p>
          <div className="flex flex-wrap gap-2">
            {liveInView.map((agent) => {
              const norm = normalizeAgent(agent);
              const pbxCall = pbxLiveByName.get(norm);
              return (
                <div key={agent} className="ops-pill flex items-center gap-2 rounded-full px-3 py-1.5 text-xs">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-muted-foreground" />
                  </span>
                  <span className="metric-good font-medium">{agent}</span>
                  <ShiftDot agentName={agent} />
                  {pbxCall && (
                    <>
                      <span className="text-zinc-500">·</span>
                      <span className="text-zinc-400">{pbxCall.direction === "outbound" ? "↑" : "↓"} {formatDuration(pbxCall.duration)}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search agents…" value={search} onChange={(e) => setSearch(e.target.value)} className="ops-input pl-9" />
        </div>
        <Badge variant="secondary" className="font-mono">{visible.length} agents</Badge>
      </div>
      <div className="ops-table-wrap overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 backdrop-blur z-10">
              <TableRow>
                <Th id="__agent__" label="Agent" align="left" />
                <TableHead className="whitespace-nowrap text-right metric-info">Available</TableHead>
                <Th id="__calls__" label="Calls" tip="Total calls across all phone systems (Quo + PBX + ReadyMode) in the selected period." />
                {phoneSourceLabel && <Th id="__phone__" label={phoneSourceLabel} tone="metric-info" tip="Calls assigned to this agent from OpenPhone / QUO call history." />}
                {pbxData && <Th id="__pbx__" label="PBX" tone="metric-info" tip="Calls via the PBX phone system only." />}
                {readymodeByKey && <Th id="__readymode__" label="ReadyMode" tone="metric-secondary" tip="Outbound dialer calls from the ReadyMode CSV (operator-uploaded Google Sheet)." />}
                <Th id="__outbound__" label="Outbound" tone="metric-info" tip="Calls the agent placed to customers (all systems)." />
                <Th id="__inbound__" label="Inbound" tone="metric-info" tip="Calls received from customers (all systems)." />
                <Th id="__answered__" label="Answered" tone="metric-good" tip="Calls where a real conversation happened. Inbound: agent picked up. Outbound: customer stayed on for 60+ seconds." />
                <Th id="__missed__" label="Missed" tone="metric-bad" tip="Calls where no one answered at all — phone rang but nothing picked up." />
                <Th id="__vm__" label="VM Left" tone="metric-warn" tip="Outbound calls where the agent left a voicemail message (20–59s after VM answered)." />
                <Th id="__vmbrief__" label="No VM" tone="metric-warn" tip="Outbound calls that reached voicemail but the agent hung up without leaving a message." />
                <Th id="__unique__" label="CX Reached" tone="metric-info" tip="Unique phone numbers the agent spoke with (inbound or outbound). Each number counted once regardless of how many times they interacted." />
                <Th id="__time__" label="Talk time" tip="Total duration of all calls combined." />
                <Th id="__resp__" label="Response %" tone="metric-warn" tip="Percentage of total calls that resulted in a real conversation (Answered ÷ Total Calls)." />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12 + (phoneSourceLabel ? 1 : 0) + (pbxData ? 1 : 0) + (readymodeByKey ? 1 : 0)} className="text-center py-12 text-muted-foreground">No agents match the current filters.</TableCell>
                </TableRow>
              )}
              {visible.map((agent) => {
                const ph = getPhone(agent);
                const px = getPbx(agent);
                const rm = getRm(agent);
                const combinedCalls = (ph?.calls ?? 0) + (px?.calls ?? 0) + (rm?.calls ?? 0);
                const combinedOut = (ph?.outbound ?? 0) + (px?.outbound ?? 0) + (rm?.calls ?? 0);
                const combinedIn = (ph?.inbound ?? 0) + (px?.inbound ?? 0);
                const combinedAns = (ph?.answered ?? 0) + (px?.answered ?? 0);
                const combinedMissed = (ph?.missed ?? 0) + (px?.missed ?? 0);
                const combinedVm = (ph?.voicemail ?? 0) + (px?.voicemail ?? 0);
                const combinedSecs = (ph?.seconds ?? 0) + (px?.durationSeconds ?? 0) + (rm?.seconds ?? 0);
                const lastCall = ph?.lastCallAt && px?.lastCallAt
                  ? (ph.lastCallAt > px.lastCallAt ? ph.lastCallAt : px.lastCallAt)
                  : (ph?.lastCallAt ?? px?.lastCallAt ?? null);
                const phoneKey = directKeys ? normalizeAgent(agent) : sheetToPhoneKey(agent);
                const onQuo = liveAgents.quo.has(phoneKey);
                const onPbx = liveAgents.any.has(phoneKey) && !onQuo;
                const onBoth = onQuo && liveAgents.pbx.has(normalizeAgent(agent));
                const isLive = onQuo || onPbx || onBoth;
                const dept = agentDept?.get(normalizeAgent(agent));
                return (
                  <TableRow key={agent} className="hover-elevate">
                    <TableCell className="font-medium whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {isLive && (
                          onBoth ? (
                            <span className="relative flex h-2.5 w-2.5 shrink-0" title="On a live call — both Quo & PBX">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-muted-foreground" />
                            </span>
                          ) : onPbx ? (
                            <span className="relative flex h-2.5 w-2.5 shrink-0" title="On a live call — PBX">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-muted-foreground" />
                            </span>
                          ) : (
                            <span className="relative flex h-2.5 w-2.5 shrink-0" title="On a live call — Quo">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-muted-foreground" />
                            </span>
                          )
                        )}
                        <AvatarName name={agent} size="sm" textClassName="text-foreground" />
                        <ShiftDot agentName={agent} />
                        {dept && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold leading-none ${dept === "Retention" ? "bg-muted-foreground/20 metric-info border border-border" : "bg-muted metric-good border border-border"}`}>
                            {dept}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {isLive ? (() => {
                        const participant = onQuo ? liveAgents.quoParticipant.get(phoneKey) : undefined;
                        const label = `On call ${onBoth ? "(Quo + PBX)" : onPbx ? "(PBX)" : "(Quo)"}`;
                        const cls = `font-medium text-xs ${onBoth ? "metric-info" : onPbx ? "metric-info" : "metric-good"}`;
                        return participant ? (
                          <Tooltip delayDuration={120}>
                            <TooltipTrigger asChild>
                              <span className={`${cls} cursor-help underline decoration-dotted underline-offset-2`}>{label}</span>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="font-mono text-xs">
                              {formatParticipant(participant)}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span className={cls}>{label}</span>
                        );
                      })() : (
                        <AvailableSince isoStr={lastCall ?? undefined} />
                      )}
                    </TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!combinedCalls ? "text-muted-foreground/40" : ""}`}>{combinedCalls || "—"}</TableCell>
                    {phoneSourceLabel && <TableCell className={`text-right tabular-nums font-mono ${ph?.calls ? "metric-info" : "text-muted-foreground/40"}`}>{ph?.calls || "—"}</TableCell>}
                    {pbxData && <TableCell className={`text-right tabular-nums font-mono ${px?.calls ? "metric-info" : "text-muted-foreground/40"}`}>{px?.calls || "—"}</TableCell>}
                    {readymodeByKey && <TableCell className={`text-right tabular-nums font-mono ${rm?.calls ? "metric-secondary" : "text-muted-foreground/40"}`}>{rm?.calls || "—"}</TableCell>}
                    <TableCell className={`text-right tabular-nums font-mono ${combinedOut ? "metric-info" : "text-muted-foreground/40"}`}>{combinedOut || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedIn ? "metric-info" : "text-muted-foreground/40"}`}>{combinedIn || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedAns ? "metric-good" : "text-muted-foreground/40"}`}>{combinedAns || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedMissed ? "metric-bad" : "text-muted-foreground/40"}`}>{combinedMissed || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedVm ? "metric-warn" : "text-muted-foreground/40"}`}>{combinedVm || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.vmBrief ? "metric-warn" : "text-muted-foreground/40"}`}>{ph?.vmBrief || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${ph?.uniqueContacts ? "metric-info" : "text-muted-foreground/40"}`}>{ph?.uniqueContacts || "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${!combinedSecs ? "text-muted-foreground/40" : ""}`}>{combinedSecs ? formatDuration(combinedSecs) : "—"}</TableCell>
                    <TableCell className={`text-right tabular-nums font-mono ${combinedCalls ? "metric-warn" : "text-muted-foreground/40"}`}>{(ph || px) ? responseRate(combinedAns, combinedCalls) : "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {visible.length > 0 && !hideTeamRow && (
              <TableHeader className="sticky bottom-0 backdrop-blur z-10">
                <TableRow>
                  <TableCell className="font-bold">Whole team</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums font-mono font-bold">{totCalls || "—"}</TableCell>
                  {phoneSourceLabel && <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totQuoCalls || "—"}</TableCell>}
                  {pbxData && <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totPbxCalls || "—"}</TableCell>}
                  {readymodeByKey && <TableCell className="text-right tabular-nums font-mono font-bold metric-secondary">{visible.reduce((s, a) => s + (getRm(a)?.calls ?? 0), 0) || "—"}</TableCell>}
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totOut || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totIn || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-good">{totAns || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-bad">{totMissed || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-warn">{totVm || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-warn">{totVmBrief || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totUniq || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold">{totSecs ? formatDuration(totSecs) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono font-bold metric-warn">{responseRate(totAns, totCalls)}</TableCell>
                </TableRow>
              </TableHeader>
            )}
          </Table>
        </div>
      </div>
    </div>
  );
}

function DateFilters({
  minDate,
  maxDate,
  from,
  to,
  setFrom,
  setTo,
  onReset,
}: {
  minDate: Date | null;
  maxDate: Date | null;
  from: string;
  to: string;
  setFrom: (s: string) => void;
  setTo: (s: string) => void;
  onReset: () => void;
}) {
  const minIso = minDate ? toIsoDate(minDate) : undefined;
  const maxIso = maxDate ? toIsoDate(maxDate) : undefined;
  return (
    <div className="calendar-filter-strip flex flex-col sm:flex-row sm:items-end gap-3 flex-wrap">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Calendar className="h-4 w-4" />
        <span className="text-sm font-medium">Date range</span>
      </div>
      <div className="space-y-1">
        <Label htmlFor="from" className="text-xs text-muted-foreground">From</Label>
        <AnimatedDatePicker
          value={from}
          min={minIso}
          max={maxIso}
          onChange={setFrom}
          className="w-[170px]"
          ariaLabel="From date"
          title="From date"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="to" className="text-xs text-muted-foreground">To</Label>
        <AnimatedDatePicker
          value={to}
          min={minIso}
          max={maxIso}
          onChange={setTo}
          className="w-[170px]"
          ariaLabel="To date"
          title="To date"
        />
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const today = todayPDT();
            setFrom(today);
            setTo(today);
          }}
          data-testid="button-today"
        >
          Today
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            const { year, month } = nowPDTParts();
            const start = new Date(year, month, 1);
            const end = new Date(year, month + 1, 0);
            setFrom(toIsoDate(start));
            setTo(toIsoDate(end));
          }}
          data-testid="button-this-month"
        >
          This month
        </Button>
        {minDate && maxDate && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setFrom(toIsoDate(minDate));
              setTo(toIsoDate(maxDate));
            }}
            data-testid="button-all-time"
          >
            All time
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onReset} data-testid="button-clear">
          Clear
        </Button>
      </div>
      {minDate && maxDate && (
        <span className="text-xs text-muted-foreground sm:ml-auto">
          Sheet covers {minDate.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric", year: "numeric" })} – {maxDate.toLocaleDateString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric", year: "numeric" })}
        </span>
      )}
    </div>
  );
}

type Preset = { label: string; from: string; to: string };

function dateFromIso(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

function formatPickerDate(value: string): string {
  const date = dateFromIso(value);
  if (!date) return "Select date";
  return date.toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

function AnimatedDatePicker({
  value,
  onChange,
  min,
  max,
  className,
  ariaLabel,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  className?: string;
  ariaLabel: string;
  title?: string;
}) {
  const selected = dateFromIso(value);
  const minDate = dateFromIso(min);
  const maxDate = dateFromIso(max);
  const disabled = [
    ...(minDate ? [{ before: minDate }] : []),
    ...(maxDate ? [{ after: maxDate }] : []),
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={ariaLabel}
          title={title ?? ariaLabel}
          data-calendar-date-input
          className={cn(
            "h-8 justify-between gap-2 rounded-md border border-input bg-background px-2 text-xs font-semibold text-foreground hover:bg-accent hover:text-accent-foreground",
            className,
          )}
        >
          <span className="tabular-nums">{formatPickerDate(value)}</span>
          <Calendar className="h-3.5 w-3.5 shrink-0 opacity-80" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="animated-date-popover w-auto p-0 overflow-hidden border-white/10 bg-zinc-900/95"
        data-animated-calendar-menu
      >
        <CalendarPicker
          mode="single"
          className="animated-date-calendar"
          selected={selected}
          defaultMonth={selected ?? maxDate ?? new Date()}
          disabled={disabled}
          onSelect={(day) => {
            if (day) onChange(toIsoDate(day));
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function getPresets(): Preset[] {
  const { year, month, date } = nowPDTParts();
  const today = todayPDT();
  const yesterday = toIsoDate(new Date(year, month, date - 1));
  const firstOfMonth = toIsoDate(new Date(year, month, 1));
  const lastOfMonth = toIsoDate(new Date(year, month + 1, 0));
  const firstOfLastMonth = toIsoDate(new Date(year, month - 1, 1));
  const lastOfLastMonth = toIsoDate(new Date(year, month, 0));
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: yesterday, to: yesterday },
    { label: "This Month", from: firstOfMonth, to: lastOfMonth },
    { label: "Last Month", from: firstOfLastMonth, to: lastOfLastMonth },
    { label: "All time", from: "2024-01-01", to: today },
  ];
}

function PresetFilter({ from, to, setFrom, setTo }: { from: string; to: string; setFrom: (s: string) => void; setTo: (s: string) => void }) {
  const presets = getPresets();
  const active = presets.find((p) => p.from === from && p.to === to)?.label;
  const todayIso = todayPDT();
  return (
    <div className="calendar-filter-strip flex gap-2 flex-wrap items-center">
      <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
      {presets.map((p) => (
        <Button
          key={p.label}
          variant={active === p.label ? "default" : "outline"}
          size="sm"
          className={active === p.label ? "bg-primary hover:bg-primary/90 text-primary-foreground" : ""}
          onClick={() => { setFrom(p.from); setTo(p.to); }}
        >
          {p.label}
        </Button>
      ))}
      <span className="text-muted-foreground text-xs mx-1">|</span>
      <AnimatedDatePicker
        value={from}
        max={todayIso}
        onChange={setFrom}
        className="w-[130px]"
        ariaLabel="From date"
        title="From date"
      />
      <span className="text-muted-foreground text-xs">–</span>
      <AnimatedDatePicker
        value={to}
        max={todayIso}
        onChange={setTo}
        className="w-[130px]"
        ariaLabel="To date"
        title="To date"
      />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-64" />
      <div className="space-y-2 rounded-lg border p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center space-y-3">
      <p className="text-sm text-destructive font-medium">{message}</p>
      <Button variant="outline" onClick={onRetry} data-testid="button-retry">
        <RefreshCw className="h-4 w-4 mr-2" />
        Try again
      </Button>
    </div>
  );
}

interface PhoneAgentMetrics {
  calls: number;
  seconds: number;
  answered: number;
  missed: number;
  voicemail: number;
  vmBrief: number;
  inbound: number;
  outbound: number;
  uniqueContacts: number;
  lastCallAt?: string;
}

interface PhoneAgentDay {
  totalCalls: number;
  talkSeconds: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  voicemail: number;
  vmBrief: number;
  uniqueContacts: number;
}

interface PhoneStatsResponse {
  teamStats: Record<string, Record<string, Record<string, PhoneAgentDay>>>;
  allAgentStats?: Record<string, Record<string, PhoneAgentDay>>;
  agentLastCall?: Record<string, Record<string, string>>;
  allAgentLastCall?: Record<string, string>;
}

async function fetchPhoneStats(pFrom: string, pTo: string): Promise<PhoneStatsResponse | null> {
  const params = new URLSearchParams({ from: pFrom, to: pTo, _: String(Date.now()) });
  const res = await fetch(`/api/quo/stats?${params.toString()}`, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });
  if (!res.ok) return null;
  return res.json() as Promise<PhoneStatsResponse>;
}

/**
 * Fetch ReadyMode dialer per-agent call totals (CSV-backed) and resolve each
 * CSV name to its canonical dashboard key via RM_CSV_SKIP/RM_CSV_ALIASES,
 * roster phone aliases, and PHONE_ALIASES. Shared by every team panel so the
 * NSF / Retention / CS "By call" tables agree on the same merge rules.
 */
function useReadymodeByKey(from: string, to: string, roster: RosterIndex): Map<string, { calls: number; seconds: number }> {
  const readymodeQ = useQuery<{ agents?: { agentName: string; dialed: number; talkTimeSecs: number }[] } | null>({
    queryKey: ["readymodeStats", from, to],
    queryFn: async () => {
      const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await fetch(`/api/readymode/stats${qs}`);
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 1000 * 30,
    refetchOnWindowFocus: true,
    refetchInterval: 60 * 1000,
  });
  return useMemo<Map<string, { calls: number; seconds: number }>>(() => {
    const m = new Map<string, { calls: number; seconds: number }>();
    for (const a of readymodeQ.data?.agents ?? []) {
      const rawKey = normalizeAgent(a.agentName);
      if (RM_CSV_SKIP.has(rawKey)) continue;
      const csvAliased = RM_CSV_ALIASES[rawKey] ?? rawKey;
      const aliased = roster.phoneAliases[csvAliased] ?? PHONE_ALIASES[csvAliased] ?? csvAliased;
      const prev = m.get(aliased) ?? { calls: 0, seconds: 0 };
      m.set(aliased, { calls: prev.calls + (a.dialed ?? 0), seconds: prev.seconds + (a.talkTimeSecs ?? 0) });
    }
    return m;
  }, [readymodeQ.data, roster]);
}

function TeamPanel({
  urls,
  sheetKey,
  label,
  mode,
  statusQueryFn,
}: {
  urls: { status: string };
  sheetKey: string;
  label: string;
  mode: TeamMode;
  statusQueryFn?: (roster: RosterIndex, opts?: { includeInactive?: boolean }) => Promise<SheetData>;
}) {
  const { user: panelUser } = useUser();
  const isRestricted = !!(panelUser.allowedAgents?.length);
  const lockToToday = !!panelUser.lockToToday;
  const allowedSubTabs = panelUser.allowedSubTabs ?? null;
  const subTabAllowed = (t: string) => !allowedSubTabs || allowedSubTabs.includes(t);
  const defaultSubTab = (allowedSubTabs?.[0] ?? "call");
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // Retention ring group = 2, Back-end (NSF) ring group = 3 in VoSLogic
  const pbxMissed = mode === "retention" ? (ringGroupMissed.get(2) ?? 0) : mode === "nsf" ? (ringGroupMissed.get(3) ?? 0) : 0;
  const roster = useRoster();

  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  // If the user is locked to today, force the range even after midnight rollover.
  useEffect(() => {
    if (lockToToday) { setFrom(todayIso); setTo(todayIso); }
  }, [lockToToday, todayIso]);
  // Past-date view: when the selected range ends before today, include inactive
  // agents so historical attribution stays intact even after deactivation.
  const includeInactive = to < todayIso;

  const statusQ = useQuery({
    queryKey: ["status", sheetKey, roster.version, includeInactive],
    queryFn: statusQueryFn ? () => statusQueryFn(roster, { includeInactive }) : (() => fetchHeaderCsv(urls.status)),
    staleTime: SHEET_STALE_MS,
    refetchOnWindowFocus: false,
    refetchInterval: SHEET_REFETCH_MS,
  });
  const isLoading = statusQ.isLoading;
  const isFetching = statusQ.isFetching;
  const error = statusQ.error;

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", mode, from, to],
    queryFn: async () => {
      const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();
      return fetchPhoneStats(pFrom, pTo);
    },
    staleTime: PHONE_STALE_MS,
    refetchOnWindowFocus: false,
    refetchInterval: PHONE_REFETCH_MS,
  });

  const readymodeByKey = useReadymodeByKey(from, to, roster);

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = buildTeamPhoneData(mode, phoneQ.data, roster);
    return mergeReadyModeForTeam(map, readymodeByKey, roster, mode as RosterTeam);
  }, [phoneQ.data, mode, readymodeByKey, roster]);

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, mode, fromDate, toDate, roster);
  }, [statusQ.data, mode, from, to, roster]);

  const phoneTotals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; }
    return { calls, seconds, answered };
  }, [phoneData]);

  // Build the "By call" agent list:
  // 1. Sheet agents (best display names)
  // 2. Explicit TEAM_PHONE_EXTRAS not already covered
  // 3. Any remaining agent in phoneData (already team-filtered by OpenPhone line)
  const callAgentList = useMemo(() => {
    const result: string[] = [];
    const addedKeys = new Set<string>();
    // When the roster drives this team, ONLY roster members appear; hardcoded
    // seeds and PBX ring-group auto-adds are bypassed (roster is canonical).
    const rosterDrives = rosterDrivesTeam(roster, mode as "retention" | "nsf" | "cs");
    const inRoster = (rawKey: string) =>
      !rosterDrives || (roster.allowlist[mode as RosterTeam]?.has(rawKey) ?? false);

    // Roster-driven mode should still show active team members even before
    // they have calls or sheet rows in the selected range.
    if (rosterDrives) {
      for (const a of roster.agentsForTeam(mode as RosterTeam)) {
        const key = normalizeAgent(a.name);
        if (!addedKeys.has(key)) { result.push(a.name); addedKeys.add(key); }
      }
    }

    // Sheet agents — prefer their display names
    if (aggregated && !("error" in aggregated)) {
      for (const { agent } of aggregated.byAgent) {
        const key = sheetToPhoneKey(agent);
        if (!inRoster(key)) continue;
        if (!addedKeys.has(key)) { result.push(agent); addedKeys.add(key); }
      }
    }

    // Explicit extras (e.g. Youssef Nasser, Michael Ross) — fallback only.
    if (!rosterDrives) {
      for (const extra of TEAM_PHONE_EXTRAS[mode] ?? []) {
        const key = normalizeAgent(extra);
        if (!addedKeys.has(key)) { result.push(extra); addedKeys.add(key); }
      }
    }

    // Everyone else who made calls on this team's OpenPhone lines
    for (const key of phoneData.keys()) {
      if (!inRoster(key)) continue;
      if (!addedKeys.has(key)) {
        result.push(key.replace(/\b\w/g, (c) => c.toUpperCase()));
        addedKeys.add(key);
      }
    }

    // PBX-only agents: in the right ring group but not already listed or covered by a sheet alias.
    // Only auto-add when the roster does NOT drive this team (fallback behaviour).
    if (!rosterDrives) {
      const pbxRingGroup = mode === "retention" ? "Retention" : mode === "nsf" ? "Back-end" : null;
      const coveredPbxKeys = new Set(Object.values(SHEET_TO_PBX));
      if (pbxRingGroup && pbxData) {
        for (const [pbxKey, pbxAgent] of pbxData.entries()) {
          if (pbxAgent.groups.includes(pbxRingGroup) && !addedKeys.has(pbxKey) && !coveredPbxKeys.has(pbxKey)) {
            result.push(pbxKey.replace(/\b\w/g, (c) => c.toUpperCase()));
            addedKeys.add(pbxKey);
          }
        }
      }
    }

    return result;
  }, [aggregated, phoneData, mode, pbxData, roster]);

  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of callAgentList) {
      const pbxKey = resolvePbxKey(agent, roster);
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0;
      answered += px?.answered ?? 0;
      seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, callAgentList]);

  function refresh() {
    statusQ.refetch();
    phoneQ.refetch();
  }

  return (
    <Card className="ops-panel rounded-lg">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">{label}</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Calls, time, and outcomes · live from OpenPhone · syncs every 30 sec
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={isFetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading && <TableSkeleton />}
        {error && (
          <ErrorState
            message={error instanceof Error ? error.message : "Failed to load data."}
            onRetry={refresh}
          />
        )}
        {aggregated && "error" in aggregated && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {aggregated.error}
          </div>
        )}
        {!lockToToday && <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />}

        {(aggregated && !("error" in aggregated)) || callAgentList.length > 0 ? (
          <>
            {!isRestricted && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {subTabAllowed("call") && <>
                <StatTile label="Agents" value={callAgentList.length} icon={<Users className="h-3.5 w-3.5" />} tone="blue" />
                <StatTile
                  label="Total calls"
                  value={(phoneTotals.calls + pbxTotals.calls).toLocaleString()}
                  icon={<Phone className="h-3.5 w-3.5" />}
                  tone="sky"
                />
                <StatTile
                  label="Answered"
                  value={(phoneTotals.answered + pbxTotals.answered).toLocaleString()}
                  tone="emerald"
                />
                <StatTile
                  label="Time on calls"
                  value={formatHours(phoneTotals.seconds + pbxTotals.seconds)}
                  icon={<Clock className="h-3.5 w-3.5" />}
                  tone="amber"
                />
                <StatTile
                  label="Response rate"
                  value={responseRate(phoneTotals.answered + pbxTotals.answered, phoneTotals.calls + pbxTotals.calls)}
                  tone="amber"
                />
              </>}
              {aggregated && !("error" in aggregated) && subTabAllowed("files") && (mode === "nsf" ? (
                <>
                  <StatTile label="Today's fixed" value={aggregated.todayCount.toLocaleString()} tone="emerald" />
                  {!lockToToday && <StatTile label="This month's fixed" value={aggregated.monthCount.toLocaleString()} tone="emerald" />}
                  {!lockToToday && <StatTile label="Total fixed" value={aggregated.totals.grand.toLocaleString()} tone="blue" />}
                </>
              ) : (
                <>
                  <StatTile label="Today's retains" value={aggregated.todayRetained.toLocaleString()} tone="emerald" />
                  {!lockToToday && <StatTile label="This month's retains" value={aggregated.monthRetained.toLocaleString()} tone="emerald" />}
                  {!lockToToday && <StatTile label="This month's cancels" value={aggregated.monthCancelled.toLocaleString()} tone="rose" />}
                  {!lockToToday && <StatTile label="Retention rate" value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)} tone="blue" />}
                </>
              ))}
            </div>}

            <Tabs defaultValue={defaultSubTab} className="space-y-4">
              <TabsList>
                {subTabAllowed("call") && <TabsTrigger value="call" data-testid="subtab-call">By call</TabsTrigger>}
                {aggregated && !("error" in aggregated) && (
                  <>
                    {subTabAllowed("files") && <TabsTrigger value="files" data-testid="subtab-agent">By files</TabsTrigger>}
                    {subTabAllowed("day") && <TabsTrigger value="day" data-testid="subtab-day">By day</TabsTrigger>}
                  </>
                )}
              </TabsList>
              {subTabAllowed("call") && (
                <TabsContent value="call">
                  <ByCallStatsView agentList={callAgentList} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} hideTeamRow={isRestricted} readymodeByKey={readymodeByKey} rosterPhoneAliases={roster.phoneAliases} />
                </TabsContent>
              )}
              {aggregated && !("error" in aggregated) && (
                <>
                  {subTabAllowed("files") && (
                    <TabsContent value="files">
                      <ByFilesView data={aggregated} hideTeamRow={isRestricted} phoneData={phoneData} sheetData={statusQ.data} fromDate={fromDate} toDate={toDate} />
                    </TabsContent>
                  )}
                  {subTabAllowed("day") && (
                    <TabsContent value="day">
                      <ByDayView data={aggregated} />
                    </TabsContent>
                  )}
                </>
              )}
            </Tabs>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

const CS_AGENTS = ["Ella Monroe", "Chase Miller", "Leo Carter", "Nora Adam", "Anna Stone", "Jacob Xander", "Carla Bennet"];
const RETENTION_AGENTS = ["Levi Miller", "Henry Hart", "Rick Miller", "Michael Belfort", "Ryan Henderson", "Katherine Adams", "Talia Morgan", "Jacob Stephenson", "John Marcus", "Dean Lewis"];

function CSPanel() {
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // CS ring group ID = 4 in VoSLogic
  const pbxMissed = ringGroupMissed.get(4) ?? 0;
  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const roster = useRoster();

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  // Past-date view: when the selected range ends before today, include inactive
  // agents so historical attribution stays intact even after deactivation.
  const includeInactive = to < todayIso;
  const statusQ = useQuery({
    queryKey: ["status", "cs", roster.version, includeInactive],
    queryFn: () => fetchCSBackendStatsSheet(roster),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: 60 * 1000,
  });

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", "cs", from, to],
    queryFn: async () => {
      const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();
      const res = await fetch(`/api/quo/stats?from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`);
      if (!res.ok) return null;
      return res.json() as Promise<PhoneStatsResponse>;
    },
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: 60 * 1000,
  });

  const readymodeByKey = useReadymodeByKey(from, to, roster);

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, "cs", fromDate, toDate, roster);
  }, [statusQ.data, from, to, roster]);

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = buildTeamPhoneData("cs", phoneQ.data, roster);
    return mergeReadyModeForTeam(map, readymodeByKey, roster, "cs");
  }, [phoneQ.data, readymodeByKey, roster]);

  const { user: csUser } = useUser();
  const csLockToToday = !!csUser.lockToToday;
  const csAllowedSubTabs = csUser.allowedSubTabs ?? null;
  const csSubTabAllowed = (t: string) => !csAllowedSubTabs || csAllowedSubTabs.includes(t);
  const csDefaultSubTab = (csAllowedSubTabs?.[0] ?? "call");
  useEffect(() => {
    if (csLockToToday) { setFrom(todayPDT()); setTo(todayPDT()); }
  }, [csLockToToday, todayIso]);
  const allAgents = useMemo(() => {
    const result: string[] = [];
    const addedKeys = new Set<string>();
    // Roster-driven mode: only active CS roster members appear; hardcoded
    // CS_AGENTS and PBX "Customer Support" ring-group auto-adds are bypassed.
    const rosterDrives = rosterDrivesTeam(roster, "cs");
    const inRoster = (rawKey: string) => !rosterDrives || (roster.allowlist.cs?.has(rawKey) ?? false);
    if (rosterDrives) {
      for (const a of roster.agentsForTeam("cs")) {
        const k = normalizeAgent(a.name);
        if (!addedKeys.has(k)) { result.push(a.name); addedKeys.add(k); }
      }
    }
    if (!rosterDrives) {
      for (const a of CS_AGENTS) {
        const k = normalizeAgent(a);
        if (!addedKeys.has(k)) { result.push(a); addedKeys.add(k); }
      }
    }
    for (const k of phoneData.keys()) {
      if (!inRoster(k)) continue;
      if (!addedKeys.has(k)) { result.push(k.replace(/\b\w/g, (c) => c.toUpperCase())); addedKeys.add(k); }
    }
    if (!rosterDrives && pbxData) {
      for (const [pbxKey, pbxAgent] of pbxData.entries()) {
        if (pbxAgent.groups.includes("Customer Support") && !addedKeys.has(pbxKey)) {
          result.push(pbxKey.replace(/\b\w/g, (c) => c.toUpperCase()));
          addedKeys.add(pbxKey);
        }
      }
    }
    const aa = csUser.allowedAgents;
    if (!aa || aa.length === 0) return result;
    return result.filter((a) => aa.some((x) => normalizeAgent(x) === normalizeAgent(a)));
  }, [phoneData, pbxData, csUser.allowedAgents, roster]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0, uniqueContacts = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed; uniqueContacts += v.uniqueContacts; }
    return { calls, seconds, answered, missed, uniqueContacts };
  }, [phoneData]);

  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of allAgents) {
      const pbxKey = resolvePbxKey(agent, roster);
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0; answered += px?.answered ?? 0; seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, allAgents]);

  function refresh() { statusQ.refetch(); phoneQ.refetch(); }

  return (
    <Card className="ops-panel rounded-lg">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">Internal CS</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Call activity &amp; files · live from OpenPhone + PBX
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={phoneQ.isFetching || statusQ.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${(phoneQ.isFetching || statusQ.isFetching) ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {(phoneQ.isLoading || statusQ.isLoading) && <TableSkeleton />}

        {!csLockToToday && <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {csSubTabAllowed("call") && <>
            <StatTile label="Agents" value={allAgents.length} icon={<Users className="h-3.5 w-3.5" />} tone="blue" />
            <StatTile label="Total calls" value={(totals.calls + pbxTotals.calls).toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
            <StatTile label="Answered" value={(totals.answered + pbxTotals.answered).toLocaleString()} tone="emerald" />
            <StatTile label="Missed" value={(totals.missed + pbxMissed).toLocaleString()} tone="rose" />
            <StatTile label="Time on calls" value={formatHours(totals.seconds + pbxTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
            <StatTile label="Response rate" value={responseRate(totals.answered + pbxTotals.answered, totals.calls + pbxTotals.calls)} tone="amber" />
          </>}
          {aggregated && !("error" in aggregated) && csSubTabAllowed("files") && (
            <>
              <StatTile label="Today's retains" value={aggregated.todayRetained.toLocaleString()} tone="emerald" />
              {!csLockToToday && <StatTile label="This month's retains" value={aggregated.monthRetained.toLocaleString()} tone="emerald" />}
              {!csLockToToday && <StatTile label="This month's cancels" value={aggregated.monthCancelled.toLocaleString()} tone="rose" />}
              {!csLockToToday && <StatTile label="Retention rate" value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)} tone="blue" />}
            </>
          )}
        </div>

        <Tabs defaultValue={csDefaultSubTab} className="space-y-4">
          <TabsList>
            {csSubTabAllowed("call") && <TabsTrigger value="call">By call</TabsTrigger>}
            {aggregated && !("error" in aggregated) && (
              <>
                {csSubTabAllowed("files") && <TabsTrigger value="files">By files</TabsTrigger>}
                {csSubTabAllowed("day") && <TabsTrigger value="day">By day</TabsTrigger>}
              </>
            )}
          </TabsList>
          {csSubTabAllowed("call") && (
            <TabsContent value="call">
              <ByCallStatsView agentList={allAgents} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} readymodeByKey={readymodeByKey} rosterPhoneAliases={roster.phoneAliases} />
            </TabsContent>
          )}
          {aggregated && !("error" in aggregated) && (
            <>
              {csSubTabAllowed("files") && (
                <TabsContent value="files">
                  <ByFilesView data={aggregated} phoneData={phoneData} sheetData={statusQ.data} fromDate={fromDate} toDate={toDate} />
                </TabsContent>
              )}
              {csSubTabAllowed("day") && (
                <TabsContent value="day">
                  <ByDayView data={aggregated} />
                </TabsContent>
              )}
            </>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function RetentionPanel() {
  const { user: retUser } = useUser();
  const retLockToToday = !!retUser.lockToToday;
  const retAllowedSubTabs = retUser.allowedSubTabs ?? null;
  const retSubTabAllowed = (t: string) => !retAllowedSubTabs || retAllowedSubTabs.includes(t);
  const retDefaultSubTab = (retAllowedSubTabs?.[0] ?? "call");
  const pbxData = useVosCalls();
  const ringGroupMissed = useVosRingGroupMissed();
  // Retention ring group ID = 2 in VoSLogic
  const pbxMissed = ringGroupMissed.get(2) ?? 0;

  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  useEffect(() => {
    if (retLockToToday) { setFrom(todayIso); setTo(todayIso); }
  }, [retLockToToday, todayIso]);
  const roster = useRoster();

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  // Past-date view: when the selected range ends before today, include inactive
  // agents so historical attribution stays intact even after deactivation.
  const includeInactive = to < todayIso;
  const statusQ = useQuery({
    queryKey: ["status", "retention", roster.version, includeInactive],
    queryFn: () => fetchRetentionBackendStatsSheet(roster),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: 60 * 1000,
  });

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["phoneStats", "retention", from, to],
    queryFn: async () => {
      const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();
      const res = await fetch(`/api/quo/stats?from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`);
      if (!res.ok) return null;
      return res.json() as Promise<PhoneStatsResponse>;
    },
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: 60 * 1000,
  });

  const aggregated = useMemo(() => {
    if (!statusQ.data) return null;
    return aggregate(statusQ.data, "retention", fromDate, toDate, roster);
  }, [statusQ.data, from, to, roster]);

  const readymodeByKey = useReadymodeByKey(from, to, roster);

  const phoneData = useMemo(() => {
    const base = buildTeamPhoneData("retention", phoneQ.data, roster);
    const allowlist = unionTeamSet(TEAM_ALLOWLIST["retention"], roster.allowlist.retention, rosterHasAnyForTeam(roster, "retention"));
    for (const [rmKey, rm] of readymodeByKey.entries()) {
      if (allowlist && !allowlist.has(rmKey)) continue;
      const e = base.get(rmKey);
      if (e) {
        base.set(rmKey, { ...e, calls: e.calls + rm.calls, seconds: e.seconds + rm.seconds, outbound: e.outbound + rm.calls });
      } else {
        base.set(rmKey, { calls: rm.calls, seconds: rm.seconds, answered: 0, missed: 0, voicemail: 0, vmBrief: 0, inbound: 0, outbound: rm.calls, uniqueContacts: 0 });
      }
    }
    return base;
  }, [phoneQ.data, roster, readymodeByKey]);

  const agentList = useMemo(() => {
    const result: string[] = [];
    const addedKeys = new Set<string>();
    // Roster-driven mode: only active Retention roster members appear;
    // hardcoded RETENTION_AGENTS + TEAM_PHONE_EXTRAS are bypassed.
    const rosterDrives = rosterDrivesTeam(roster, "retention");
    const inRoster = (rawKey: string) =>
      !rosterDrives || (roster.allowlist.retention?.has(rawKey) ?? false);
    if (!rosterDrives) {
      for (const a of RETENTION_AGENTS) {
        const k = normalizeAgent(a);
        if (!addedKeys.has(k)) { result.push(a); addedKeys.add(k); }
      }
      for (const extra of TEAM_PHONE_EXTRAS["retention"] ?? []) {
        const k = normalizeAgent(extra);
        if (!addedKeys.has(k)) { result.push(extra); addedKeys.add(k); }
      }
    } else {
      // Seed with every active retention roster member so agents who have
      // retain submissions but no phone calls today still show up.
      for (const a of roster!.agentsForTeam("retention")) {
        const k = normalizeAgent(a.name);
        if (!addedKeys.has(k)) { result.push(a.name); addedKeys.add(k); }
      }
    }
    for (const k of phoneData.keys()) {
      if (!inRoster(k)) continue;
      if (!addedKeys.has(k)) { result.push(k.replace(/\b\w/g, (c) => c.toUpperCase())); addedKeys.add(k); }
    }
    const aa = retUser.allowedAgents;
    if (!aa || aa.length === 0) return result;
    return result.filter((a) => aa.some((x) => normalizeAgent(x) === normalizeAgent(a)));
  }, [phoneData, retUser.allowedAgents, roster]);

  const totals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0, missed = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; missed += v.missed; }
    return { calls, seconds, answered, missed };
  }, [phoneData]);

  const pbxTotals = useMemo(() => {
    if (!pbxData) return { calls: 0, answered: 0, seconds: 0 };
    let calls = 0, answered = 0, seconds = 0;
    for (const agent of agentList) {
      const pbxKey = resolvePbxKey(agent, roster);
      const px = pbxData.get(pbxKey);
      calls += px?.calls ?? 0; answered += px?.answered ?? 0; seconds += px?.durationSeconds ?? 0;
    }
    return { calls, answered, seconds };
  }, [pbxData, agentList]);

  function refresh() { statusQ.refetch(); phoneQ.refetch(); }

  return (
    <Card className="ops-panel rounded-lg">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">Retention</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Calls &amp; retention files · live from OpenPhone + PBX
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={phoneQ.isFetching || statusQ.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${(phoneQ.isFetching || statusQ.isFetching) ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {(phoneQ.isLoading || statusQ.isLoading) && <TableSkeleton />}
        {aggregated && "error" in aggregated && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {aggregated.error}
          </div>
        )}
        {!retLockToToday && <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />}

        {!retUser.allowedAgents?.length && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {retSubTabAllowed("call") && <>
              <StatTile label="Agents" value={agentList.length} icon={<Users className="h-3.5 w-3.5" />} tone="blue" />
              <StatTile label="Total calls" value={(totals.calls + pbxTotals.calls).toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Answered" value={(totals.answered + pbxTotals.answered).toLocaleString()} tone="emerald" />
              <StatTile label="Missed" value={(totals.missed + pbxMissed).toLocaleString()} tone="rose" />
              <StatTile label="Time on calls" value={formatHours(totals.seconds + pbxTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
              <StatTile label="Response rate" value={responseRate(totals.answered + pbxTotals.answered, totals.calls + pbxTotals.calls)} tone="amber" />
            </>}
            {aggregated && !("error" in aggregated) && retSubTabAllowed("files") && (
              <>
                <StatTile label="Today's retains" value={aggregated.todayRetained.toLocaleString()} tone="emerald" />
                {!retLockToToday && <StatTile label="This month's retains" value={aggregated.monthRetained.toLocaleString()} tone="emerald" />}
                {!retLockToToday && <StatTile label="This month's cancels" value={aggregated.monthCancelled.toLocaleString()} tone="rose" />}
                <StatTile label="Today's fixed" value={aggregated.todayFixed.toLocaleString()} tone="sky" />
                {!retLockToToday && <StatTile label="This month's fixed" value={aggregated.monthFixed.toLocaleString()} tone="sky" />}
                {!retLockToToday && <StatTile label="Retention rate" value={retentionRate(aggregated.totals.retained, aggregated.totals.grand)} tone="blue" />}
              </>
            )}
          </div>
        )}

        <Tabs defaultValue={retDefaultSubTab} className="space-y-4">
          <TabsList>
            {retSubTabAllowed("call") && <TabsTrigger value="call">By call</TabsTrigger>}
            {aggregated && !("error" in aggregated) && (
              <>
                {retSubTabAllowed("files") && <TabsTrigger value="files">By files</TabsTrigger>}
                {retSubTabAllowed("day") && <TabsTrigger value="day">By day</TabsTrigger>}
              </>
            )}
          </TabsList>
          {retSubTabAllowed("call") && (
            <TabsContent value="call">
              <ByCallStatsView agentList={agentList} phoneData={phoneData} pbxData={pbxData} extraMissed={pbxMissed} hideTeamRow={!!(retUser.allowedAgents?.length)} readymodeByKey={readymodeByKey} rosterPhoneAliases={roster.phoneAliases} />
            </TabsContent>
          )}
          {aggregated && !("error" in aggregated) && (
            <>
              {retSubTabAllowed("files") && (
                <TabsContent value="files">
                  <ByFilesView data={aggregated} hideTeamRow={!!(retUser.allowedAgents?.length)} phoneData={phoneData} sheetData={statusQ.data} fromDate={fromDate} toDate={toDate} />
                </TabsContent>
              )}
              {retSubTabAllowed("day") && (
                <TabsContent value="day">
                  <ByDayView data={aggregated} />
                </TabsContent>
              )}
            </>
          )}
        </Tabs>
      </CardContent>
    </Card>
  );
}

interface CallRecord {
  id: string;
  lineTeam: string;
  lineName: string;
  agentName: string | null;
  participant: string;
  direction: string;
  status: string;
  durationSeconds: number;
  createdAt: string;
}

function directionIcon(dir: string) {
  if (dir === "outgoing") return <PhoneOutgoing className="h-3.5 w-3.5 metric-info" />;
  return <PhoneIncoming className="h-3.5 w-3.5 metric-info" />;
}

function statusIcon(status: string) {
  if (status === "completed") return <span className="metric-good text-xs font-semibold">Answered</span>;
  if (status === "voicemail") return <span className="metric-warn text-xs font-semibold">VM Left</span>;
  if (status === "voicemail-brief") return <span className="metric-warn text-xs font-semibold">No VM</span>;
  if (status === "missed" || status === "no-answer") return <span className="metric-bad text-xs font-semibold">Missed</span>;
  if (status === "in-progress") return <span className="metric-info text-xs font-semibold">Live</span>;
  return <span className="text-muted-foreground text-xs">{status}</span>;
}

function ByCallView({ team, from, to }: { team: string; from: string; to: string }) {
  const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
  const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();

  const q = useQuery<{ data: CallRecord[] } | null>({
    queryKey: ["calls", team, pFrom, pTo],
    queryFn: async () => {
      const url = `/api/quo/calls?team=${team}&from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}&limit=500`;
      const r = await fetch(url);
      if (!r.ok) return null;
      return r.json() as Promise<{ data: CallRecord[] }>;
    },
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: 60 * 1000,
  });

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "createdAt", dir: "desc" });

  const calls = useMemo(() => {
    const raw = q.data?.data ?? [];
    const filtered = search
      ? raw.filter(
          (c) =>
            (c.agentName ?? "").toLowerCase().includes(search.toLowerCase()) ||
            c.participant.includes(search) ||
            c.lineName.toLowerCase().includes(search.toLowerCase()),
        )
      : raw;
    return [...filtered].sort((a, b) => {
      let av: string | number = a[sort.col as keyof CallRecord] as string | number ?? "";
      let bv: string | number = b[sort.col as keyof CallRecord] as string | number ?? "";
      if (sort.col === "durationSeconds") { av = Number(av); bv = Number(bv); }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [q.data, search, sort]);

  function toggleSort(col: string) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  }

  function SortTh({ col, label, align = "left" }: { col: string; label: string; align?: "left" | "right" }) {
    const active = sort.col === col;
    return (
      <TableHead className={align === "right" ? "text-right" : ""}>
        <button type="button" onClick={() => toggleSort(col)}
          className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${active ? "metric-info" : "text-muted-foreground"} ${align === "right" ? "flex-row-reverse" : ""}`}>
          {label}
          {active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
        </button>
      </TableHead>
    );
  }

  if (q.isLoading) return <TableSkeleton />;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search agent, number..." value={search} onChange={(e) => setSearch(e.target.value)} className="ops-input pl-9" />
        </div>
        <span className="text-sm text-muted-foreground">{calls.length.toLocaleString()} calls</span>
        <Button variant="ghost" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      <div className="ops-table-wrap overflow-hidden">
        <div className="overflow-x-auto max-h-[65vh]">
          <Table>
            <TableHeader className="sticky top-0 backdrop-blur z-10">
              <TableRow>
                <SortTh col="createdAt" label="Date / Time" />
                <SortTh col="agentName" label="Agent" />
                <SortTh col="lineName" label="Line" />
                <TableHead>Dir</TableHead>
                <TableHead>Status</TableHead>
                <SortTh col="durationSeconds" label="Duration" align="right" />
                <TableHead>External #</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                    No calls found for the selected range.
                  </TableCell>
                </TableRow>
              )}
              {calls.map((c) => (
                <TableRow key={c.id} className="hover-elevate text-sm">
                  <TableCell className="tabular-nums font-mono text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(c.createdAt).toLocaleString("en-US", { timeZone: CA_TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}
                  </TableCell>
                  <TableCell className="font-medium whitespace-nowrap">
                    <AvatarName name={c.agentName ?? "Unknown"} size="sm" textClassName="text-foreground" />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs whitespace-nowrap">{c.lineName}</TableCell>
                  <TableCell>{directionIcon(c.direction)}</TableCell>
                  <TableCell>{statusIcon(c.status)}</TableCell>
                  <TableCell className="text-right tabular-nums font-mono">
                    {c.durationSeconds > 0 ? formatDuration(c.durationSeconds) : <span className="text-muted-foreground/40">—</span>}
                  </TableCell>
                  <TableCell className="tabular-nums font-mono text-muted-foreground text-xs">{c.participant || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function AnimatedEye({
  size = 18,
  pupilSize = 7,
  maxDistance = 5,
  blinking = false,
  forceLookX,
  forceLookY,
}: {
  size?: number;
  pupilSize?: number;
  maxDistance?: number;
  blinking?: boolean;
  forceLookX?: number;
  forceLookY?: number;
}) {
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const eyeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => setMouse({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  const position = (() => {
    if (forceLookX !== undefined && forceLookY !== undefined) return { x: forceLookX, y: forceLookY };
    if (!eyeRef.current) return { x: 0, y: 0 };
    const rect = eyeRef.current.getBoundingClientRect();
    const dx = mouse.x - (rect.left + rect.width / 2);
    const dy = mouse.y - (rect.top + rect.height / 2);
    const distance = Math.min(Math.hypot(dx, dy), maxDistance);
    const angle = Math.atan2(dy, dx);
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  })();

  return (
    <div
      ref={eyeRef}
      className="flex items-center justify-center rounded-full bg-white shadow-inner transition-all duration-150"
      style={{ width: size, height: blinking ? 2 : size, overflow: "hidden" }}
    >
      {!blinking && (
        <div
          className="rounded-full bg-stone-900 transition-transform duration-100"
          style={{ width: pupilSize, height: pupilSize, transform: `translate(${position.x}px, ${position.y}px)` }}
        />
      )}
    </div>
  );
}

function AnimatedPupil({
  size = 12,
  maxDistance = 5,
  forceLookX,
  forceLookY,
}: {
  size?: number;
  maxDistance?: number;
  forceLookX?: number;
  forceLookY?: number;
}) {
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => setMouse({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  const position = (() => {
    if (forceLookX !== undefined && forceLookY !== undefined) return { x: forceLookX, y: forceLookY };
    if (!ref.current) return { x: 0, y: 0 };
    const rect = ref.current.getBoundingClientRect();
    const dx = mouse.x - (rect.left + rect.width / 2);
    const dy = mouse.y - (rect.top + rect.height / 2);
    const distance = Math.min(Math.hypot(dx, dy), maxDistance);
    const angle = Math.atan2(dy, dx);
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  })();

  return (
    <div
      ref={ref}
      className="rounded-full bg-stone-900 transition-transform duration-100"
      style={{ width: size, height: size, transform: `translate(${position.x}px, ${position.y}px)` }}
    />
  );
}

function LoginAnimation({ isTyping, passwordVisible, hasPassword }: { isTyping: boolean; passwordVisible: boolean; hasPassword: boolean }) {
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [tallBlink, setTallBlink] = useState(false);
  const [darkBlink, setDarkBlink] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const tallRef = useRef<HTMLDivElement>(null);
  const darkRef = useRef<HTMLDivElement>(null);
  const clayRef = useRef<HTMLDivElement>(null);
  const goldRef = useRef<HTMLDivElement>(null);
  const lookingAtEachOther = isTyping;
  const coveringPassword = hasPassword && !passwordVisible;

  useEffect(() => {
    const onMove = (e: MouseEvent) => setMouse({ x: e.clientX, y: e.clientY });
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    let active = true;
    const schedule = () => {
      const timer = window.setTimeout(() => {
        if (!active) return;
        setTallBlink(true);
        window.setTimeout(() => setTallBlink(false), 150);
        schedule();
      }, 3000 + Math.random() * 3500);
      return timer;
    };
    const timer = schedule();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    const schedule = () => {
      const timer = window.setTimeout(() => {
        if (!active) return;
        setDarkBlink(true);
        window.setTimeout(() => setDarkBlink(false), 150);
        schedule();
      }, 3200 + Math.random() * 3800);
      return timer;
    };
    const timer = schedule();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!hasPassword || !passwordVisible) {
      setPeeking(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setPeeking(true);
      window.setTimeout(() => setPeeking(false), 800);
    }, 1200 + Math.random() * 2200);
    return () => window.clearTimeout(timer);
  }, [hasPassword, passwordVisible, peeking]);

  const position = (ref: React.RefObject<HTMLDivElement | null>) => {
    if (!ref.current) return { faceX: 0, faceY: 0, skew: 0 };
    const rect = ref.current.getBoundingClientRect();
    const dx = mouse.x - (rect.left + rect.width / 2);
    const dy = mouse.y - (rect.top + rect.height / 3);
    return {
      faceX: Math.max(-14, Math.min(14, dx / 24)),
      faceY: Math.max(-9, Math.min(9, dy / 34)),
      skew: Math.max(-5, Math.min(5, -dx / 140)),
    };
  };

  const tall = position(tallRef);
  const dark = position(darkRef);
  const clay = position(clayRef);
  const gold = position(goldRef);

  return (
    <div className="relative h-[390px] w-[520px] max-w-full" aria-hidden="true">
      <div
        ref={tallRef}
        className="absolute bottom-0 rounded-t-xl bg-stone-700 transition-all duration-700 ease-out"
        style={{
          left: "70px",
          width: "170px",
          height: coveringPassword ? "420px" : "375px",
          transform: passwordVisible && hasPassword ? "skewX(0deg)" : coveringPassword ? `skewX(${tall.skew - 10}deg) translateX(34px)` : `skewX(${tall.skew}deg)`,
          transformOrigin: "bottom center",
          zIndex: 1,
        }}
      >
        <div
          className="absolute flex gap-7 transition-all duration-500"
          style={{ left: passwordVisible && hasPassword ? 22 : lookingAtEachOther ? 54 : 44 + tall.faceX, top: passwordVisible && hasPassword ? 34 : lookingAtEachOther ? 62 : 40 + tall.faceY }}
        >
          <AnimatedEye blinking={tallBlink} forceLookX={passwordVisible && hasPassword ? (peeking ? 4 : -4) : lookingAtEachOther ? 3 : undefined} forceLookY={passwordVisible && hasPassword ? (peeking ? 5 : -4) : lookingAtEachOther ? 4 : undefined} />
          <AnimatedEye blinking={tallBlink} forceLookX={passwordVisible && hasPassword ? (peeking ? 4 : -4) : lookingAtEachOther ? 3 : undefined} forceLookY={passwordVisible && hasPassword ? (peeking ? 5 : -4) : lookingAtEachOther ? 4 : undefined} />
        </div>
      </div>

      <div
        ref={darkRef}
        className="absolute bottom-0 rounded-t-lg bg-neutral-950 transition-all duration-700 ease-out"
        style={{
          left: "232px",
          width: "118px",
          height: "300px",
          transform: passwordVisible && hasPassword ? "skewX(0deg)" : lookingAtEachOther ? `skewX(${dark.skew * 1.4 + 8}deg) translateX(18px)` : `skewX(${dark.skew}deg)`,
          transformOrigin: "bottom center",
          zIndex: 2,
        }}
      >
        <div
          className="absolute flex gap-5 transition-all duration-500"
          style={{ left: passwordVisible && hasPassword ? 12 : lookingAtEachOther ? 32 : 26 + dark.faceX, top: passwordVisible && hasPassword ? 28 : lookingAtEachOther ? 14 : 32 + dark.faceY }}
        >
          <AnimatedEye size={16} pupilSize={6} maxDistance={4} blinking={darkBlink} forceLookX={passwordVisible && hasPassword ? -4 : lookingAtEachOther ? 0 : undefined} forceLookY={passwordVisible && hasPassword ? -4 : lookingAtEachOther ? -4 : undefined} />
          <AnimatedEye size={16} pupilSize={6} maxDistance={4} blinking={darkBlink} forceLookX={passwordVisible && hasPassword ? -4 : lookingAtEachOther ? 0 : undefined} forceLookY={passwordVisible && hasPassword ? -4 : lookingAtEachOther ? -4 : undefined} />
        </div>
      </div>

      <div
        ref={clayRef}
        className="absolute bottom-0 rounded-t-full bg-[#b77858] transition-all duration-700 ease-out"
        style={{ left: "0px", width: "230px", height: "190px", transform: passwordVisible && hasPassword ? "skewX(0deg)" : `skewX(${clay.skew}deg)`, transformOrigin: "bottom center", zIndex: 3 }}
      >
        <div className="absolute flex gap-8 transition-all duration-200" style={{ left: passwordVisible && hasPassword ? 50 : 80 + clay.faceX, top: passwordVisible && hasPassword ? 82 : 88 + clay.faceY }}>
          <AnimatedPupil forceLookX={passwordVisible && hasPassword ? -5 : undefined} forceLookY={passwordVisible && hasPassword ? -4 : undefined} />
          <AnimatedPupil forceLookX={passwordVisible && hasPassword ? -5 : undefined} forceLookY={passwordVisible && hasPassword ? -4 : undefined} />
        </div>
      </div>

      <div
        ref={goldRef}
        className="absolute bottom-0 rounded-t-full bg-[#c6ad67] transition-all duration-700 ease-out"
        style={{ left: "306px", width: "140px", height: "220px", transform: passwordVisible && hasPassword ? "skewX(0deg)" : `skewX(${gold.skew}deg)`, transformOrigin: "bottom center", zIndex: 4 }}
      >
        <div className="absolute flex gap-6 transition-all duration-200" style={{ left: passwordVisible && hasPassword ? 20 : 52 + gold.faceX, top: passwordVisible && hasPassword ? 36 : 42 + gold.faceY }}>
          <AnimatedPupil forceLookX={passwordVisible && hasPassword ? -5 : undefined} forceLookY={passwordVisible && hasPassword ? -4 : undefined} />
          <AnimatedPupil forceLookX={passwordVisible && hasPassword ? -5 : undefined} forceLookY={passwordVisible && hasPassword ? -4 : undefined} />
        </div>
        <div className="absolute h-1 w-20 rounded-full bg-stone-900 transition-all duration-200" style={{ left: passwordVisible && hasPassword ? 10 : 40 + gold.faceX, top: passwordVisible && hasPassword ? 88 : 88 + gold.faceY }} />
      </div>
    </div>
  );
}

function LoginGate({ children }: { children: React.ReactNode }) {
  const stored = localStorage.getItem("tracker_token");
  const storedUser = localStorage.getItem("tracker_user");
  const [auth, setAuth] = useState<{ token: string; user: AuthUser } | null>(() => {
    if (stored && storedUser) {
      try { return { token: stored, user: JSON.parse(storedUser) as AuthUser }; } catch { return null; }
    }
    return null;
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isTypingLogin, setIsTypingLogin] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // On mount, refresh user data from DB so permission/teamAccess changes
  // take effect on the next page load without requiring re-login.
  useEffect(() => {
    const token = localStorage.getItem("tracker_token");
    if (!token) return;
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) { logout(); return; }
        return r.json() as Promise<{ token: string; user: AuthUser }>;
      })
      .then((data) => {
        if (!data) return;
        localStorage.setItem("tracker_token", data.token);
        localStorage.setItem("tracker_user", JSON.stringify(data.user));
        setAuth(data);
      })
      .catch(() => { /* network error — keep existing auth */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("tracker_token");
    localStorage.removeItem("tracker_user");
    setAuth(null);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password: password.trim() }),
      });
      if (r.ok) {
        const data = await r.json() as { token: string; user: AuthUser };
        localStorage.setItem("tracker_token", data.token);
        localStorage.setItem("tracker_user", JSON.stringify(data.user));
        setAuth(data);
      } else {
        let message = "Login failed. Try again.";
        try {
          const data = await r.json() as { error?: string };
          if (r.status === 401) message = "Invalid username or password.";
          else if (data.error) message = data.error;
        } catch {
          if (r.status === 401) message = "Invalid username or password.";
        }
        setError(message);
        setPassword("");
      }
    } catch {
      setError("Connection error. Try again.");
    } finally {
      setLoading(false);
    }
  }

  if (auth) {
    const can = (p: Permission) => auth.user.role === "admin" || auth.user.permissions.includes(p);
    const canSeeTab = (tab: string) => {
      // Per-user override: hide the Backend Statistics tab entirely, even for admins.
      if (tab === "backend-stats" && auth.user.hideBackendStats) return false;
      if (auth.user.role === "admin") return true;
      const at = auth.user.allowedTabs;
      if (at && at.length > 0) return at.includes(tab);
      // Fallback: teamAccess-based visibility
      const ta = auth.user.teamAccess ?? null;
      const allTeams = ta === null;
      if (tab === "backend-stats") return allTeams;
      if (tab === "violations" || tab === "callback-review") return allTeams;
      if (tab === "missed-no-cb") return true;
      if (tab === "retention") return allTeams || ta === "retention";
      if (tab === "cs") return allTeams || ta === "cs";
      if (tab === "nsf") return allTeams || ta === "nsf";
      if (tab === "rmk") return allTeams;
      if (tab === "onboarding") return allTeams;
      return false;
    };
    return (
      <UserContext.Provider value={{ user: auth.user, token: auth.token, logout, can, canSeeTab }}>
        {children}
      </UserContext.Provider>
    );
  }

  return (
    <div className="min-h-screen bg-background grid lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] relative overflow-hidden">
      <div className="hidden lg:flex relative min-h-screen flex-col justify-between overflow-hidden border-r border-border bg-muted/40 p-10">
        <div className="relative z-10 flex items-center gap-3">
          <div className="h-11 w-11 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <img src={companyLogo} alt="Dial Expert logo" className="h-full w-full object-cover" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Dial Expert</p>
            <p className="text-xs text-muted-foreground">Backend Tracker</p>
          </div>
        </div>

        <div className="relative z-10 flex flex-1 items-end justify-center pb-8">
          <LoginAnimation isTyping={isTypingLogin} passwordVisible={showPassword} hasPassword={password.length > 0} />
        </div>

        <div className="relative z-10 max-w-md text-sm text-muted-foreground">
          Real-time tracking for submissions, calls, teams, and reviews.
        </div>
      </div>

      <div className="relative flex min-h-screen items-center justify-center p-6 sm:p-8">
        <div className="absolute right-5 top-5">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-[420px] space-y-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="h-16 w-16 overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              <img src={companyLogo} alt="Dial Expert logo" className="h-full w-full object-cover" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-foreground">Welcome back</h1>
              <p className="mt-2 text-sm text-muted-foreground">Sign in to Dial Expert Backend Tracker</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tracker-username" className="text-sm font-medium">Username</Label>
              <div className="relative">
                <Users className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="tracker-username"
                  placeholder="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onFocus={() => setIsTypingLogin(true)}
                  onBlur={() => setIsTypingLogin(false)}
                  className="h-12 pl-10"
                  autoFocus
                  autoComplete="username"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tracker-password" className="text-sm font-medium">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="tracker-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setIsTypingLogin(true)}
                  onBlur={() => setIsTypingLogin(false)}
                  className="h-12 pl-10 pr-11"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-center text-sm metric-bad">{error}</p>}
            <Button type="submit" className="h-12 w-full text-base" disabled={loading || !username || !password}>
              {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── User Management Panel (Admin only) ──────────────────────────────────────

function AnimatedMenuItem({
  label,
  icon,
  emoji,
  onClick,
  tone = "neutral",
}: {
  label: string;
  icon: React.ReactNode;
  emoji?: string;
  onClick: () => void;
  tone?: "neutral" | "danger";
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "group relative flex h-16 w-16 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm",
        "transition-colors duration-200 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "danger" && "hover:metric-bad",
      )}
    >
      <span className="flex h-6 w-6 items-center justify-center transition-all duration-200 group-hover:[&_svg]:stroke-[2.5] [&_svg]:h-5 [&_svg]:w-5">
        {icon}
      </span>
      {emoji && (
        <span className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-sm shadow-sm" aria-hidden="true">
          {emoji}
        </span>
      )}
      <span className="pointer-events-none absolute right-[calc(100%+10px)] top-1/2 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-sm opacity-0 transition-opacity group-hover:block group-hover:opacity-100 group-focus-visible:block group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
  );
}

function AnimatedActionMenu({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const items = React.Children.toArray(children);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const closeAfter = (child: React.ReactNode) => {
    if (!React.isValidElement<{ onClick?: () => void }>(child)) return child;
    return React.cloneElement(child, {
      onClick: () => {
        child.props.onClick?.();
        setExpanded(false);
      },
    });
  };

  return (
    <div ref={ref} className="relative z-[120] h-16 w-16" data-expanded={expanded}>
      <button
        type="button"
        aria-label={expanded ? "Close account menu" : "Open account menu"}
        aria-haspopup="menu"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "relative z-[130] flex h-16 w-16 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm",
          "transition-all duration-300 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          expanded && "bg-accent text-foreground",
        )}
      >
        <MoreVertical className={cn("h-5 w-5 transition-transform duration-300", expanded && "rotate-90")} />
      </button>
      <div role="menu" aria-orientation="vertical">
        {items.map((child, index) => {
          const offset = (index + 1) * 48;
          return (
            <div
              key={index}
              className="absolute left-0 top-0 h-16 w-16 will-change-transform"
              style={{
                transform: `translateY(${expanded ? offset : 0}px)`,
                opacity: expanded ? 1 : 0,
                pointerEvents: expanded ? "auto" : "none",
                zIndex: 129 - index,
                clipPath: index === items.length - 1 ? "circle(50% at 50% 50%)" : "circle(50% at 50% 55%)",
                transition: "transform 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms",
                backfaceVisibility: "hidden",
              }}
            >
              {closeAfter(child)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PortalUser { id: number; username: string; role: string; permissions: Permission[]; teamAccess?: TeamAccess | null; allowedTabs?: string[] | null; allowedAgents?: string[] | null; allowedSubTabs?: string[] | null; lockToToday?: boolean; samiaCurse?: boolean; hideBackendStats?: boolean; active: boolean; }

const DEFAULT_PERMS: Record<string, Permission[]> = {
  admin: ["view_metrics", "view_attendance", "edit_attendance", "manage_members", "view_missed_tables"],
  edit:  ["view_metrics", "view_attendance", "edit_attendance", "manage_members", "view_missed_tables"],
  view:  ["view_metrics", "view_attendance"],
};

function PermCheckboxes({ perms, onChange, disabled }: { perms: Permission[]; onChange: (p: Permission[]) => void; disabled?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 mt-1">
      {ALL_PERMISSIONS.map(({ key, label, desc }) => {
        const checked = perms.includes(key);
        return (
          <label key={key} className={`flex items-start gap-2.5 rounded-md px-3 py-2 cursor-pointer transition-colors ${checked ? "bg-muted-foreground/10 border border-border" : "bg-zinc-900/60 border border-white/5 hover:border-white/10"} ${disabled ? "opacity-40 pointer-events-none" : ""}`}>
            <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${checked ? "bg-muted-foreground border-border" : "border-zinc-600"}`}
              onClick={() => !disabled && onChange(checked ? perms.filter((p) => p !== key) : [...perms, key])}>
              {checked && <span className="text-white text-[10px] font-bold leading-none">✓</span>}
            </div>
            <div className="min-w-0">
              <div className={`text-xs font-medium leading-tight ${checked ? "metric-info" : "text-zinc-300"}`}>{label}</div>
              <div className="text-[11px] text-zinc-500 leading-tight mt-0.5">{desc}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

const TEAM_ACCESS_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "CS" };
const TEAM_ACCESS_COLORS: Record<string, string> = {
  retention: "bg-muted-foreground/20 metric-info border-border",
  nsf:       "bg-muted metric-info border-border",
  cs:        "bg-muted metric-good border-border",
};

const ALL_SUB_TABS: { value: string; label: string }[] = [
  { value: "call",  label: "By call" },
  { value: "files", label: "By files" },
  { value: "day",   label: "By day" },
];

function SubTabCheckboxes({ tabs, onChange }: { tabs: string[]; onChange: (t: string[]) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1.5 mt-1">
      {ALL_SUB_TABS.map(({ value, label }) => {
        const checked = tabs.includes(value);
        return (
          <label key={value} className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 cursor-pointer transition-colors ${checked ? "bg-muted/60 border border-border" : "bg-zinc-900/60 border border-white/5 hover:border-white/10"}`}
            onClick={() => onChange(checked ? tabs.filter((t) => t !== value) : [...tabs, value])}>
            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${checked ? "bg-muted-foreground border-border" : "border-zinc-600"}`}>
              {checked && <span className="text-white text-[9px] font-bold leading-none">✓</span>}
            </div>
            <span className={`text-xs font-medium ${checked ? "metric-good" : "text-zinc-400"}`}>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

function TabCheckboxes({ tabs, onChange }: { tabs: string[]; onChange: (t: string[]) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 mt-1">
      {ALL_TABS.map(({ value, label }) => {
        const checked = tabs.includes(value);
        return (
          <label key={value} className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 cursor-pointer transition-colors ${checked ? "bg-muted/50 border border-border" : "bg-zinc-900/60 border border-white/5 hover:border-white/10"}`}
            onClick={() => onChange(checked ? tabs.filter((t) => t !== value) : [...tabs, value])}>
            <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${checked ? "bg-muted-foreground border-border" : "border-zinc-600"}`}>
              {checked && <span className="text-white text-[9px] font-bold leading-none">✓</span>}
            </div>
            <span className={`text-xs font-medium ${checked ? "metric-info" : "text-zinc-400"}`}>{label}</span>
          </label>
        );
      })}
    </div>
  );
}

type TeamAgent = { id: number; name: string; team: string; active: boolean; arabicName?: string | null; shift?: string | null; notes?: string | null };

function AgentRosterPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const qc = useQueryClient();
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newArabic, setNewArabic] = useState("");
  const [newShift, setNewShift] = useState("");
  const [newTeam, setNewTeam] = useState<RosterTeam>("retention");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<TeamAgent | null>(null);
  const [agentDetail, setAgentDetail] = useState({
    name: "",
    arabicName: "",
    team: "retention" as RosterTeam,
    shift: "",
    notes: "",
    active: true,
  });
  // Local drafts for inline-edited arabic/shift cells so typing is smooth.
  const [drafts, setDrafts] = useState<Record<number, { name?: string; arabicName?: string; shift?: string }>>({});

  async function readTeamAgentError(response: Response, fallback: string): Promise<string> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = await response.json().catch(() => null) as { error?: string } | null;
      return parsed?.error || fallback;
    }
    return "Server error while saving agent. Check API logs.";
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/team-agents", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        setAgents(await r.json() as TeamAgent[]);
        setDrafts({});
      } else {
        setError(await readTeamAgentError(r, "Failed to load agents"));
      }
    } catch {
      setError("Failed to load agents");
    } finally { setLoading(false); }
    // Bust the dashboard-wide roster query so all panels rebuild aliases/allowlists.
    void qc.invalidateQueries({ queryKey: ["roster"] });
  }, [token, qc]);

  useEffect(() => { void load(); }, [load]);

  async function addAgent() {
    if (!newName.trim()) return;
    setSaving(true); setError("");
    try {
      const r = await fetch("/api/team-agents", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          name: newName.trim(),
          team: newTeam,
          arabicName: newArabic.trim() || null,
          shift: newShift.trim() || null,
          notes: null,
        }),
      });
      if (r.ok) {
        setNewName(""); setNewArabic(""); setNewShift("");
        await load();
        await qc.invalidateQueries({ queryKey: ["roster"] });
      } else {
        setError(await readTeamAgentError(r, "Failed to add"));
      }
    } catch {
      setError("Failed to add");
    } finally {
      setSaving(false);
    }
  }

  async function patchAgent(id: number, body: Record<string, unknown>) {
    setBusyId(id); setError("");
    try {
      const r = await fetch(`/api/team-agents/${id}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setError(await readTeamAgentError(r, "Failed to update"));
        return false;
      }
      await load();
      await qc.invalidateQueries({ queryKey: ["roster"] });
      return true;
    } catch {
      setError("Failed to update");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function removeAgent(id: number) {
    setBusyId(id); setError("");
    try {
      const r = await fetch(`/api/team-agents/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        setError(await readTeamAgentError(r, "Failed to delete"));
        return;
      }
      await load();
      await qc.invalidateQueries({ queryKey: ["roster"] });
    } catch {
      setError("Failed to delete");
    } finally {
      setBusyId(null);
    }
  }

  function openAgentDetail(agent: TeamAgent) {
    setSelectedAgent(agent);
    setAgentDetail({
      name: agent.name,
      arabicName: agent.arabicName ?? "",
      team: agent.team as RosterTeam,
      shift: agent.shift ?? "",
      notes: agent.notes ?? "",
      active: agent.active,
    });
  }

  async function saveAgentDetail() {
    if (!selectedAgent || !agentDetail.name.trim()) return;
    const saved = await patchAgent(selectedAgent.id, {
      name: agentDetail.name.trim(),
      arabicName: agentDetail.arabicName.trim() || null,
      team: agentDetail.team,
      shift: agentDetail.shift.trim() || null,
      notes: agentDetail.notes.trim() || null,
      active: agentDetail.active,
    });
    if (saved) setSelectedAgent(null);
  }

  function getDraft(a: TeamAgent, field: "name" | "arabicName" | "shift"): string {
    const d = drafts[a.id];
    if (d && field in d) return d[field] ?? "";
    return (a[field] ?? "") as string;
  }
  function setDraft(id: number, field: "name" | "arabicName" | "shift", v: string) {
    setDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: v } }));
  }
  async function commitDraft(a: TeamAgent, field: "name" | "arabicName" | "shift") {
    const next = (drafts[a.id]?.[field] ?? "").trim();
    const current = (a[field] ?? "").toString().trim();
    if (next === current) return;
    // English name is required; ignore empty commits and reset draft.
    if (field === "name" && !next) {
      setDrafts(prev => { const cp = { ...prev }; if (cp[a.id]) { const inner = { ...cp[a.id] }; delete inner.name; cp[a.id] = inner; } return cp; });
      return;
    }
    await patchAgent(a.id, { [field]: field === "name" ? next : (next || null) });
  }

  const TEAMS: { key: RosterTeam; label: string }[] = [
    { key: "retention", label: "Retention" },
    { key: "nsf",       label: "NSF" },
    { key: "cs",        label: "CS" },
    { key: "killers",   label: "ReadyMode Killer" },
  ];
  const teamBadge: Record<string, string> = {
    retention: "bg-muted-foreground/20 metric-info border-border",
    nsf: "bg-muted metric-info border-border",
    cs: "bg-muted metric-info border-border",
    killers: "bg-muted metric-bad border-border",
  };

  // Sort: team, then English name.
  const sortedAgents = [...agents].sort((x, y) => {
    if (x.team !== y.team) return x.team.localeCompare(y.team);
    return x.name.localeCompare(y.name);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative w-full max-w-5xl mx-4 rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 metric-info" />
            <h2 className="text-lg font-semibold text-white">Agent Roster</h2>
            <span className="text-xs text-zinc-500">· canonical identity registry</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X className="h-5 w-5" /></button>
        </div>

        <div className="p-6 space-y-5 max-h-[82vh] overflow-y-auto">
          {/* Add agent form */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add Agent</p>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_140px_auto] gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addAgent()}
                placeholder="English name"
                className="rounded-lg border border-white/10 bg-zinc-800/80 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
              <input
                value={newArabic}
                onChange={(e) => setNewArabic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addAgent()}
                placeholder="Arabic name (optional)"
                dir="rtl"
                className="rounded-lg border border-white/10 bg-zinc-800/80 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
              <input
                value={newShift}
                onChange={(e) => setNewShift(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void addAgent()}
                placeholder="Shift (e.g. 9–5, Night)"
                className="rounded-lg border border-white/10 bg-zinc-800/80 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-ring/50"
              />
              <AnimatedValueSelect
                value={newTeam}
                onChange={(value) => setNewTeam(value as RosterTeam)}
                ariaLabel="Choose agent team"
                triggerClassName="h-10 min-w-[140px] rounded-lg border-white/10 bg-zinc-800/80 text-white"
                menuClassName="w-44"
                options={TEAMS.map((t) => ({ value: t.key, label: t.label }))}
              />
              <button
                onClick={() => void addAgent()}
                disabled={saving || !newName.trim()}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 disabled:opacity-50 text-white text-sm font-medium transition-colors"
              >
                <Plus className="h-4 w-4" />Add
              </button>
            </div>
            {error && <p className="text-xs metric-bad">{error}</p>}
          </div>

          {/* Roster table */}
          {loading ? (
            <div className="text-center py-8 text-zinc-500 text-sm">Loading agents…</div>
          ) : agents.length === 0 ? (
            <div className="text-center py-8 text-zinc-500 text-sm">No agents added yet. Use the form above to add team members.</div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/8">
              <table className="w-full text-sm">
                <thead className="bg-zinc-900/70 text-zinc-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold">Department</th>
                    <th className="text-left px-3 py-2 font-semibold">English Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Arabic Name</th>
                    <th className="text-left px-3 py-2 font-semibold">Shift</th>
                    <th className="text-center px-3 py-2 font-semibold w-24">Active</th>
                    <th className="text-right px-3 py-2 font-semibold w-20">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAgents.map(a => (
                    <tr
                      key={a.id}
                      onClick={() => openAgentDetail(a)}
                      className={`cursor-pointer border-t border-white/5 align-middle transition-colors hover:bg-white/5 ${a.active ? "" : "opacity-50"}`}
                    >
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <AnimatedValueSelect
                          value={a.team}
                          disabled={busyId === a.id}
                          onChange={(value) => void patchAgent(a.id, { team: value })}
                          ariaLabel={`Choose team for ${a.name}`}
                          triggerClassName={cn("h-7 min-w-[120px] rounded-full px-2 py-1 text-xs", teamBadge[a.team] ?? "bg-zinc-700 text-zinc-300 border-zinc-600")}
                          menuClassName="w-44"
                          options={TEAMS.map((t) => ({ value: t.key, label: t.label }))}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <AvatarIcon name={getDraft(a, "name") || a.name} size="sm" />
                          <input
                            onClick={(e) => e.stopPropagation()}
                            value={getDraft(a, "name")}
                            onChange={(e) => setDraft(a.id, "name", e.target.value)}
                            onBlur={() => void commitDraft(a, "name")}
                            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                            className={`w-full bg-transparent px-2 py-1 rounded border border-transparent hover:border-white/10 focus:border-border focus:outline-none ${a.active ? "text-zinc-100" : "text-zinc-500 line-through"}`}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          onClick={(e) => e.stopPropagation()}
                          value={getDraft(a, "arabicName")}
                          onChange={(e) => setDraft(a.id, "arabicName", e.target.value)}
                          onBlur={() => void commitDraft(a, "arabicName")}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          dir="rtl"
                          placeholder="—"
                          className="w-full bg-transparent text-zinc-200 placeholder:text-zinc-600 px-2 py-1 rounded border border-transparent hover:border-white/10 focus:border-border focus:outline-none"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          onClick={(e) => e.stopPropagation()}
                          value={getDraft(a, "shift")}
                          onChange={(e) => setDraft(a.id, "shift", e.target.value)}
                          onBlur={() => void commitDraft(a, "shift")}
                          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                          placeholder="—"
                          className="w-full bg-transparent text-zinc-200 placeholder:text-zinc-600 px-2 py-1 rounded border border-transparent hover:border-white/10 focus:border-border focus:outline-none"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={(e) => { e.stopPropagation(); void patchAgent(a.id, { active: !a.active }); }}
                          title={a.active ? "Deactivate" : "Activate"}
                          className={`inline-flex items-center justify-center rounded-md p-1.5 transition-colors ${a.active ? "metric-good hover:bg-muted/60" : "text-zinc-500 hover:bg-muted/50 hover:metric-warn"}`}
                        >
                          {a.active ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); if (confirm(`Remove ${a.name}?`)) void removeAgent(a.id); }}
                          title="Remove agent"
                          className="inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 hover:metric-bad hover:bg-muted/50 transition-colors"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-zinc-600 leading-relaxed">
            This roster is the canonical identity registry. Agents added here are automatically matched in the Google Sheets data <em>and</em> in OpenPhone/PBX call data — no code change required. Arabic names are matched as aliases for the same agent.
          </p>
        </div>
        <AnimatePresence>
          {selectedAgent && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-background/70 p-4 backdrop-blur-sm"
              onClick={(e) => e.target === e.currentTarget && setSelectedAgent(null)}
            >
              <motion.div
                initial={{ y: 18, scale: 0.98 }}
                animate={{ y: 0, scale: 1 }}
                exit={{ y: 18, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 360, damping: 30 }}
                className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
              >
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                  <AvatarName
                    name={agentDetail.name || selectedAgent.name}
                    subtitle="Agent details"
                    size="lg"
                    textClassName="font-semibold text-foreground"
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedAgent(null)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground hover:bg-accent"
                    aria-label="Close agent details"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="grid gap-4 p-5 sm:grid-cols-2">
                  <label className="space-y-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">English name</span>
                    <Input value={agentDetail.name} onChange={(e) => setAgentDetail((prev) => ({ ...prev, name: e.target.value }))} className="h-9" />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Arabic name</span>
                    <Input value={agentDetail.arabicName} onChange={(e) => setAgentDetail((prev) => ({ ...prev, arabicName: e.target.value }))} dir="rtl" className="h-9" />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Department</span>
                    <AnimatedValueSelect
                      value={agentDetail.team}
                      onChange={(value) => setAgentDetail((prev) => ({ ...prev, team: value as RosterTeam }))}
                      ariaLabel="Choose agent detail team"
                      triggerClassName="h-9 w-full"
                      menuClassName="w-full"
                      options={TEAMS.map((t) => ({ value: t.key, label: t.label }))}
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Shift</span>
                    <Input value={agentDetail.shift} onChange={(e) => setAgentDetail((prev) => ({ ...prev, shift: e.target.value }))} placeholder="e.g. 8, 9-5, Night" className="h-9" />
                  </label>
                  <label className="space-y-1.5 sm:col-span-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Additional notes</span>
                    <textarea
                      value={agentDetail.notes}
                      onChange={(e) => setAgentDetail((prev) => ({ ...prev, notes: e.target.value }))}
                      placeholder="Add anything useful about this agent..."
                      className="min-h-24 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input type="checkbox" checked={agentDetail.active} onChange={(e) => setAgentDetail((prev) => ({ ...prev, active: e.target.checked }))} className="h-4 w-4 accent-current" />
                    Active agent
                  </label>
                </div>
                {error && <p className="px-5 pb-3 text-xs metric-bad">{error}</p>}
                <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
                  <Button variant="ghost" onClick={() => setSelectedAgent(null)}>Cancel</Button>
                  <Button onClick={() => void saveAgentDetail()} disabled={!agentDetail.name.trim() || busyId === selectedAgent.id}>
                    {busyId === selectedAgent.id ? "Saving..." : "Save changes"}
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function UserManagementPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "edit" | "view">("view");
  const [newPerms, setNewPerms] = useState<Permission[]>(DEFAULT_PERMS["view"]);
  const [newTeamAccess, setNewTeamAccess] = useState<TeamAccess | "">("");
  const [newAllowedTabs, setNewAllowedTabs] = useState<string[]>([]);
  const [newAllowedAgents, setNewAllowedAgents] = useState("");
  const [newAllowedSubTabs, setNewAllowedSubTabs] = useState<string[]>([]);
  const [newLockToToday, setNewLockToToday] = useState(false);
  const [newSamiaCurse, setNewSamiaCurse] = useState(false);
  const [newHideBackendStats, setNewHideBackendStats] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPw, setEditPw] = useState("");
  const [editRole, setEditRole] = useState<"admin" | "edit" | "view">("view");
  const [editPerms, setEditPerms] = useState<Permission[]>([]);
  const [editTeamAccess, setEditTeamAccess] = useState<TeamAccess | "">("");
  const [editAllowedTabs, setEditAllowedTabs] = useState<string[]>([]);
  const [editAllowedAgents, setEditAllowedAgents] = useState("");
  const [editAllowedSubTabs, setEditAllowedSubTabs] = useState<string[]>([]);
  const [editLockToToday, setEditLockToToday] = useState(false);
  const [editSamiaCurse, setEditSamiaCurse] = useState(false);
  const [editHideBackendStats, setEditHideBackendStats] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/users", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setUsers(await r.json() as PortalUser[]);
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  function parseAgentInput(raw: string): string[] | null {
    const arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length > 0 ? arr : null;
  }

  async function addUser() {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setSaving(true); setError("");
    const perms = newRole === "admin" ? DEFAULT_PERMS["admin"] : newPerms;
    const body = {
      username: newUsername.trim(),
      password: newPassword.trim(),
      role: newRole,
      permissions: perms,
      teamAccess: newTeamAccess || null,
      allowedTabs: newAllowedTabs.length > 0 ? newAllowedTabs : null,
      allowedAgents: parseAgentInput(newAllowedAgents),
      allowedSubTabs: newAllowedSubTabs.length > 0 ? newAllowedSubTabs : null,
      lockToToday: newLockToToday,
      samiaCurse: newSamiaCurse,
      hideBackendStats: newHideBackendStats,
    };
    const r = await fetch("/api/users", { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
    if (r.ok) {
      setNewUsername(""); setNewPassword(""); setNewRole("view");
      setNewPerms(DEFAULT_PERMS["view"]); setNewTeamAccess("");
      setNewAllowedTabs([]); setNewAllowedAgents("");
      setNewAllowedSubTabs([]); setNewLockToToday(false); setNewSamiaCurse(false); setNewHideBackendStats(false);
      await load();
    } else { const d = await r.json() as { error?: string }; setError(d.error ?? "Failed to add user"); }
    setSaving(false);
  }

  async function patchUser(id: number, updates: Record<string, unknown>) {
    await fetch(`/api/users/${id}`, { method: "PATCH", headers: authHeaders(token), body: JSON.stringify(updates) });
    setEditingId(null); await load();
  }

  async function deleteUser(u: PortalUser) {
    if (!confirm(`Permanently delete user "${u.username}"? This cannot be undone.`)) return;
    const r = await fetch(`/api/users/${u.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { const d = await r.json().catch(() => ({})) as { error?: string }; setError(d.error ?? "Failed to delete user"); return; }
    setEditingId(null); await load();
  }

  function startEdit(u: PortalUser) {
    if (editingId === u.id) { setEditingId(null); return; }
    setEditingId(u.id);
    setEditPw("");
    setEditRole(u.role as "admin" | "edit" | "view");
    setEditPerms(u.permissions);
    setEditTeamAccess((u.teamAccess ?? "") as TeamAccess | "");
    setEditAllowedTabs(u.allowedTabs ?? []);
    setEditAllowedAgents((u.allowedAgents ?? []).join(", "));
    setEditAllowedSubTabs(u.allowedSubTabs ?? []);
    setEditLockToToday(!!u.lockToToday);
    setEditSamiaCurse(!!u.samiaCurse);
    setEditHideBackendStats(!!u.hideBackendStats);
  }

  const roleBadge = (role: string) =>
    role === "admin" ? "bg-muted metric-info border-border" :
    role === "edit"  ? "bg-muted metric-warn border-border" :
                       "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";

  const roleIcon = (role: string) =>
    role === "admin" ? <ShieldCheck className="h-3 w-3" /> :
    role === "edit"  ? <Pencil className="h-3 w-3" /> :
                       <Eye className="h-3 w-3" />;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <UserCog className="h-5 w-5 metric-info" />
            <h2 className="text-lg font-semibold text-white">User Management</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X className="h-5 w-5" /></button>
        </div>

        <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">
          {/* Add user */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add New User</p>
            <div className="flex gap-2 flex-wrap">
              <Input placeholder="Username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} className="h-8 text-sm flex-1 min-w-[130px]" />
              <Input placeholder="Password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="h-8 text-sm flex-1 min-w-[130px]" />
              <AnimatedValueSelect
                value={newRole}
                onChange={(value) => { const r = value as "admin"|"edit"|"view"; setNewRole(r); setNewPerms(DEFAULT_PERMS[r]); }}
                ariaLabel="Choose new user role"
                triggerClassName="h-8 min-w-[110px] bg-zinc-800 border-white/10 text-sm text-white"
                menuClassName="w-36"
                options={[
                  { value: "view", label: "View", emoji: "👁️" },
                  { value: "edit", label: "Edit", emoji: "✏️" },
                  { value: "admin", label: "Admin", emoji: "🛡️" },
                ]}
              />
              <AnimatedValueSelect
                value={newTeamAccess}
                onChange={(value) => setNewTeamAccess(value as TeamAccess | "")}
                ariaLabel="Choose new user team access"
                triggerClassName="h-8 min-w-[140px] bg-zinc-800 border-white/10 text-sm text-white"
                menuClassName="w-44"
                options={[
                  { value: "", label: "All Teams", emoji: "🌐" },
                  { value: "retention", label: "Retention", emoji: "🛡️" },
                  { value: "nsf", label: "NSF", emoji: "🧾" },
                  { value: "cs", label: "Internal CS", emoji: "💬" },
                ]}
              />
            </div>
            {newRole !== "admin" && (
              <div className="space-y-3">
                <div>
                  <p className="text-[11px] font-medium text-zinc-400 mb-1.5">What this user can access:</p>
                  <PermCheckboxes perms={newPerms} onChange={setNewPerms} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[11px] font-medium text-zinc-400">Tab visibility <span className="text-zinc-600 font-normal">(leave all unchecked = follow team access rules)</span></p>
                    {newAllowedTabs.length > 0 && <button onClick={() => setNewAllowedTabs([])} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Clear all</button>}
                  </div>
                  <TabCheckboxes tabs={newAllowedTabs} onChange={setNewAllowedTabs} />
                </div>
                <div>
                  <p className="text-[11px] font-medium text-zinc-400 mb-1">Agent allowlist <span className="text-zinc-600 font-normal">(blank = all agents)</span></p>
                  <Input placeholder="e.g. Levi Miller, Henry Hart, Ryan Henderson" value={newAllowedAgents} onChange={(e) => setNewAllowedAgents(e.target.value)} className="h-8 text-xs" />
                  <p className="text-[10px] text-zinc-600 mt-1">Comma-separated agent names. Only these agents' stats will be visible.</p>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-[11px] font-medium text-zinc-400">Sub-tab visibility <span className="text-zinc-600 font-normal">(unchecked = all)</span></p>
                    {newAllowedSubTabs.length > 0 && <button onClick={() => setNewAllowedSubTabs([])} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Clear</button>}
                  </div>
                  <SubTabCheckboxes tabs={newAllowedSubTabs} onChange={setNewAllowedSubTabs} />
                </div>
                <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
                  <input type="checkbox" checked={newLockToToday} onChange={(e) => setNewLockToToday(e.target.checked)} className="h-3.5 w-3.5 accent-blue-500" />
                  Lock date to today (hide date range picker)
                </label>
              </div>
            )}
            {newRole === "admin" && (
              <p className="text-[11px] text-zinc-500 px-1">Admins always have full access to everything.</p>
            )}
            <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer px-1">
              <input type="checkbox" checked={newSamiaCurse} onChange={(e) => setNewSamiaCurse(e.target.checked)} className="h-3.5 w-3.5 accent-rose-500" />
              Samia curse mode (refuses to answer, only replies "fuck you")
            </label>
            <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer px-1">
              <input type="checkbox" checked={newHideBackendStats} onChange={(e) => setNewHideBackendStats(e.target.checked)} className="h-3.5 w-3.5 accent-amber-500" />
              Hide Backend Statistics tab
            </label>
            <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground w-full" onClick={addUser} disabled={saving || !newUsername.trim() || !newPassword.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add User
            </Button>
            {error && <p className="text-xs metric-bad">{error}</p>}
          </div>

          {/* User list */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Users ({users.length})</p>
            {loading ? <Skeleton className="h-24 w-full" /> : users.map((u) => (
              <div key={u.id} className={`rounded-lg border space-y-2 ${u.active ? "border-white/10 bg-zinc-900/60" : "border-white/5 bg-zinc-900/30 opacity-60"}`}>
                {/* Header row */}
                <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <AvatarName name={u.username} size="sm" textClassName="text-sm font-medium text-white" />
                    <Badge className={`text-[10px] px-1.5 py-0 flex items-center gap-1 border ${roleBadge(u.role)}`}>
                      {roleIcon(u.role)}{u.role}
                    </Badge>
                    {u.teamAccess && (
                      <Badge className={`text-[10px] px-1.5 py-0 border ${TEAM_ACCESS_COLORS[u.teamAccess] ?? ""}`}>
                        {TEAM_ACCESS_LABELS[u.teamAccess] ?? u.teamAccess}
                      </Badge>
                    )}
                    {!u.active && <Badge className="text-[10px] px-1.5 py-0 bg-red-500/20 text-red-400 border-red-500/30">Disabled</Badge>}
                    {/* Permission pills */}
                    {u.role !== "admin" && (u.permissions ?? []).map((p) => {
                      const info = ALL_PERMISSIONS.find((x) => x.key === p);
                      return info ? (
                        <span key={p} className="text-[10px] px-1.5 py-0.5 rounded bg-muted-foreground/10 metric-info border border-border">
                          {info.label}
                        </span>
                      ) : null;
                    })}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => startEdit(u)} className={`p-1 rounded transition-colors ${editingId === u.id ? "metric-info bg-muted-foreground/10" : "text-zinc-500 hover:text-white"}`} title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {u.active
                      ? <button onClick={() => patchUser(u.id, { active: false })} className="p-1 rounded text-zinc-500 hover:text-red-400 transition-colors" title="Disable"><UserX className="h-3.5 w-3.5" /></button>
                      : <button onClick={() => patchUser(u.id, { active: true })} className="p-1 rounded text-zinc-500 hover:metric-good transition-colors" title="Enable"><UserCheck className="h-3.5 w-3.5" /></button>
                    }
                    <button onClick={() => deleteUser(u)} className="p-1 rounded text-zinc-500 hover:text-red-500 transition-colors" title="Delete permanently"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>

                {/* Edit panel */}
                {editingId === u.id && (
                  <div className="px-3 pb-3 pt-0 space-y-3 border-t border-white/5">
                    <div className="flex gap-2 items-center flex-wrap pt-2">
                      <Input placeholder="New password (optional)" type="password" value={editPw} onChange={(e) => setEditPw(e.target.value)} className="h-7 text-xs flex-1 min-w-[140px]" />
                      <AnimatedValueSelect
                        value={editRole}
                        onChange={(value) => { const r = value as "admin"|"edit"|"view"; setEditRole(r); if (r === "admin") setEditPerms(DEFAULT_PERMS["admin"]); }}
                        ariaLabel="Choose user role"
                        triggerClassName="h-7 min-w-[105px] bg-zinc-800 border-white/10 text-xs text-white"
                        menuClassName="w-36"
                        options={[
                          { value: "view", label: "View", emoji: "👁️" },
                          { value: "edit", label: "Edit", emoji: "✏️" },
                          { value: "admin", label: "Admin", emoji: "🛡️" },
                        ]}
                      />
                      <AnimatedValueSelect
                        value={editTeamAccess}
                        onChange={(value) => setEditTeamAccess(value as TeamAccess | "")}
                        ariaLabel="Choose user team access"
                        triggerClassName="h-7 min-w-[135px] bg-zinc-800 border-white/10 text-xs text-white"
                        menuClassName="w-44"
                        options={[
                          { value: "", label: "All Teams", emoji: "🌐" },
                          { value: "retention", label: "Retention", emoji: "🛡️" },
                          { value: "nsf", label: "NSF", emoji: "🧾" },
                          { value: "cs", label: "Internal CS", emoji: "💬" },
                        ]}
                      />
                    </div>
                    {editRole !== "admin" && (
                      <div className="space-y-3">
                        <div>
                          <p className="text-[11px] font-medium text-zinc-400 mb-1">Permissions:</p>
                          <PermCheckboxes perms={editPerms} onChange={setEditPerms} />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[11px] font-medium text-zinc-400">Tab visibility <span className="text-zinc-600 font-normal">(unchecked all = follow team access)</span></p>
                            {editAllowedTabs.length > 0 && <button onClick={() => setEditAllowedTabs([])} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Clear all</button>}
                          </div>
                          <TabCheckboxes tabs={editAllowedTabs} onChange={setEditAllowedTabs} />
                        </div>
                        <div>
                          <p className="text-[11px] font-medium text-zinc-400 mb-1">Agent allowlist <span className="text-zinc-600 font-normal">(blank = all agents)</span></p>
                          <Input placeholder="e.g. Levi Miller, Henry Hart" value={editAllowedAgents} onChange={(e) => setEditAllowedAgents(e.target.value)} className="h-7 text-xs" />
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[11px] font-medium text-zinc-400">Sub-tab visibility <span className="text-zinc-600 font-normal">(unchecked = all)</span></p>
                            {editAllowedSubTabs.length > 0 && <button onClick={() => setEditAllowedSubTabs([])} className="text-[10px] text-zinc-500 hover:text-zinc-300 underline">Clear</button>}
                          </div>
                          <SubTabCheckboxes tabs={editAllowedSubTabs} onChange={setEditAllowedSubTabs} />
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
                          <input type="checkbox" checked={editLockToToday} onChange={(e) => setEditLockToToday(e.target.checked)} className="h-3.5 w-3.5 accent-blue-500" />
                          Lock date to today (hide date range picker)
                        </label>
                      </div>
                    )}
                    {editRole === "admin" && <p className="text-[11px] text-zinc-500">Admins always have full access.</p>}
                    <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
                      <input type="checkbox" checked={editSamiaCurse} onChange={(e) => setEditSamiaCurse(e.target.checked)} className="h-3.5 w-3.5 accent-rose-500" />
                      Samia curse mode (refuses to answer, only replies "fuck you")
                    </label>
                    <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
                      <input type="checkbox" checked={editHideBackendStats} onChange={(e) => setEditHideBackendStats(e.target.checked)} className="h-3.5 w-3.5 accent-amber-500" />
                      Hide Backend Statistics tab
                    </label>
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                      <Button size="sm" className="h-7 text-xs bg-primary hover:bg-primary/90 text-primary-foreground px-3" onClick={() => patchUser(u.id, {
                        role: editRole,
                        permissions: editRole === "admin" ? DEFAULT_PERMS["admin"] : editPerms,
                        teamAccess: editTeamAccess || null,
                        allowedTabs: editRole === "admin" ? null : (editAllowedTabs.length > 0 ? editAllowedTabs : null),
                        allowedAgents: editRole === "admin" ? null : parseAgentInput(editAllowedAgents),
                        allowedSubTabs: editRole === "admin" ? null : (editAllowedSubTabs.length > 0 ? editAllowedSubTabs : null),
                        lockToToday: editRole === "admin" ? false : editLockToToday,
                        samiaCurse: editSamiaCurse,
                        hideBackendStats: editHideBackendStats,
                        ...(editPw ? { password: editPw } : {}),
                      })}>
                        <KeyRound className="h-3 w-3 mr-1" />Save
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function BlockedNumbersPanel({ onClose }: { onClose: () => void }) {
  const { token } = useUser();
  const [items, setItems] = useState<{ number: string; note: string | null; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNumber, setNewNumber] = useState("");
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [hoveredNumber, setHoveredNumber] = useState<string | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<{ number: string; note: string | null; createdAt: string } | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/blocked-numbers", { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setItems((await r.json() as { data: { number: string; note: string | null; createdAt: string }[] }).data);
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedNumber) return;
    const updated = items.find((item) => item.number === selectedNumber.number);
    setSelectedNumber(updated ?? null);
  }, [items, selectedNumber]);

  async function addNumber() {
    const num = newNumber.trim();
    if (!num) return;
    setSaving(true); setError("");
    const r = await fetch("/api/blocked-numbers", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ number: num, note: newNote.trim() || null }),
    });
    if (r.ok) { setNewNumber(""); setNewNote(""); await load(); }
    else { const d = await r.json() as { error?: string }; setError(d.error ?? "Failed to add"); }
    setSaving(false);
  }

  async function removeNumber(num: string) {
    await fetch(`/api/blocked-numbers/${encodeURIComponent(num)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (selectedNumber?.number === num) setSelectedNumber(null);
    await load();
  }

  const activeCount = items.length;
  const latestBlocked = items[0]?.createdAt
    ? new Date(items[0].createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "None";
  const rowVariants = shouldReduceMotion
    ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1 },
      }
    : {
        hidden: { opacity: 0, x: -22, scale: 0.97, filter: "blur(4px)" },
        visible: {
          opacity: 1,
          x: 0,
          scale: 1,
          filter: "blur(0px)",
          transition: { type: "spring", stiffness: 420, damping: 30, mass: 0.6 },
        },
      };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="relative w-full max-w-4xl mx-4 rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 metric-bad" />
            <h2 className="text-lg font-semibold text-white">Blocked Numbers</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-xl border border-white/8 bg-zinc-900/60 p-3">
              <p className="text-xs uppercase tracking-wider text-zinc-500">Blocked</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-white">{activeCount}</p>
            </div>
            <div className="rounded-xl border border-white/8 bg-zinc-900/60 p-3">
              <p className="text-xs uppercase tracking-wider text-zinc-500">Latest</p>
              <p className="mt-1 text-sm font-medium text-zinc-200">{latestBlocked}</p>
            </div>
            <div className="rounded-xl border border-white/8 bg-zinc-900/60 p-3">
              <p className="text-xs uppercase tracking-wider text-zinc-500">Rule</p>
              <p className="mt-1 text-sm font-medium text-zinc-200">Excluded from missed-call lists</p>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add Number</p>
            <div className="flex gap-2">
              <Input placeholder="+1XXXXXXXXXX" value={newNumber} onChange={(e) => setNewNumber(e.target.value)} className="h-8 text-sm flex-1" />
              <Input placeholder="Note (optional)" value={newNote} onChange={(e) => setNewNote(e.target.value)} className="h-8 text-sm flex-1" />
            </div>
            <Button size="sm" className="bg-destructive hover:bg-destructive/90 text-destructive-foreground w-full" onClick={addNumber} disabled={saving || !newNumber.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" />Block Number
            </Button>
            {error && <p className="text-xs metric-bad">{error}</p>}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Blocked ({items.length})</p>
            {loading ? <Skeleton className="h-16 w-full" /> : items.length === 0 ? (
              <p className="text-xs text-zinc-600 py-3 text-center">No numbers blocked yet.</p>
            ) : (
              <motion.div
                className="space-y-2"
                variants={{ visible: { transition: { staggerChildren: shouldReduceMotion ? 0 : 0.055, delayChildren: shouldReduceMotion ? 0 : 0.05 } } }}
                initial="hidden"
                animate="visible"
              >
                <div className="hidden sm:grid grid-cols-12 gap-4 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  <div className="col-span-1">No</div>
                  <div className="col-span-4">Number</div>
                  <div className="col-span-4">Note</div>
                  <div className="col-span-2">Added</div>
                  <div className="col-span-1 text-right">Action</div>
                </div>
                {items.map((item, index) => {
                  const added = new Date(item.createdAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
                  const isHovered = hoveredNumber === item.number;
                  return (
                    <motion.div
                      key={item.number}
                      variants={rowVariants}
                      className="relative cursor-pointer"
                      onMouseEnter={() => setHoveredNumber(item.number)}
                      onMouseLeave={() => setHoveredNumber(null)}
                      onClick={() => setSelectedNumber(item)}
                    >
                      <motion.div
                        className="relative overflow-hidden rounded-xl border border-white/8 bg-zinc-900/60 p-4"
                        whileHover={shouldReduceMotion ? undefined : { y: -1, transition: { type: "spring", stiffness: 420, damping: 26 } }}
                      >
                        <div
                          className={cn(
                            "pointer-events-none absolute inset-0 bg-gradient-to-l from-red-500/10 to-transparent opacity-0 transition-opacity",
                            isHovered && "opacity-100",
                          )}
                          style={{ backgroundSize: "30% 100%", backgroundPosition: "right", backgroundRepeat: "no-repeat" }}
                        />
                        <div className="relative grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-4 sm:items-center">
                          <div className="hidden sm:block sm:col-span-1">
                            <span className="text-2xl font-bold text-zinc-600 tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                          </div>
                          <div className="sm:col-span-4">
                            <p className="text-xs text-zinc-500 sm:hidden">Number</p>
                            <p className="text-sm font-mono font-semibold text-white">{item.number}</p>
                          </div>
                          <div className="sm:col-span-4 min-w-0">
                            <p className="text-xs text-zinc-500 sm:hidden">Note</p>
                            <p className="truncate text-sm text-zinc-300">{item.note || "No note added"}</p>
                          </div>
                          <div className="sm:col-span-2">
                            <p className="text-xs text-zinc-500 sm:hidden">Added</p>
                            <p className="text-sm text-zinc-300">{added}</p>
                          </div>
                          <div className="sm:col-span-1 sm:text-right">
                            <button
                              onClick={(e) => { e.stopPropagation(); void removeNumber(item.number); }}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-background/50 text-zinc-500 transition-colors hover:metric-bad hover:bg-muted/60"
                              title="Unblock number"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
          </div>
        </div>
        <AnimatePresence>
          {selectedNumber && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.2 }}
              className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-2xl bg-zinc-950/80 backdrop-blur-sm"
            >
              <div className="flex items-center justify-between border-b border-white/10 bg-gradient-to-r from-muted/50 to-transparent p-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-zinc-900 text-zinc-500">
                    <PhoneOff className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold font-mono text-white">{selectedNumber.number}</h3>
                    <p className="text-sm text-zinc-500">Blocked number detail</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <motion.button
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-sm metric-bad transition-colors hover:bg-muted"
                    onClick={() => void removeNumber(selectedNumber.number)}
                    whileHover={shouldReduceMotion ? undefined : { scale: 1.02 }}
                    whileTap={shouldReduceMotion ? undefined : { scale: 0.98 }}
                  >
                    <X className="h-3.5 w-3.5" />
                    Unblock
                  </motion.button>
                  <motion.button
                    className="ml-1 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/80 hover:bg-background"
                    onClick={() => setSelectedNumber(null)}
                    whileHover={shouldReduceMotion ? undefined : { scale: 1.05 }}
                    whileTap={shouldReduceMotion ? undefined : { scale: 0.95 }}
                    aria-label="Close number detail"
                  >
                    <X className="h-4 w-4" />
                  </motion.button>
                </div>
              </div>
              <div className="flex-1 space-y-4 overflow-y-auto p-5">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="rounded-lg border border-white/8 bg-zinc-900/60 p-3">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Number</label>
                    <div className="mt-1 text-sm font-mono font-medium text-white">{selectedNumber.number}</div>
                  </div>
                  <div className="rounded-lg border border-white/8 bg-zinc-900/60 p-3">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Added</label>
                    <div className="mt-1 text-sm font-medium text-white">
                      {new Date(selectedNumber.createdAt).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/8 bg-zinc-900/60 p-3">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</label>
                    <div className="mt-1 inline-flex rounded-lg border border-border bg-muted/50 px-2.5 py-1 text-sm font-medium metric-bad">Blocked</div>
                  </div>
                </div>
                <div className="rounded-lg border border-white/8 bg-zinc-900/60 p-3">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Note</label>
                  <div className="mt-2 text-sm text-zinc-200">{selectedNumber.note || "No note was added for this number."}</div>
                </div>
                <div className="rounded-lg border border-white/8 bg-zinc-900/60 p-3">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Recent Activity</label>
                  <div className="mt-2 space-y-1 font-mono text-xs">
                    <div className="metric-bad">[{new Date(selectedNumber.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}] Number added to blocklist</div>
                    <div className="text-zinc-500">Missed-call reports will ignore this number.</div>
                    <div className="text-zinc-500">Dashboard stats are recalculated after refresh.</div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

interface QuoLine {
  id: string;
  name: string;
  formattedNumber: string;
  number: string;
  team: "retention" | "nsf" | "cs" | null;
  users: { id: string; firstName: string; lastName: string; email: string }[];
}

interface LineStatsResponse {
  agentStats: Record<string, Record<string, PhoneAgentDay>>;
  agentLastCall: Record<string, string>;
  lineInbounds?: { total: number; answered: number; missed: number };
  agentUniqueContactsAll?: Record<string, number>;
}

const LINE_TEAM_COLORS: Record<string, string> = {
  retention: "bg-muted-foreground/20 metric-info border border-border",
  nsf: "bg-muted metric-warn border border-border",
  cs: "bg-muted metric-info border border-border",
};
const LINE_TEAM_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "Internal CS" };

function QuoLinesPanel() {
  const todayIso = todayPDT();
  const thisMonthStart = todayIso.slice(0, 7) + "-01";
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const [selectedLine, setSelectedLine] = useState<QuoLine | null>(null);
  const [agentFilter, setAgentFilter] = useState("");
  const [dayFilter, setDayFilter] = useState("");

  const linesQ = useQuery<{ data: QuoLine[] }>({
    queryKey: ["allLines"],
    queryFn: async () => {
      const r = await fetch("/api/quo/all-lines");
      if (!r.ok) throw new Error("Failed to load lines");
      return r.json() as Promise<{ data: QuoLine[] }>;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const statsQ = useQuery<LineStatsResponse | null>({
    queryKey: ["lineStats", selectedLine?.id, from, to],
    queryFn: async () => {
      if (!selectedLine) return null;
      const pFrom = new Date(`${from}T00:00:00`).toISOString();
      const pTo = new Date(`${to}T23:59:59`).toISOString();
      const r = await fetch(
        `/api/quo/line-stats?lineId=${encodeURIComponent(selectedLine.id)}&from=${encodeURIComponent(pFrom)}&to=${encodeURIComponent(pTo)}`
      );
      if (!r.ok) return null;
      return r.json() as Promise<LineStatsResponse>;
    },
    enabled: !!selectedLine,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setAgentFilter("");
    setDayFilter("");
  }, [selectedLine]);

  const availableDays = useMemo(() => {
    if (!statsQ.data) return [];
    const days = new Set<string>();
    for (const agentDays of Object.values(statsQ.data.agentStats)) {
      for (const d of Object.keys(agentDays)) days.add(d);
    }
    return Array.from(days).sort();
  }, [statsQ.data]);

  const allAgentNames = useMemo(() => {
    if (!statsQ.data) return [];
    return Object.keys(statsQ.data.agentStats)
      .filter((n) => !PHONE_BLOCKLIST.has(normalizeAgent(n)))
      .sort((a, b) => a.localeCompare(b));
  }, [statsQ.data]);

  const phoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = new Map<string, PhoneAgentMetrics>();
    if (!statsQ.data) return map;
    const { agentStats, agentLastCall, agentUniqueContactsAll } = statsQ.data;
    for (const [agentName, days] of Object.entries(agentStats)) {
      const key = normalizeAgent(agentName);
      if (PHONE_BLOCKLIST.has(key)) continue;
      if (agentFilter === KILLERS_FILTER) {
        if (!isKillerAgentKey(key)) continue;
      } else if (agentFilter && normalizeAgent(agentFilter) !== key) continue;
      const acc: PhoneAgentMetrics = {
        calls: 0, seconds: 0, answered: 0, missed: 0,
        voicemail: 0, vmBrief: 0, inbound: 0, outbound: 0,
        uniqueContacts: 0, lastCallAt: agentLastCall?.[agentName],
      };
      const dayEntries = dayFilter
        ? Object.entries(days).filter(([d]) => d === dayFilter)
        : Object.entries(days);
      for (const [, day] of dayEntries) {
        acc.calls += day.totalCalls ?? 0;
        acc.seconds += day.talkSeconds ?? 0;
        acc.answered += day.answered ?? 0;
        acc.missed += day.missed ?? 0;
        acc.voicemail += day.voicemail ?? 0;
        acc.vmBrief += day.vmBrief ?? 0;
        acc.inbound += day.inbound ?? 0;
        acc.outbound += day.outbound ?? 0;
        acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      // When no day filter and the server provides the cross-range deduplicated count, use it.
      // This prevents double-counting numbers called on multiple days.
      if (!dayFilter && agentUniqueContactsAll?.[agentName] != null) {
        acc.uniqueContacts = agentUniqueContactsAll[agentName];
      }
      if (acc.outbound === 0 && acc.answered === 0) continue;
      if (acc.calls > 0 || acc.seconds > 0) {
        const existing = map.get(key);
        if (existing) {
          const mergedLast = existing.lastCallAt && acc.lastCallAt
            ? (existing.lastCallAt > acc.lastCallAt ? existing.lastCallAt : acc.lastCallAt)
            : (existing.lastCallAt ?? acc.lastCallAt);
          map.set(key, {
            calls: existing.calls + acc.calls, seconds: existing.seconds + acc.seconds,
            answered: existing.answered + acc.answered, missed: existing.missed + acc.missed,
            voicemail: existing.voicemail + acc.voicemail, vmBrief: existing.vmBrief + acc.vmBrief,
            inbound: existing.inbound + acc.inbound, outbound: existing.outbound + acc.outbound,
            uniqueContacts: existing.uniqueContacts + acc.uniqueContacts, lastCallAt: mergedLast,
          });
        } else {
          map.set(key, acc);
        }
      }
    }
    return map;
  }, [statsQ.data, agentFilter, dayFilter]);

  const agentList = useMemo(
    () => Array.from(phoneData.keys()).map((k) => k.replace(/\b\w/g, (c) => c.toUpperCase())),
    [phoneData]
  );

  const lineTotals = useMemo(() => {
    let calls = 0, seconds = 0;
    for (const v of phoneData.values()) { calls += v.calls; seconds += v.seconds; }
    return { calls, seconds };
  }, [phoneData]);

  const lineInbounds = statsQ.data?.lineInbounds;
  const isFiltered = agentFilter !== "" || dayFilter !== "";

  if (selectedLine) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
          <div>
            <button
              type="button"
              onClick={() => setSelectedLine(null)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
            >
              <ChevronLeft className="h-4 w-4" />
              Back to all lines
            </button>
            <CardTitle className="text-xl flex items-center gap-2">
              <PhoneCall className="h-5 w-5 metric-info" />
              {selectedLine.name}
              {selectedLine.team && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${LINE_TEAM_COLORS[selectedLine.team]}`}>
                  {LINE_TEAM_LABELS[selectedLine.team]}
                </span>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{selectedLine.formattedNumber} · Agent analytics</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => statsQ.refetch()} disabled={statsQ.isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${statsQ.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />
          {!statsQ.isLoading && allAgentNames.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <AnimatedValueSelect
                value={agentFilter}
                onChange={setAgentFilter}
                ariaLabel="Filter line stats by agent"
                triggerClassName="min-w-[180px]"
                menuClassName="w-64"
                options={[
                  { value: "", label: "All agents", emoji: "👥" },
                  ...(allAgentNames.some((n) => isKillerAgentKey(normalizeAgent(n))) ? [{ value: KILLERS_FILTER, label: "Killers", emoji: "⚔️" }] : []),
                  ...allAgentNames.map((n) => ({ value: n, label: n, emoji: "👤" })),
                ]}
              />
              <AnimatedValueSelect
                value={dayFilter}
                onChange={setDayFilter}
                ariaLabel="Filter line stats by day"
                triggerClassName="min-w-[150px]"
                menuClassName="w-48"
                options={[
                  { value: "", label: "All days", emoji: "🗓️" },
                  ...availableDays.map((d) => ({ value: d, label: d, emoji: "📅" })),
                ]}
              />
              {isFiltered && (
                <button
                  type="button"
                  onClick={() => { setAgentFilter(""); setDayFilter(""); }}
                  className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
                >
                  Clear filters
                </button>
              )}
            </div>
          )}
          {(lineTotals.calls > 0 || (lineInbounds?.total ?? 0) > 0) && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile label="Total calls" value={lineTotals.calls.toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Time on calls" value={formatHours(lineTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
              <StatTile label="Agents active" value={agentList.length.toLocaleString()} icon={<Users className="h-3.5 w-3.5" />} tone="blue" />
              {(lineInbounds?.total ?? 0) > 0 && !isFiltered && (
                <StatTile
                  label="Missed inbounds"
                  value={lineInbounds!.missed.toLocaleString()}
                  icon={<PhoneIncoming className="h-3.5 w-3.5" />}
                  tone="rose"
                  sub={lineInbounds!.answered > 0 ? `${lineInbounds!.answered} answered` : undefined}
                />
              )}
            </div>
          )}
          {statsQ.isLoading && <TableSkeleton />}
          {!statsQ.isLoading && agentList.length > 0 && (
            <ByCallStatsView agentList={agentList} phoneData={phoneData} directKeys={true} />
          )}
          {!statsQ.isLoading && agentList.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              {isFiltered ? "No calls match the selected filters." : "No calls on this line in the selected period."}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const lines = linesQ.data?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl">Quo Lines</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            All OpenPhone lines · click any line to view per-agent analytics
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => linesQ.refetch()} disabled={linesQ.isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${linesQ.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />
        {linesQ.isLoading && <TableSkeleton />}
        {linesQ.error && (
          <ErrorState message="Failed to load lines." onRetry={() => linesQ.refetch()} />
        )}
        {lines.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {lines.map((line) => (
              <button
                key={line.id}
                type="button"
                onClick={() => setSelectedLine(line)}
                className="text-left p-4 rounded-lg border bg-card hover:bg-accent/40 hover:border-border transition-all group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate group-hover:metric-info transition-colors">
                      {line.name}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 font-mono">{line.formattedNumber}</div>
                  </div>
                  {line.team && (
                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${LINE_TEAM_COLORS[line.team]}`}>
                      {LINE_TEAM_LABELS[line.team]}
                    </span>
                  )}
                </div>
                {line.users && line.users.length > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground/70 truncate">
                    {line.users.map((u) => `${u.firstName} ${u.lastName}`).join(", ")}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── VoSLogic Panel ────────────────────────────────────────────────────────────

interface VosAgentStat {
  agentName: string;
  calls: number;
  inbound: number;
  outbound: number;
  avgDuration: number;
}

interface VosLiveCall {
  id: number;
  direction: string;
  agentName: string | null;
  phoneLabel: string;
  ringGroupName: string | null;
  duration: number;
  startedAt: string;
}

interface VosAgentStatus {
  id: number;
  name: string;
  extension: string;
  status: string;
  callsToday: number;
}

interface VosRingGroup {
  id: number;
  name: string;
  agentIds: number[];
}

interface VosAgent {
  id: number;
  name: string;
  extension: string;
  status: string;
  ringGroupIds: number[];
}

interface VosDashboardData {
  activeCalls: number;
  totalAgents: number;
  onlineAgents: number;
  availableAgents: number;
  totalCallsToday: number;
  avgDurationToday: number;
  totalInboundToday: number;
  totalOutboundToday: number;
  missedCallsToday: number;
  callsByAgent: VosAgentStat[];
  liveCalls: VosLiveCall[];
  agentStatuses: VosAgentStatus[];
}

interface VosStatsResponse {
  dashboard: VosDashboardData;
  agents: VosAgent[];
  ringGroups: VosRingGroup[];
}

function VoSPanel() {
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("All");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "calls", dir: "desc" });

  const q = useQuery<VosStatsResponse>({
    queryKey: ["vosStats"],
    queryFn: async () => {
      const r = await fetch("/api/vos/stats");
      if (!r.ok) throw new Error("Failed to load VoSLogic stats");
      return r.json() as Promise<VosStatsResponse>;
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const liveQ = useQuery<{ liveCalls: VosLiveCall[]; agentStatuses: VosAgentStatus[] }>({
    queryKey: ["vosLive"],
    queryFn: async () => {
      const r = await fetch("/api/vos/live");
      if (!r.ok) return { liveCalls: [], agentStatuses: [] };
      return r.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const liveAgentNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of liveQ.data?.liveCalls ?? []) if (c.agentName) s.add(c.agentName.trim().toLowerCase());
    for (const a of liveQ.data?.agentStatuses ?? []) if (a.status === "on_call") s.add(a.name.trim().toLowerCase());
    return s;
  }, [liveQ.data]);

  const agentGroupMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of q.data?.ringGroups ?? []) for (const id of g.agentIds) m.set(id, g.name);
    return m;
  }, [q.data]);

  const agentIdMap = useMemo(() => {
    const m = new Map<string, VosAgent>();
    for (const a of q.data?.agents ?? []) m.set(a.name.trim().toLowerCase(), a);
    return m;
  }, [q.data]);

  const groups = useMemo(() => {
    const s = new Set<string>(["All"]);
    for (const g of q.data?.ringGroups ?? []) s.add(g.name);
    return [...s];
  }, [q.data]);

  function toggle(col: string) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  }

  function SortTh({ col, label, tone = "" }: { col: string; label: string; tone?: string }) {
    const active = sort.col === col;
    return (
      <TableHead className={`whitespace-nowrap text-right ${tone}`}>
        <button type="button" onClick={() => toggle(col)}
          className={`inline-flex items-center gap-1 flex-row-reverse font-semibold hover:text-foreground ${active ? "metric-info" : "text-muted-foreground"}`}>
          {label}
          {active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
        </button>
      </TableHead>
    );
  }

  const visible = useMemo(() => {
    const stats = q.data?.dashboard.callsByAgent ?? [];
    const q2 = search.trim().toLowerCase();
    let list = stats.filter((a) => a.calls > 0);
    if (q2) list = list.filter((a) => a.agentName.toLowerCase().includes(q2));
    if (groupFilter !== "All") {
      const group = q.data?.ringGroups.find((g) => g.name === groupFilter);
      if (group) {
        const ids = new Set(group.agentIds);
        list = list.filter((a) => {
          const agent = agentIdMap.get(a.agentName.trim().toLowerCase());
          return agent && ids.has(agent.id);
        });
      }
    }
    return [...list].sort((a, b) => {
      let av = 0, bv = 0;
      if (sort.col === "calls") { av = a.calls; bv = b.calls; }
      else if (sort.col === "inbound") { av = a.inbound; bv = b.inbound; }
      else if (sort.col === "outbound") { av = a.outbound; bv = b.outbound; }
      else if (sort.col === "avgDuration") { av = a.avgDuration; bv = b.avgDuration; }
      else if (sort.col === "name") return sort.dir === "asc" ? a.agentName.localeCompare(b.agentName) : b.agentName.localeCompare(a.agentName);
      return sort.dir === "asc" ? av - bv : bv - av;
    });
  }, [q.data, search, groupFilter, sort, agentIdMap]);

  const d = q.data?.dashboard;
  const isFetching = q.isFetching || liveQ.isFetching;
  const totCalls = visible.reduce((s, a) => s + a.calls, 0);
  const totIn = visible.reduce((s, a) => s + a.inbound, 0);
  const totOut = visible.reduce((s, a) => s + a.outbound, 0);
  const totAvgDur = totCalls > 0 ? Math.round(visible.reduce((s, a) => s + a.avgDuration * a.calls, 0) / totCalls) : 0;
  const visibleNameSet = useMemo(() => new Set(visible.map((a) => a.agentName.trim().toLowerCase())), [visible]);
  const filteredActiveCalls = (liveQ.data?.liveCalls ?? []).filter((c) => c.agentName && visibleNameSet.has(c.agentName.trim().toLowerCase())).length;

  const tileTotals = groupFilter === "All" && d
    ? { activeCalls: d.activeCalls, totalCalls: d.totalCallsToday, inbound: d.totalInboundToday, outbound: d.totalOutboundToday, missed: d.missedCallsToday, avgDuration: d.avgDurationToday }
    : { activeCalls: filteredActiveCalls, totalCalls: totCalls, inbound: totIn, outbound: totOut, missed: null as number | null, avgDuration: totAvgDur };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl flex items-center gap-2">
            PBX
            <Badge className="text-[10px] px-1.5 py-0.5 bg-muted-foreground/20 metric-info border-border">Live</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Real-time call stats from PBX phone system · refreshes every 30s</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { q.refetch(); liveQ.refetch(); }} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {q.isLoading && <Skeleton className="h-40 w-full" />}
        {q.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {String(q.error)}
          </div>
        )}
        {d && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
              <StatTile label="Active calls" value={tileTotals.activeCalls} icon={<PhoneCall className="h-3.5 w-3.5" />} tone="emerald" />
              <StatTile label="Total today" value={tileTotals.totalCalls} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Inbound today" value={tileTotals.inbound} icon={<PhoneIncoming className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Outbound today" value={tileTotals.outbound} icon={<PhoneOutgoing className="h-3.5 w-3.5" />} tone="blue" />
              {tileTotals.missed !== null && <StatTile label="Missed today" value={tileTotals.missed} icon={<PhoneMissed className="h-3.5 w-3.5" />} tone="rose" />}
              <StatTile label="Avg duration" value={formatDuration(tileTotals.avgDuration)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
            </div>

            {(liveQ.data?.liveCalls ?? []).length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Live calls right now</p>
                <div className="flex flex-wrap gap-2">
                  {(liveQ.data?.liveCalls ?? []).map((c) => (
                    <div key={c.id} className="ops-pill flex items-center gap-2 rounded-full px-3 py-1.5 text-xs">
                      <span className="relative flex h-2 w-2 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-muted-foreground" />
                      </span>
                      <AvatarName name={c.agentName ?? "Unknown"} size="xs" textClassName="metric-good font-medium" />
                      <span className="text-zinc-500">·</span>
                      <span className="text-zinc-400">{c.direction === "outbound" ? "↑" : "↓"} {formatDuration(c.duration)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search agents…" value={search} onChange={(e) => setSearch(e.target.value)} className="ops-input pl-9" />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {groups.map((g) => (
                  <button key={g} onClick={() => setGroupFilter(g)}
                    className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${groupFilter === g ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-white hover:bg-white/5"}`}>
                    {g}
                  </button>
                ))}
              </div>
              <Badge variant="secondary" className="font-mono ml-auto">{visible.length} agents</Badge>
            </div>

            <div className="ops-table-wrap overflow-hidden">
              <div className="overflow-x-auto max-h-[60vh]">
                <Table>
                  <TableHeader className="sticky top-0 backdrop-blur z-10">
                    <TableRow>
                      <TableHead className="text-left text-muted-foreground">
                        <button type="button" onClick={() => toggle("name")}
                          className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${sort.col === "name" ? "metric-info" : "text-muted-foreground"}`}>
                          Agent {sort.col === "name" ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                        </button>
                      </TableHead>
                      <TableHead className="text-center text-xs text-muted-foreground font-medium">Status</TableHead>
                      <SortTh col="calls" label="Total calls" />
                      <SortTh col="inbound" label="Inbound" tone="metric-info" />
                      <SortTh col="outbound" label="Outbound" tone="metric-info" />
                      <SortTh col="avgDuration" label="Avg duration" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">No agents match the current filters.</TableCell>
                      </TableRow>
                    )}
                    {visible.map((agent) => {
                      const nameKey = agent.agentName.trim().toLowerCase();
                      const isLive = liveAgentNames.has(nameKey);
                      const vosAgent = agentIdMap.get(nameKey);
                      const statusObj = liveQ.data?.agentStatuses.find((s) => s.name.trim().toLowerCase() === nameKey);
                      const status = statusObj?.status ?? vosAgent?.status ?? "offline";
                      const statusColor = status === "on_call" ? "metric-good" : status === "available" ? "metric-info" : status === "idle" ? "metric-warn" : "text-zinc-500";
                      const statusLabel = status === "on_call" ? "On call" : status === "available" ? "Available" : status === "idle" ? "Idle" : "Offline";
                      const group = vosAgent ? agentGroupMap.get(vosAgent.id) : undefined;
                      return (
                        <TableRow key={agent.agentName} className="hover-elevate">
                          <TableCell className="font-medium whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              {isLive && (
                                <span className="relative flex h-2.5 w-2.5 shrink-0">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-muted-foreground opacity-75" />
                                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-muted-foreground" />
                                </span>
                              )}
                              <AvatarName name={agent.agentName} size="sm" textClassName="text-foreground" />
                              {group && <Badge className="text-[9px] px-1 py-0 bg-muted-foreground/15 metric-info border-border">{group}</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className={`text-center text-xs font-medium ${statusColor}`}>{statusLabel}</TableCell>
                          <TableCell className={`text-right tabular-nums font-mono ${!agent.calls ? "text-muted-foreground/40" : ""}`}>{agent.calls || "—"}</TableCell>
                          <TableCell className={`text-right tabular-nums font-mono ${agent.inbound ? "metric-info" : "text-muted-foreground/40"}`}>{agent.inbound || "—"}</TableCell>
                          <TableCell className={`text-right tabular-nums font-mono ${agent.outbound ? "metric-info" : "text-muted-foreground/40"}`}>{agent.outbound || "—"}</TableCell>
                          <TableCell className="text-right tabular-nums font-mono text-muted-foreground">{agent.avgDuration ? formatDuration(agent.avgDuration) : "—"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                  {visible.length > 0 && (
                    <TableHeader className="sticky bottom-0 backdrop-blur z-10">
                      <TableRow>
                        <TableCell className="font-bold">Whole team</TableCell>
                        <TableCell />
                        <TableCell className="text-right tabular-nums font-mono font-bold">{totCalls || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totIn || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totOut || "—"}</TableCell>
                        <TableCell />
                      </TableRow>
                    </TableHeader>
                  )}
                </Table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── ReadyMode Panel ──────────────────────────────────────────────────────────

interface RmAgentStat {
  agentName: string;
  dialed: number;
  connected: number;
  talkTimeSecs: number;
  avgTalkSecs: number;
  connectRate: number;
}

interface RmStatsResponse {
  agents: RmAgentStat[];
  totals: { dialed: number; connected: number; talkTimeSecs: number; connectRate: number };
  updatedAt: string;
  raw?: string;
}

// ─── Ready-Mode Killers ──────────────────────────────────────────────────────
// A ReadyMode-only team: call activity comes solely from the ReadyMode dialer
// (no OpenPhone/PBX lines). Submissions come from the same shared Discord-bot
// sheets as the other teams. The roster is fixed (provided by ops) and matched
// by normalized agent name.
const RMK_AGENT_NAMES = new Set<string>([
  "jackson miller",
  "leah tanner",
  "isabella cruz",
  "henry cole",
  "henry marcus",
  "jonathan underwood",
]);
const RMK_DISPLAY: Record<string, string> = {
  "jackson miller": "Jackson Miller",
  "leah tanner": "Leah Tanner",
  "isabella cruz": "Isabella Cruz",
  "henry cole": "Henry Cole",
  "henry marcus": "Henry Marcus",
  "jonathan underwood": "Jonathan Underwood",
};

// Sentinel value used by agent-filter dropdowns to mean "the Killers team".
const KILLERS_FILTER = "__killers__";
// An agent belongs to the Ready-Mode Killers roster when its normalized key —
// or any dash-separated segment of a compound name — is in RMK_AGENT_NAMES.
function isKillerAgentKey(agentKey: string): boolean {
  if (RMK_AGENT_NAMES.has(agentKey)) return true;
  return agentKey.split("-").map((s) => s.trim()).some((seg) => RMK_AGENT_NAMES.has(seg));
}

function resolveKillerAgentKey(agentRaw: string): string | null {
  const norm = normalizeAgent(agentRaw);
  if (!norm) return null;
  const resolvedKey = NAME_ALIASES[norm] ?? norm;
  if (RMK_AGENT_NAMES.has(norm)) return norm;
  if (RMK_AGENT_NAMES.has(resolvedKey)) return resolvedKey;
  for (const seg of norm.split("-").map((s) => s.trim()).filter(Boolean)) {
    const segResolved = NAME_ALIASES[seg] ?? seg;
    if (RMK_AGENT_NAMES.has(seg)) return seg;
    if (RMK_AGENT_NAMES.has(segResolved)) return segResolved;
  }
  return null;
}

// Canonical submission-status column order for the breakdown view; any other
// status the sheets produce is appended afterwards alphabetically.
const RMK_STATUS_ORDER = ["Retained", "Cancelled", "Fixed", "IDP-Handled"];
function rmkStatusTone(status: string): string {
  const l = status.toLowerCase();
  if (/retain/.test(l)) return "metric-good";
  if (/cancel/.test(l)) return "metric-bad";
  if (/\bidp\b/.test(l)) return "metric-info";
  if (/fixed/.test(l)) return "metric-info";
  return "text-zinc-300";
}

// Submissions for the Ready-Mode Killers team are pulled (per ops) from four
// sources, matched to the fixed Killer roster by normalized agent name:
//   1. Fixes               — Discord-bot sheet gid=0   (NEW_NSF_URL)            → "Fixed" (keyword override)
//   2. IDP-Handled         — gid=871007220             (IDP_RETENTION_URL)      → "IDP-Handled"
//   3. IDP-Cancel-Retained — gid=1018337469            (IDP_CANCEL_RETAINED_URL)→ "Retained"
//   4. Retained/Cancelled  — retention sheet gid=837339339 (NEW_RETENTION_URL)  → "Retained" or "Cancelled"
async function fetchRMKSubmissions(): Promise<SheetData> {
  // Match a sheet's agent name against the fixed Killer roster, resolving
  // aliases and dash-separated compound names ("riham samir-leah tanner-1234").
  const matchesRMK = (agentRaw: string): boolean => !!resolveKillerAgentKey(agentRaw);

  // Sources 1–3 share spreadsheet 11kOhk8x — fetch sequentially so Google does
  // not silently drop concurrent requests on the same workbook. Source 4 is a
  // different workbook and is fetched alongside.
  const newRetentionP = fetchHeaderCsv(NEW_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const newRows = await fetchNewSheetForTeam(RMK_AGENT_NAMES).catch(() => [] as Row[]);
  const idpRows = await fetchIDPSheetForTeam(RMK_AGENT_NAMES).catch(() => [] as Row[]);
  const idpCancelSheet = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const newRetentionSheet = await newRetentionP;

  // 3. IDP Cancel Retained → every row is a Retained for the submitting agent.
  const idpCancelRows: Row[] = [];
  for (const r of idpCancelSheet.rows) {
    const d = parseEgyptTimestamp((r["Timestamp"] ?? "").trim());
    if (!d) continue;
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw || !matchesRMK(agentRaw)) continue;
    const key = resolveKillerAgentKey(agentRaw);
    idpCancelRows.push({ Agent: key ? (RMK_DISPLAY[key] ?? agentRaw) : agentRaw, Status: "Retained", Date: toCaliforniaDateStr(d), "File ID": (r["File ID"] ?? "").trim(), __sourceTab: "IDP-Cancel-Retained" });
  }

  // 4. Retention sheet → keep Retained and Cancelled rows (IDP-Handled rows are
  // already covered by source 2, so they are skipped here).
  const retentionRows: Row[] = [];
  for (const r of newRetentionSheet.rows) {
    const d = parseEgyptTimestamp((r["Timestamp"] ?? "").trim());
    if (!d) continue;
    const agentRaw = (r["Agent Name"] ?? "").trim();
    if (!agentRaw || !matchesRMK(agentRaw)) continue;
    const kw = detectKeywordStatus(r);
    const derived = kw ?? deriveNewRetentionStatus(r["Cancel request update"] ?? "");
    if (derived !== "Retained" && derived !== "Cancelled") continue;
    const key = resolveKillerAgentKey(agentRaw);
    retentionRows.push({ Agent: key ? (RMK_DISPLAY[key] ?? agentRaw) : agentRaw, Status: derived, Date: toCaliforniaDateStr(d), "File ID": (r["File ID"] ?? "").trim() });
  }

  const rows = [...newRows, ...idpRows, ...idpCancelRows, ...retentionRows].map((row) => {
    const key = resolveKillerAgentKey(row.Agent ?? "");
    return key ? { ...row, Agent: RMK_DISPLAY[key] ?? row.Agent } : row;
  });

  return { headers: ["Agent", "Status", "Date", "File ID"], rows };
}

function ReadyModeKillersPanel() {
  const todayIso = todayPDT();
  const [from, setFrom] = useState(todayIso);
  const [to, setTo] = useState(todayIso);
  const { user } = useUser();
  const roster = useRoster();
  const lockToToday = !!user.lockToToday;
  const allowedSubTabs = user.allowedSubTabs ?? null;
  const subTabAllowed = (t: string) => !allowedSubTabs || allowedSubTabs.includes(t);
  const defaultSubTab = allowedSubTabs?.[0] ?? "call";
  useEffect(() => {
    if (lockToToday) { setFrom(todayPDT()); setTo(todayPDT()); }
  }, [lockToToday, todayIso]);

  const fromDate = from ? parseDate(from) : null;
  const toDate = to ? parseDate(to) : null;
  if (toDate) toDate.setHours(23, 59, 59, 999);

  const rmQ = useQuery<RmStatsResponse | null>({
    queryKey: ["rmkReadymodeStats", from, to],
    queryFn: async () => {
      const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await fetch(`/api/readymode/stats${qs}`);
      if (!res.ok) return null;
      return res.json() as Promise<RmStatsResponse>;
    },
    staleTime: 1000 * 30,
    refetchOnWindowFocus: true,
    refetchInterval: 60 * 1000,
  });

  const phoneQ = useQuery<PhoneStatsResponse | null>({
    queryKey: ["rmkPhoneStats", from, to],
    queryFn: async () => {
      const pFrom = from ? new Date(`${from}T00:00:00`).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
      const pTo = to ? new Date(`${to}T23:59:59`).toISOString() : new Date().toISOString();
      return fetchPhoneStats(pFrom, pTo);
    },
    staleTime: PHONE_STALE_MS,
    refetchOnWindowFocus: false,
    refetchInterval: PHONE_REFETCH_MS,
  });

  const subsQ = useQuery<SheetData>({
    queryKey: ["rmkSubmissions"],
    queryFn: fetchRMKSubmissions,
    staleTime: SHEET_STALE_MS,
    refetchOnWindowFocus: false,
    refetchInterval: SHEET_REFETCH_MS,
  });

  const aggregated = useMemo(() => {
    if (!subsQ.data) return null;
    return aggregate(subsQ.data, "rmk", fromDate, toDate, roster);
  }, [subsQ.data, from, to, roster]);

  const rmkKeys = useMemo(() => {
    const keys = new Set<string>(RMK_AGENT_NAMES);
    for (const a of roster.agentsForTeam("killers")) keys.add(normalizeAgent(a.name));
    return keys;
  }, [roster]);

  // ReadyMode dialer stats keyed by normalized name, restricted to the team.
  const rmByKey = useMemo(() => {
    const m = new Map<string, RmAgentStat>();
    for (const a of rmQ.data?.agents ?? []) {
      const key = resolveKillerAgentKey(a.agentName) ?? normalizeAgent(a.agentName);
      if (!rmkKeys.has(key)) continue;
      const prev = m.get(key);
      if (prev) {
        const dialed = prev.dialed + a.dialed;
        const connected = prev.connected + a.connected;
        const talkTimeSecs = prev.talkTimeSecs + a.talkTimeSecs;
        m.set(key, {
          agentName: prev.agentName,
          dialed, connected, talkTimeSecs,
          avgTalkSecs: connected ? Math.round(talkTimeSecs / connected) : 0,
          connectRate: dialed ? Math.round((connected / dialed) * 100) : 0,
        });
      } else {
        m.set(key, { ...a, agentName: RMK_DISPLAY[key] ?? a.agentName });
      }
    }
    return m;
  }, [rmQ.data, rmkKeys]);

  const rmkCsvByKey = useMemo<Map<string, { calls: number; seconds: number }>>(() => {
    const map = new Map<string, { calls: number; seconds: number }>();
    for (const [key, rm] of rmByKey) {
      map.set(key, { calls: rm.dialed, seconds: rm.talkTimeSecs });
    }
    return map;
  }, [rmByKey]);

  const rmkPhoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = new Map<string, PhoneAgentMetrics>();
    const agentStats = phoneQ.data?.allAgentStats ?? {};
    const lastCallMap = phoneQ.data?.allAgentLastCall ?? {};
    for (const [agentName, days] of Object.entries(agentStats)) {
      const key = resolveKillerAgentKey(agentName) ?? normalizeAgent(agentName);
      if (!rmkKeys.has(key)) continue;
      const acc: PhoneAgentMetrics = {
        calls: 0,
        seconds: 0,
        answered: 0,
        missed: 0,
        voicemail: 0,
        vmBrief: 0,
        inbound: 0,
        outbound: 0,
        uniqueContacts: 0,
        lastCallAt: lastCallMap[agentName],
      };
      for (const day of Object.values(days)) {
        acc.calls += day.totalCalls ?? 0;
        acc.seconds += day.talkSeconds ?? 0;
        acc.answered += day.answered ?? 0;
        acc.missed += day.missed ?? 0;
        acc.voicemail += day.voicemail ?? 0;
        acc.vmBrief += day.vmBrief ?? 0;
        acc.inbound += day.inbound ?? 0;
        acc.outbound += day.outbound ?? 0;
        acc.uniqueContacts += day.uniqueContacts ?? 0;
      }
      if (acc.calls > 0 || acc.seconds > 0 || acc.lastCallAt) map.set(key, acc);
    }
    return map;
  }, [phoneQ.data, rmkKeys]);

  const rmkCsvPhoneData = useMemo<Map<string, PhoneAgentMetrics>>(() => {
    const map = new Map<string, PhoneAgentMetrics>();
    for (const [key, rm] of rmByKey) {
      map.set(key, {
        calls: rm.dialed,
        seconds: rm.talkTimeSecs,
        answered: rm.connected,
        missed: 0,
        voicemail: 0,
        vmBrief: 0,
        inbound: 0,
        outbound: rm.dialed,
        uniqueContacts: rm.connected,
      });
    }
    return map;
  }, [rmByKey]);

  const callAgentList = useMemo(() => {
    const names = new Map<string, string>();
    for (const key of rmkKeys) names.set(key, RMK_DISPLAY[key] ?? key.replace(/\b\w/g, (c) => c.toUpperCase()));
    for (const a of (aggregated && !("error" in aggregated) ? aggregated.byAgent : [])) {
      const key = normalizeAgent(a.agent);
      names.set(key, a.agent);
    }
    for (const [key, rm] of rmByKey) names.set(key, RMK_DISPLAY[key] ?? rm.agentName);
    for (const key of rmkPhoneData.keys()) names.set(key, RMK_DISPLAY[key] ?? key.replace(/\b\w/g, (c) => c.toUpperCase()));
    return [...names.entries()].map(([, name]) => name).sort((a, b) => a.localeCompare(b));
  }, [aggregated, rmByKey, rmkKeys, rmkPhoneData]);

  const phoneTotals = useMemo(() => {
    let calls = 0, seconds = 0, answered = 0;
    for (const v of rmkPhoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; }
    for (const v of rmkCsvPhoneData.values()) { calls += v.calls; seconds += v.seconds; answered += v.answered; }
    return { calls, seconds, answered, connectRate: calls ? Math.round((answered / calls) * 100) : 0 };
  }, [rmkPhoneData, rmkCsvPhoneData]);

  const activeAgentCount = useMemo(() => {
    const active = new Set<string>();
    for (const [key, v] of rmkPhoneData) if (v.calls > 0 || v.seconds > 0) active.add(key);
    for (const [key, v] of rmkCsvPhoneData) if (v.calls > 0 || v.seconds > 0) active.add(key);
    if (aggregated && !("error" in aggregated)) {
      for (const a of aggregated.byAgent) if (a.total > 0) active.add(normalizeAgent(a.agent));
    }
    return active.size;
  }, [aggregated, rmkPhoneData, rmkCsvPhoneData]);

  function refresh() { rmQ.refetch(); phoneQ.refetch(); subsQ.refetch(); }
  const isFetching = rmQ.isFetching || phoneQ.isFetching || subsQ.isFetching;

  return (
    <Card className="ops-panel rounded-lg">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl flex items-center gap-2">
            Ready-Mode Killers
            <Badge className="text-[10px] px-1.5 py-0.5 bg-muted metric-warn border-border">Dialer</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Call activity from the ReadyMode dialer · submissions from the shared sheets
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {(rmQ.isLoading || phoneQ.isLoading || subsQ.isLoading) && <TableSkeleton />}
        {aggregated && "error" in aggregated && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {aggregated.error}
          </div>
        )}

        {!lockToToday && <PresetFilter from={from} to={to} setFrom={setFrom} setTo={setTo} />}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {subTabAllowed("call") && (
            <>
              <StatTile label="Agents" value={activeAgentCount.toLocaleString()} icon={<Users className="h-3.5 w-3.5" />} tone="blue" />
              <StatTile label="Total calls" value={phoneTotals.calls.toLocaleString()} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
              <StatTile label="Connected" value={phoneTotals.answered.toLocaleString()} icon={<PhoneCall className="h-3.5 w-3.5" />} tone="emerald" />
              <StatTile label="Connect rate" value={`${phoneTotals.connectRate}%`} icon={<Activity className="h-3.5 w-3.5" />} tone="blue" />
              <StatTile label="Talk time" value={formatHours(phoneTotals.seconds)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
              <StatTile label="Avg talk" value={avgDuration(phoneTotals.seconds, phoneTotals.answered)} tone="amber" />
            </>
          )}
          {aggregated && !("error" in aggregated) && subTabAllowed("files") && (
            <>
              <StatTile label="Submissions" value={aggregated.totals.grand.toLocaleString()} icon={<Receipt className="h-3.5 w-3.5" />} tone="emerald" />
              <StatTile label="Retained" value={(aggregated.totals.byStatus.get("Retained") ?? 0).toLocaleString()} tone="emerald" />
              <StatTile label="Cancelled" value={(aggregated.totals.byStatus.get("Cancelled") ?? 0).toLocaleString()} tone="rose" />
              <StatTile label="Fixed" value={(aggregated.totals.byStatus.get("Fixed") ?? 0).toLocaleString()} tone="sky" />
              <StatTile label="IDP-Handled" value={(aggregated.totals.byStatus.get("IDP-Handled") ?? 0).toLocaleString()} tone="blue" />
            </>
          )}
        </div>

        <Tabs defaultValue={defaultSubTab} className="space-y-4">
          <TabsList>
            {subTabAllowed("call") && <TabsTrigger value="call">By call</TabsTrigger>}
            {aggregated && !("error" in aggregated) && (
              <>
                {subTabAllowed("files") && <TabsTrigger value="files">By files</TabsTrigger>}
                {subTabAllowed("day") && <TabsTrigger value="day">By day</TabsTrigger>}
              </>
            )}
          </TabsList>
          {subTabAllowed("call") && (
            <TabsContent value="call">
              <ByCallStatsView agentList={callAgentList} phoneData={rmkPhoneData} directKeys readymodeByKey={rmkCsvByKey} phoneSourceLabel="OpenPhone/QUO" />
            </TabsContent>
          )}
          {aggregated && !("error" in aggregated) && (
            <>
              {subTabAllowed("files") && (
                <TabsContent value="files">
                  <ByFilesView data={aggregated} phoneData={rmkPhoneData} sheetData={subsQ.data} fromDate={fromDate} toDate={toDate} />
                </TabsContent>
              )}
              {subTabAllowed("day") && (
                <TabsContent value="day">
                  <ByDayView data={aggregated} />
                </TabsContent>
              )}
            </>
          )}
        </Tabs>

        {aggregated && !("error" in aggregated) && aggregated.totals.grand === 0 && !subsQ.isLoading && (
          <p className="text-xs text-muted-foreground">No submissions in this date range.</p>
        )}

        {rmQ.error && (
          <p className="text-xs text-muted-foreground">ReadyMode data could not be loaded right now.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ReadyModePanel() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" }>({ col: "dialed", dir: "desc" });
  const [showRaw, setShowRaw] = useState(false);
  const { token } = useUser();

  const q = useQuery<RmStatsResponse>({
    queryKey: ["readymodeStats"],
    queryFn: async () => {
      const r = await fetch("/api/readymode/stats", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json() as Promise<RmStatsResponse>;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  function toggle(col: string) {
    setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" });
  }

  function SortTh({ col, label, tone = "" }: { col: string; label: string; tone?: string }) {
    const active = sort.col === col;
    return (
      <TableHead className={`whitespace-nowrap text-right ${tone}`}>
        <button type="button" onClick={() => toggle(col)}
          className={`inline-flex items-center gap-1 flex-row-reverse font-semibold hover:text-foreground ${active ? "metric-info" : "text-muted-foreground"}`}>
          {label}
          {active ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
        </button>
      </TableHead>
    );
  }

  const visible = useMemo(() => {
    const agents = q.data?.agents ?? [];
    const q2 = search.trim().toLowerCase();
    let list = q2 ? agents.filter((a) => a.agentName.toLowerCase().includes(q2)) : agents;
    return [...list].sort((a, b) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      if (sort.col === "name") return dir * a.agentName.localeCompare(b.agentName);
      if (sort.col === "dialed") return dir * (a.dialed - b.dialed);
      if (sort.col === "connected") return dir * (a.connected - b.connected);
      if (sort.col === "connectRate") return dir * (a.connectRate - b.connectRate);
      if (sort.col === "talkTime") return dir * (a.talkTimeSecs - b.talkTimeSecs);
      if (sort.col === "avgTalk") return dir * (a.avgTalkSecs - b.avgTalkSecs);
      return 0;
    });
  }, [q.data, search, sort]);

  const totals = q.data?.totals;
  const isFetching = q.isFetching;
  const hasData = (q.data?.agents ?? []).length > 0;
  const hasRaw = !!q.data?.raw;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 gap-4">
        <div>
          <CardTitle className="text-xl flex items-center gap-2">
            ReadyMode
            <Badge className="text-[10px] px-1.5 py-0.5 bg-muted metric-warn border-border">Dialer</Badge>
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            {q.data?.updatedAt
              ? `Per-agent dialer stats · updated ${new Date(q.data.updatedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: CA_TZ })} PDT`
              : "Per-agent call stats from ReadyMode dialer · refreshes every 60s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasRaw && (
            <Button variant="outline" size="sm" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "Hide raw" : "Show raw"}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {q.isLoading && <Skeleton className="h-40 w-full" />}

        {q.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm space-y-2">
            <p className="font-medium text-destructive">Could not load ReadyMode data</p>
            <p className="text-muted-foreground">{String(q.error)}</p>
            <p className="text-xs text-muted-foreground">
              The ReadyMode portal uses session-based authentication. If the error persists, the login credentials may
              have changed or the session probe path needs updating.
            </p>
          </div>
        )}

        {showRaw && q.data?.raw && (
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Raw page preview (first 3000 chars) — use to identify API paths</p>
            <pre className="text-[10px] text-zinc-400 whitespace-pre-wrap break-all overflow-auto max-h-64">{q.data.raw}</pre>
          </div>
        )}

        {totals && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Total dialed" value={totals.dialed} icon={<Phone className="h-3.5 w-3.5" />} tone="sky" />
            <StatTile label="Connected" value={totals.connected} icon={<PhoneCall className="h-3.5 w-3.5" />} tone="emerald" />
            <StatTile label="Connect rate" value={`${totals.connectRate}%`} icon={<Activity className="h-3.5 w-3.5" />} tone="blue" />
            <StatTile label="Total talk time" value={formatDuration(totals.talkTimeSecs)} icon={<Clock className="h-3.5 w-3.5" />} tone="amber" />
          </div>
        )}

        {!q.isLoading && !q.error && !hasData && q.data && (
          <div className="rounded-lg border border-border bg-muted/40 p-5 text-sm space-y-3">
            <p className="font-medium metric-warn">Session active — no parseable agent table found yet</p>
            <p className="text-muted-foreground text-xs">
              ReadyMode returned a page but no agent call table could be parsed. This is normal during initial setup.
              Use the "Show raw" button above to inspect the HTML and identify the correct report path.
            </p>
            <p className="text-muted-foreground text-xs">
              You can also call <code className="bg-muted px-1 rounded">/api/readymode/probe?path=/supervisor/</code> from the browser to inspect other paths.
            </p>
          </div>
        )}

        {hasData && (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search agents…" value={search} onChange={(e) => setSearch(e.target.value)} className="ops-input pl-9" />
              </div>
              <Badge variant="secondary" className="font-mono ml-auto">{visible.length} agents</Badge>
            </div>

            <div className="ops-table-wrap overflow-hidden">
              <div className="overflow-x-auto max-h-[60vh]">
                <Table>
                  <TableHeader className="sticky top-0 backdrop-blur z-10">
                    <TableRow>
                      <TableHead className="text-left text-muted-foreground">
                        <button type="button" onClick={() => toggle("name")}
                          className={`inline-flex items-center gap-1 font-semibold hover:text-foreground ${sort.col === "name" ? "metric-info" : "text-muted-foreground"}`}>
                          Agent {sort.col === "name" ? (sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                        </button>
                      </TableHead>
                      <SortTh col="dialed" label="Dialed" tone="metric-info" />
                      <SortTh col="connected" label="Connected" tone="metric-good" />
                      <SortTh col="connectRate" label="Connect %" tone="metric-info" />
                      <SortTh col="talkTime" label="Talk time" />
                      <SortTh col="avgTalk" label="Avg talk" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">No agents match the current filters.</TableCell>
                      </TableRow>
                    )}
                    {visible.map((agent) => (
                      <TableRow key={agent.agentName} className="hover-elevate">
                        <TableCell className="font-medium whitespace-nowrap">
                          <AvatarName name={agent.agentName} size="sm" textClassName="text-foreground" />
                        </TableCell>
                        <TableCell className={`text-right tabular-nums font-mono ${agent.dialed ? "metric-info" : "text-muted-foreground/40"}`}>{agent.dialed || "—"}</TableCell>
                        <TableCell className={`text-right tabular-nums font-mono ${agent.connected ? "metric-good" : "text-muted-foreground/40"}`}>{agent.connected || "—"}</TableCell>
                        <TableCell className={`text-right tabular-nums font-mono ${agent.connectRate >= 20 ? "metric-info" : agent.connectRate > 0 ? "text-zinc-300" : "text-muted-foreground/40"}`}>
                          {agent.connectRate > 0 ? `${agent.connectRate}%` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-mono text-muted-foreground">{agent.talkTimeSecs ? formatDuration(agent.talkTimeSecs) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono text-muted-foreground">{agent.avgTalkSecs ? formatDuration(agent.avgTalkSecs) : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  {visible.length > 0 && (
                    <TableHeader className="sticky bottom-0 backdrop-blur z-10">
                      <TableRow>
                        <TableCell className="font-bold">Whole team</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totals?.dialed || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold metric-good">{totals?.connected || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold metric-info">{totals?.connectRate ? `${totals.connectRate}%` : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums font-mono font-bold">{totals?.talkTimeSecs ? formatDuration(totals.talkTimeSecs) : "—"}</TableCell>
                        <TableCell />
                      </TableRow>
                    </TableHeader>
                  )}
                </Table>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Phones Panel (sub-tabs: Quo Lines, PBX, ReadyMode) ───────────────────────

function PhonesPanel() {
  const PHONE_SUB_TABS = [
    { value: "quo-lines", label: "Quo Lines" },
    { value: "pbx",       label: "PBX" },
    { value: "readymode", label: "ReadyMode" },
  ];
  const [sub, setSub] = useState("quo-lines");
  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-white/10 pb-0">
        {PHONE_SUB_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setSub(t.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              sub === t.value
                ? "border-border metric-info"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {sub === "quo-lines"  && <QuoLinesPanel />}
      {sub === "pbx"        && <VoSPanel />}
      {sub === "readymode"  && <ReadyModePanel />}
    </div>
  );
}

// ─── Missed / No Callback Panel ───────────────────────────────────────────────

function maskNumber(num: string): string {
  const digits = num.replace(/\D/g, "");
  const last = digits.slice(-10);
  if (last.length === 10) return `(${last.slice(0,3)}) ${last.slice(3,6)}-${last.slice(6)}`.replace(/\d{4}$/, (m) => "****".slice(0, m.length));
  return num.length > 4 ? `${"*".repeat(num.length - 4)}${num.slice(-4)}` : num;
}

function formatCallTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles" });
  return `${date}, ${time}`;
}

const TEAM_LABELS: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "Internal CS", backend: "Retention & Internal CS", other: "Other" };
const TEAM_COLORS: Record<string, string> = {
  retention: "bg-muted-foreground/15 metric-info border-border",
  nsf: "bg-muted/50 metric-info border-border",
  cs: "bg-muted-foreground/15 metric-good border-border",
  backend: "bg-muted-foreground/15 metric-info border-border",
  other: "bg-zinc-500/15 text-zinc-300 border-zinc-500/20",
};

function MissedNoCBPanel({ lockedTeam }: { lockedTeam?: TeamAccess | null }) {
  const q = useMissedNoCB();
  const qc = useQueryClient();
  const { user } = useUser();
  const canViewMissedTables = user.role === "admin" || user.permissions.includes("view_missed_tables");
  const allItems = q.data?.items ?? [];
  // If the user has a team scope, only ever show their team's items
  const items = lockedTeam ? allItems.filter((it) => it.team === lockedTeam) : allItems;
  const fetchedAt = q.data?.fetchedAt ?? 0;
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "pbx" | "quo" | "readymode">("all");
  const [lineFilter, setLineFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [missedMode, setMissedMode] = useState<"times" | "numbers">("times");

  const teams = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.team !== "other") s.add(it.team);
    return Array.from(s).sort();
  }, [items]);

  const lines = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.toNumber) s.add(it.toNumber);
    return Array.from(s).sort();
  }, [items]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items) {
      c[it.team] = (c[it.team] ?? 0) + 1;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    let list = items;
    if (!lockedTeam && teamFilter !== "all") {
      list = list.filter((it) => it.team === teamFilter);
    }
    if (sourceFilter !== "all") list = list.filter((it) => it.source === sourceFilter);
    if (lineFilter !== "all") list = list.filter((it) => it.toNumber === lineFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((it) =>
        it.fromNumber.includes(q) ||
        it.ringGroupName.toLowerCase().includes(q) ||
        (it.toNumber ?? "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [items, teamFilter, sourceFilter, lineFilter, lockedTeam, search]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <PhoneOff className="h-4 w-4 metric-bad" />
            <CardTitle className="text-base">Missed Calls — No Callback</CardTitle>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {fetchedAt > 0 && <span>Updated {new Date(fetchedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles" })} PDT</span>}
            <Button size="sm" variant="ghost" className="h-7 px-2 gap-1" onClick={async () => {
              await fetch("/api/vos/refresh", { method: "POST" });
              await qc.invalidateQueries({ queryKey: ["missedNoCB"] });
            }}>
              <RefreshCw className="h-3 w-3" /> Refresh
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Missed calls (PBX ring groups + Quo/OpenPhone) with no outbound callback made after the missed call today.
        </p>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Team count tiles */}
        {lockedTeam ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-sm">
            <StatTile label="Missed / No CB" value={q.isLoading ? "…" : items.length.toLocaleString()} tone="rose" icon={<PhoneOff className="h-3.5 w-3.5" />} />
            <StatTile
              label={TEAM_LABELS[lockedTeam] ?? lockedTeam}
              value={q.isLoading ? "…" : (counts[lockedTeam] ?? 0).toLocaleString()}
              tone={lockedTeam === "retention" ? "blue" : lockedTeam === "nsf" ? "sky" : "emerald"}
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Total missed / no CB" value={q.isLoading ? "…" : items.length.toLocaleString()} tone="rose" icon={<PhoneOff className="h-3.5 w-3.5" />} />
            <StatTile label="Retention" value={q.isLoading ? "…" : (counts["retention"] ?? 0).toLocaleString()} tone="blue" />
            <StatTile label="Internal CS" value={q.isLoading ? "…" : (counts["cs"] ?? 0).toLocaleString()} tone="emerald" />
            <StatTile label="NSF" value={q.isLoading ? "…" : (counts["nsf"] ?? 0).toLocaleString()} tone="sky" />
          </div>
        )}

        {/* Filters — hidden for team-locked users */}
        <div className="flex items-center gap-3 flex-wrap">
          {!lockedTeam && (
            <>
              <div className="flex items-center gap-1.5">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Team:</span>
              </div>
              {(["all", "retention", "cs", "nsf"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTeamFilter(t)}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    teamFilter === t
                      ? t === "retention"
                        ? "bg-muted-foreground/25 metric-info border-border"
                        : t === "cs"
                        ? "bg-muted-foreground/25 metric-good border-border"
                        : t === "nsf"
                        ? "bg-muted metric-info border-border"
                        : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
                      : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-500"
                  }`}
                >
                  {t === "all" ? "All" : TEAM_LABELS[t] ?? t}
                </button>
              ))}
            </>
          )}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Source:</span>
          </div>
          {(["all", "pbx", "quo", "readymode"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSourceFilter(s)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                sourceFilter === s
                  ? s === "quo"
                    ? "bg-muted metric-info border-border"
                    : s === "readymode"
                    ? "bg-muted metric-warn border-border"
                    : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
                  : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-500"
              }`}
            >
              {s === "all" ? "All" : s === "quo" ? "Quo" : s === "readymode" ? "Readymode" : "PBX"}
            </button>
          ))}
          {lines.length > 0 && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Line:</span>
              </div>
              <AnimatedValueSelect
                value={lineFilter}
                onChange={setLineFilter}
                ariaLabel="Filter by line"
                triggerClassName="h-7 min-w-[150px] border-zinc-700/50 bg-zinc-800/50 text-xs text-zinc-300"
                menuClassName="w-60"
                options={[
                  { value: "all", label: "All lines", emoji: "📞" },
                  ...lines.map((l) => ({ value: l, label: l, emoji: "☎️" })),
                ]}
              />
            </>
          )}
          <div className={`${lockedTeam && lines.length === 0 ? "" : "ml-auto"} flex items-center gap-2`}>
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search number or line…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 w-44 text-xs"
            />
          </div>
        </div>

        {/* Table */}
        {q.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">
            {items.length === 0 ? "No missed calls without a callback today." : "No results match the current filters."}
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 bg-zinc-900/60">
                  <TableHead className="text-xs w-36">Date & Time</TableHead>
                  <TableHead className="text-xs">Number</TableHead>
                  {!lockedTeam && <TableHead className="text-xs">Team</TableHead>}
                  <TableHead className="text-xs w-20">Source</TableHead>
                  <TableHead className="text-xs">Ring Group</TableHead>
                  <TableHead className="text-xs">Line</TableHead>
                  <TableHead className="text-xs w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((it) => (
                  <TableRow key={String(it.id)} className="border-zinc-800 hover:bg-zinc-800/40">
                    <TableCell className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                      {formatCallTime(it.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs tracking-wider">
                      {it.fromNumber}
                    </TableCell>
                    {!lockedTeam && (
                      <TableCell>
                        <Badge className={`text-[10px] px-1.5 py-0 ${TEAM_COLORS[it.team] ?? TEAM_COLORS["other"]}`}>
                          {TEAM_LABELS[it.team] ?? it.team}
                        </Badge>
                      </TableCell>
                    )}
                    <TableCell>
                      <Badge className={`text-[10px] px-1.5 py-0 border ${
                        it.source === "quo"
                          ? "bg-muted metric-info border-border"
                          : it.source === "readymode"
                          ? "bg-muted metric-warn border-border"
                          : "bg-zinc-700/40 text-zinc-300 border-zinc-600/30"
                      }`}>
                        {it.source === "quo" ? "Quo" : it.source === "readymode" ? "Readymode" : "PBX"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {it.ringGroupName}
                    </TableCell>
                    <TableCell className="text-xs text-zinc-300">
                      {it.toNumber || "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {it.source === "readymode" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px] metric-good hover:metric-good hover:bg-muted/60"
                          onClick={async () => {
                            await fetch("/api/nsf/readymode-queue/done-by-number", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ number: it.fromNumber }),
                            });
                            await qc.invalidateQueries({ queryKey: ["missedNoCB"] });
                          }}
                        >
                          Done
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Hourly missed breakdown (today) — managers only */}
        {canViewMissedTables && (
          <div className="border-t border-zinc-800 pt-4 flex items-center justify-between">
            <span className="text-xs text-zinc-500">Count by</span>
            <div className="flex gap-1">
              {(["times", "numbers"] as const).map(m => (
                <button key={m} onClick={() => setMissedMode(m)}
                  className={`text-[10px] px-2 py-0.5 rounded ${missedMode === m ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {m === "times" ? "Times" : "Numbers"}
                </button>
              ))}
            </div>
          </div>
        )}
        {canViewMissedTables && <HourlyMissedRecord mode={missedMode} />}

        {/* Daily missed record — managers only */}
        {canViewMissedTables && <DailyMissedRecord mode={missedMode} />}
      </CardContent>
    </Card>
  );
}

function HourlyMissedRecord({ mode = "times" }: { mode?: "times" | "numbers" }) {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const [date, setDate] = useState(todayStr);
  const isToday = date === todayStr;

  const { data, isLoading } = useMissedHourly(date, mode);
  const hours = data?.hours ?? [];

  const shift = (days: number) => {
    const d = new Date(date + "T12:00:00");
    d.setDate(d.getDate() + days);
    const next = d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    if (next <= todayStr) setDate(next);
  };

  const fmtDate = (d: string) => {
    if (d === todayStr) return "Today";
    const dt = new Date(d + "T12:00:00");
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };

  const fmt = (h: number) => {
    const ampm = h < 12 ? "am" : "pm";
    const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${display}${ampm}`;
  };

  const cellVal = (quo: number, ghost: number, pbx: number) => {
    const total = quo + pbx;
    if (total === 0) return <span className="text-zinc-600">—</span>;
    return (
      <span>
        {total}
        {ghost > 0 && <span className="ml-1 text-[10px] text-zinc-600">({ghost}g)</span>}
        {pbx > 0 && <span className="ml-1 text-[10px] text-zinc-500">(+{pbx} PBX)</span>}
      </span>
    );
  };

  return (
    <div className="pt-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-zinc-400">
          Missed by Hour — {mode === "numbers" ? "unique callers" : "call events"} (Quo + PBX)
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shift(-1)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Previous day"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs font-medium text-zinc-300 min-w-[90px] text-center">{fmtDate(date)}</span>
          <button
            type="button"
            onClick={() => shift(1)}
            disabled={isToday}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next day"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {isLoading ? (
        <div className="space-y-1.5">{Array.from({length:3}).map((_,i)=><Skeleton key={i} className="h-7 w-full"/>)}</div>
      ) : hours.length === 0 ? (
        <p className="text-xs text-zinc-600 py-2">No missed calls recorded for this day.</p>
      ) : (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-800 bg-zinc-900/60">
                <TableHead className="text-xs w-20">Hour</TableHead>
                <TableHead className="text-xs metric-info">Retention</TableHead>
                <TableHead className="text-xs metric-good">CS</TableHead>
                <TableHead className="text-xs metric-info">NSF</TableHead>
                <TableHead className="text-xs text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hours.map((h) => {
                const total = h.retention.quo + h.retention.pbx + h.cs.quo + h.cs.pbx + h.nsf.quo + h.nsf.pbx;
                return (
                  <TableRow key={h.hour} className="border-zinc-800 hover:bg-zinc-800/20">
                    <TableCell className="text-xs text-zinc-400 tabular-nums">{fmt(h.hour)}</TableCell>
                    <TableCell className="text-xs metric-info font-medium">{cellVal(h.retention.quo, h.retention.ghost, h.retention.pbx)}</TableCell>
                    <TableCell className="text-xs metric-good font-medium">{cellVal(h.cs.quo, h.cs.ghost, h.cs.pbx)}</TableCell>
                    <TableCell className="text-xs metric-info font-medium">{cellVal(h.nsf.quo, h.nsf.ghost, h.nsf.pbx)}</TableCell>
                    <TableCell className="text-xs text-right font-semibold text-zinc-200">{total}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

type NumberBreakdown = {
  fromNumber: string; team: string; source: "quo" | "pbx" | "both";
  missedCount: number; firstMissedAt: string; hasCallback: boolean;
  callbackConnected: boolean; callbackAt: string | null; responseMinutes: number | null;
  ghostCount: number; isGhost: boolean;
};

function fmtResponseTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function DailyMissedBreakdown({ date }: { date: string }) {
  const q = useQuery<{ date: string; numbers: NumberBreakdown[]; stats: { total: number; withCallback: number; connected: number; callbackRate: number; connectRate: number } }>({
    queryKey: ["missedBreakdown", date],
    queryFn: async () => {
      const r = await fetch(`/api/vos/missed-breakdown?date=${date}`);
      if (!r.ok) return { date, numbers: [], stats: { total: 0, withCallback: 0, connected: 0, callbackRate: 0, connectRate: 0 } };
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  if (q.isLoading) return (
    <div className="px-3 py-2 space-y-1">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
    </div>
  );

  const numbers = q.data?.numbers ?? [];
  if (numbers.length === 0) return <p className="px-3 py-2 text-xs text-zinc-600">No breakdown available.</p>;

  const realNumbers = numbers.filter(n => !n.isGhost);
  const ghostNumbers = numbers.filter(n => n.isGhost);
  const s = q.data?.stats;
  const withCB = s?.withCallback ?? realNumbers.filter(n => n.hasCallback).length;
  const connected = s?.connected ?? realNumbers.filter(n => n.callbackConnected).length;
  const noAnswer = withCB - connected;
  const notCalled = realNumbers.length - withCB;

  return (
    <div className="bg-zinc-950/60 border-t border-zinc-800/60 px-3 py-2">
      <div className="flex items-center gap-3 mb-2 text-[10px] flex-wrap">
        <span className="text-zinc-500">{realNumbers.length} unique callers</span>
        {ghostNumbers.length > 0 && <span className="text-zinc-600">{ghostNumbers.length} ghost</span>}
        <span className="metric-good font-medium">{connected} talked ({realNumbers.length > 0 ? Math.round(connected / realNumbers.length * 100) : 0}%)</span>
        {noAnswer > 0 && <span className="metric-warn">{noAnswer} no answer</span>}
        <span className="metric-bad">{notCalled} not called</span>
        {withCB > 0 && <span className="text-zinc-600">· connect rate: {Math.round(connected / withCB * 100)}%</span>}
      </div>
      <div className="space-y-px max-h-64 overflow-y-auto pr-1">
        {numbers.map((n) => (
          <div key={n.fromNumber + n.firstMissedAt} className={`flex items-center justify-between text-xs py-1 px-2 rounded hover:bg-zinc-800/40 ${n.isGhost ? "opacity-50" : ""}`}>
            <span className="font-mono text-zinc-300 tabular-nums">{n.fromNumber}</span>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-[10px] ${n.team === "retention" ? "metric-info" : n.team === "cs" ? "metric-good" : "metric-info"}`}>
                {TEAM_LABELS[n.team] ?? n.team}
              </span>
              <span className={`text-[10px] px-1 py-0.5 rounded ${n.source === "quo" ? "bg-muted-foreground/20 metric-info" : n.source === "pbx" ? "bg-muted metric-info" : "bg-zinc-500/20 text-zinc-300"}`}>
                {n.source === "both" ? "Quo+PBX" : n.source === "quo" ? "Quo" : "PBX"}
              </span>
              {n.isGhost && <span className="text-[9px] px-1 py-0.5 rounded border border-zinc-700 bg-zinc-800 text-zinc-500 uppercase font-medium">ghost</span>}
              {n.missedCount > 1 && <span className="text-zinc-600 text-[10px]">×{n.missedCount}</span>}
              {!n.isGhost && (!n.hasCallback
                ? <span className="flex items-center gap-0.5 metric-bad"><PhoneOff className="h-3 w-3" />—</span>
                : n.callbackConnected
                  ? <span className="flex items-center gap-0.5 metric-good font-medium"><PhoneCall className="h-3 w-3" />{n.responseMinutes !== null ? fmtResponseTime(n.responseMinutes) : ""}</span>
                  : <span className="flex items-center gap-0.5 metric-warn"><PhoneCall className="h-3 w-3" />no answer</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DailyMissedRecord({ mode = "times" }: { mode?: "times" | "numbers" }) {
  const { data, isLoading } = useMissedDaily(mode);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const days = data?.days ?? [];

  if (isLoading) return <div className="space-y-1.5">{Array.from({length:3}).map((_,i)=><Skeleton key={i} className="h-8 w-full"/>)}</div>;
  if (days.length === 0) return null;

  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const fmt = (d: string) => {
    if (d === todayStr) return "Today";
    const dt = new Date(d + "T12:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
  };

  return (
    <div className="border-t border-zinc-800 pt-4">
      <p className="text-xs font-medium text-zinc-400 mb-2">
        Daily Missed — {mode === "numbers" ? "unique callers" : "call events"} (PBX + Quo)
      </p>
      <div className="rounded-lg border border-zinc-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-zinc-800 bg-zinc-900/60">
              <TableHead className="text-xs w-28">Date</TableHead>
              <TableHead className="text-xs metric-info">Retention</TableHead>
              <TableHead className="text-xs metric-good">CS</TableHead>
              <TableHead className="text-xs metric-info">NSF</TableHead>
              <TableHead className="text-xs text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((d) => {
              const ret = d.retention.quo + d.retention.pbx;
              const cs  = d.cs.quo  + d.cs.pbx;
              const nsf = d.nsf.quo + d.nsf.pbx;
              const total = ret + cs + nsf;
              const isToday = d.date === todayStr;
              const isExpanded = expandedDate === d.date;
              return (
                <Fragment key={d.date}>
                  <TableRow className={`border-zinc-800 ${isToday ? "bg-zinc-800/30" : "hover:bg-zinc-800/20"}`}>
                    <TableCell className={`text-xs tabular-nums ${isToday ? "text-white font-medium" : "text-zinc-400"}`}>
                      {fmt(d.date)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="metric-info font-medium">{ret || "—"}</span>
                      {ret > 0 && (
                        <span className="text-zinc-600 ml-1 text-[10px]">
                          {d.retention.quo > 0 && <>{d.retention.quo}q</>}
                          {d.retention.ghost > 0 && <span className="text-zinc-700 ml-0.5">({d.retention.ghost}g)</span>}
                          {d.retention.pbx > 0 && <> {d.retention.pbx}p</>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="metric-good font-medium">{cs || "—"}</span>
                      {cs > 0 && (
                        <span className="text-zinc-600 ml-1 text-[10px]">
                          {d.cs.quo > 0 && <>{d.cs.quo}q</>}
                          {d.cs.ghost > 0 && <span className="text-zinc-700 ml-0.5">({d.cs.ghost}g)</span>}
                          {d.cs.pbx > 0 && <> {d.cs.pbx}p</>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="metric-info font-medium">{nsf || "—"}</span>
                      {nsf > 0 && (
                        <span className="text-zinc-600 ml-1 text-[10px]">
                          {d.nsf.quo > 0 && <>{d.nsf.quo}q</>}
                          {d.nsf.ghost > 0 && <span className="text-zinc-700 ml-0.5">({d.nsf.ghost}g)</span>}
                          {d.nsf.pbx > 0 && <> {d.nsf.pbx}p</>}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-right font-semibold text-zinc-200">
                      <button
                        onClick={() => setExpandedDate(isExpanded ? null : d.date)}
                        className="inline-flex items-center gap-1 hover:text-white transition-colors"
                        title={isExpanded ? "Collapse" : "Show per-number breakdown"}
                      >
                        {total}
                        <ChevronRight className={`h-3 w-3 text-zinc-500 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`} />
                      </button>
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow className="border-zinc-800">
                      <TableCell colSpan={5} className="p-0">
                        <DailyMissedBreakdown date={d.date} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ─── Callback Review Panel ────────────────────────────────────────────────────

type CallbackReviewItem = {
  id: string;
  fromNumber: string;
  team: string;
  source: "quo" | "pbx";
  ringGroupName: string;
  missedAt: string;
  isGhost: boolean;
  hasCallback: boolean;
  callbackConnected: boolean;
  callbackAt: string | null;
  responseMinutes: number | null;
};

type CallbackReviewStats = {
  total: number;
  ghost: number;
  withCallback: number;
  connected: number;
  rate: number;
  connectRate: number;
  avgResponseMinutes: number;
  days: number;
};

function useCallbackReview(from: string, to: string) {
  return useQuery<{ items: CallbackReviewItem[]; stats: CallbackReviewStats }>({
    queryKey: ["callbackReview", from, to],
    queryFn: async () => {
      const r = await fetch(`/api/vos/callback-review?from=${from}&to=${to}`);
      if (!r.ok) return { items: [], stats: { total: 0, withCallback: 0, connected: 0, rate: 0, connectRate: 0, avgResponseMinutes: 0, days: 0 } };
      return r.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    refetchOnWindowFocus: true,
  });
}

function CallbackReviewPanel() {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const [preset, setPreset] = useState<"today" | "week" | "month" | "custom">("today");
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);
  const [teamFilter, setTeamFilter] = useState("all");

  const { from, to } = useMemo((): { from: string; to: string } => {
    if (preset === "today") return { from: todayStr, to: todayStr };
    if (preset === "week") {
      const laDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const dow = laDate.getDay();
      const daysToMon = dow === 0 ? 6 : dow - 1;
      laDate.setDate(laDate.getDate() - daysToMon);
      return { from: laDate.toLocaleDateString("en-CA"), to: todayStr };
    }
    if (preset === "month") return { from: todayStr.slice(0, 7) + "-01", to: todayStr };
    return { from: customFrom || todayStr, to: customTo || todayStr };
  }, [preset, customFrom, customTo, todayStr]);

  const { data, isLoading } = useCallbackReview(from, to);
  const items = data?.items ?? [];

  const teamItems = useMemo(
    () => teamFilter === "all" ? items : items.filter(i => i.team === teamFilter),
    [items, teamFilter]
  );

  const stats = useMemo(() => {
    const real = teamItems.filter(i => !i.isGhost);
    const ghost = teamItems.filter(i => i.isGhost).length;
    const total = real.length;
    const withCB = real.filter(i => i.hasCallback).length;
    const connected = real.filter(i => i.callbackConnected).length;
    return { total, ghost, withCB, connected };
  }, [teamItems]);

  const dailyStats = useMemo(() => {
    const map = new Map<string, { missed: number; ghost: number; withCB: number; connected: number }>();
    for (const item of teamItems) {
      const date = new Date(item.missedAt).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
      if (!map.has(date)) map.set(date, { missed: 0, ghost: 0, withCB: 0, connected: 0 });
      const d = map.get(date)!;
      if (item.isGhost) { d.ghost++; continue; }
      d.missed++;
      if (item.hasCallback) d.withCB++;
      if (item.callbackConnected) d.connected++;
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, s]) => ({ date, ...s }));
  }, [teamItems]);

  const pct = (n: number, of: number) => of === 0 ? "—" : `${Math.round(n / of * 100)}%`;

  const fmtDay = (d: string) => {
    if (d === todayStr) return "Today";
    const dt = new Date(d + "T12:00:00");
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  };

  const btnCls = (active: boolean, activeColor = "bg-muted-foreground/25 metric-info border-border") =>
    `text-xs px-3 py-1.5 rounded-md border transition-colors ${active ? activeColor : "bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:border-zinc-500"}`;

  return (
    <Card className="border-white/5 bg-card/40 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <PhoneCall className="h-4 w-4 metric-info" />
          Callback Review
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Date range + team filters */}
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setPreset("today")} className={btnCls(preset === "today")}>Today</button>
          <button onClick={() => setPreset("week")} className={btnCls(preset === "week")}>This Week</button>
          <button onClick={() => setPreset("month")} className={btnCls(preset === "month")}>This Month</button>
          <div className="w-px h-5 bg-zinc-700" />
          <AnimatedDatePicker
            value={customFrom}
            max={todayStr}
            onChange={(next) => { setCustomFrom(next); setPreset("custom"); }}
            className="w-[132px] bg-zinc-800/50 border-zinc-700/50 text-zinc-300 hover:border-zinc-500"
            ariaLabel="Callback review from date"
            title="From date"
          />
          <span className="text-zinc-600 text-xs">—</span>
          <AnimatedDatePicker
            value={customTo}
            max={todayStr}
            onChange={(next) => { setCustomTo(next); setPreset("custom"); }}
            className="w-[132px] bg-zinc-800/50 border-zinc-700/50 text-zinc-300 hover:border-zinc-500"
            ariaLabel="Callback review to date"
            title="To date"
          />
          <div className="w-px h-5 bg-zinc-700" />
          {(["all", "retention", "cs", "nsf"] as const).map((t) => (
            <button key={t} onClick={() => setTeamFilter(t)}
              className={btnCls(teamFilter === t,
                t === "retention" ? "bg-muted-foreground/25 metric-info border-border"
                : t === "cs" ? "bg-muted-foreground/25 metric-good border-border"
                : t === "nsf" ? "bg-muted metric-info border-border"
                : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
              )}>
              {t === "all" ? "All Teams" : TEAM_LABELS[t] ?? t}
            </button>
          ))}
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatTile label="Total Missed" value={isLoading ? "…" : stats.total.toLocaleString()} tone="rose" icon={<PhoneOff className="h-3.5 w-3.5" />} />
          <StatTile label="Ghost Calls" value={isLoading ? "…" : stats.ghost.toLocaleString()} tone="zinc" icon={<PhoneOff className="h-3.5 w-3.5 opacity-40" />} />
          <StatTile label="Called Back" value={isLoading ? "…" : stats.withCB.toLocaleString()} tone="emerald" icon={<PhoneCall className="h-3.5 w-3.5" />} />
          <StatTile label="Talked" value={isLoading ? "…" : stats.connected.toLocaleString()} tone="sky" />
          <StatTile label="Connect Rate" value={isLoading ? "…" : pct(stats.connected, stats.withCB)} tone="amber" />
        </div>

        {/* Daily breakdown table */}
        {isLoading ? (
          <div className="space-y-1.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : dailyStats.length === 0 ? (
          <p className="text-sm text-zinc-600 py-8 text-center">No missed calls for this period.</p>
        ) : (
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 bg-zinc-900/60">
                  <TableHead className="text-xs">Date</TableHead>
                  <TableHead className="text-xs text-right metric-bad">Missed</TableHead>
                  <TableHead className="text-xs text-right text-zinc-500">Ghost</TableHead>
                  <TableHead className="text-xs text-right metric-good">Called Back</TableHead>
                  <TableHead className="text-xs text-right metric-info">CB%</TableHead>
                  <TableHead className="text-xs text-right metric-info">Talked</TableHead>
                  <TableHead className="text-xs text-right metric-warn">Connect%</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dailyStats.map((d) => (
                  <TableRow key={d.date} className={`border-zinc-800 hover:bg-zinc-800/20 ${d.date === todayStr ? "bg-zinc-800/30" : ""}`}>
                    <TableCell className={`text-xs font-medium ${d.date === todayStr ? "text-white" : "text-zinc-400"}`}>
                      {fmtDay(d.date)}
                    </TableCell>
                    <TableCell className="text-xs text-right text-zinc-200 tabular-nums font-medium">{d.missed}</TableCell>
                    <TableCell className="text-xs text-right text-zinc-600 tabular-nums">{d.ghost > 0 ? d.ghost : "—"}</TableCell>
                    <TableCell className="text-xs text-right metric-good tabular-nums font-medium">{d.withCB}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      <span className={`font-medium ${d.missed === 0 ? "text-zinc-600" : d.withCB / d.missed >= 0.8 ? "metric-good" : d.withCB / d.missed >= 0.6 ? "metric-warn" : "metric-bad"}`}>
                        {pct(d.withCB, d.missed)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-right metric-info tabular-nums font-medium">{d.connected}</TableCell>
                    <TableCell className="text-xs text-right tabular-nums">
                      <span className={`font-medium ${d.withCB === 0 ? "text-zinc-600" : d.connected / d.withCB >= 0.5 ? "metric-good" : d.connected / d.withCB >= 0.3 ? "metric-warn" : "metric-bad"}`}>
                        {pct(d.connected, d.withCB)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Individual phone numbers table */}
        {!isLoading && items.length > 0 && (
          <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold text-zinc-400 mr-1">Phone Numbers</p>
              {(["all","retention","cs","nsf"] as const).map(t => (
                <button key={t} onClick={() => setTeamFilter(t)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    teamFilter === t
                      ? t === "retention" ? "bg-muted-foreground/25 metric-info border-border"
                        : t === "cs" ? "bg-muted-foreground/25 metric-good border-border"
                        : t === "nsf" ? "bg-muted metric-info border-border"
                        : "bg-zinc-500/25 text-zinc-200 border-zinc-500/40"
                      : "bg-zinc-800/50 text-zinc-500 border-zinc-700/50 hover:border-zinc-500"
                  }`}>
                  {t === "all" ? "All" : t === "retention" ? "Retention" : t.toUpperCase()}
                </button>
              ))}
              <span className="text-[10px] text-zinc-600 ml-auto">{teamItems.length} numbers</span>
              <div className="flex gap-3 text-[10px] text-zinc-600">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-zinc-700 inline-block" />No CB</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/60 inline-block" />No answer</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-muted-foreground/60 inline-block" />Talked</span>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-zinc-950">
                  <TableRow className="border-zinc-800">
                    <TableHead className="text-xs w-36">Phone</TableHead>
                    <TableHead className="text-xs">Team</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">Missed At</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs text-zinc-500">Response</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teamItems.map((item) => {
                    const num = item.fromNumber.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, "$1 ($2) $3-$4");
                    const dot = !item.hasCallback ? "bg-zinc-700"
                      : item.callbackConnected ? "bg-muted-foreground/70" : "bg-muted-foreground/60";
                    const teamColor = item.team === "retention" ? "metric-info border-border bg-muted-foreground/10"
                      : item.team === "cs" ? "metric-good border-border bg-muted/60"
                      : item.team === "nsf" ? "metric-info border-border bg-muted/50"
                      : "text-zinc-400 border-zinc-600 bg-zinc-800";
                    return (
                      <TableRow key={item.id} className={`border-zinc-800/60 hover:bg-zinc-800/20 ${item.isGhost ? "opacity-50" : ""}`}>
                        <TableCell className="text-xs font-mono text-zinc-200 tabular-nums py-2">
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                            {num}
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${teamColor}`}>{item.team}</span>
                        </TableCell>
                        <TableCell className="text-[10px] text-zinc-500 py-2">
                          <div className="flex items-center gap-1">
                            <span className="uppercase">{item.source}</span>
                            {item.isGhost && <span className="px-1 py-0.5 rounded border text-[9px] font-medium uppercase text-zinc-400 border-zinc-600 bg-zinc-800">ghost</span>}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-zinc-500 tabular-nums py-2 whitespace-nowrap">
                          {new Date(item.missedAt).toLocaleString("en-US", {
                            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                            hour12: true, timeZone: "America/Los_Angeles",
                          })}
                        </TableCell>
                        <TableCell className="text-xs py-2">
                          {!item.hasCallback
                            ? <span className="text-zinc-600">No callback</span>
                            : item.callbackConnected
                            ? <span className="metric-good">Talked</span>
                            : <span className="metric-warn">Called, no answer</span>}
                        </TableCell>
                        <TableCell className="text-[10px] text-zinc-600 tabular-nums py-2">
                          {item.responseMinutes !== null ? `${item.responseMinutes}m` : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Violations Panel ─────────────────────────────────────────────────────────

type LateLoginRow = {
  key: string; member: string; department: string; date: string;
  shiftStart: string; firstCallAt: string; minutesLate: number;
};
type GapEntry = { start: string; end: string; minutes: number; source?: "quo" | "pbx" | "combined" };
type AvailGapRow = {
  key: string; member: string; department: string; date: string;
  gapCount: number; gaps: GapEntry[];
};
type MissedCallEntry = {
  key: string; pbxCallId: number | null; source: "pbx" | "quo"; date: string; missedAt: string;
  team: string; fromNumber: string; ringGroupName: string;
  availableAgents: string[]; busyAgents: string[];
};
type VerifiedItem = {
  id: number; key: string; type: string; member: string; department: string;
  date: string; details: string; verifiedBy: string; verifiedAt: string;
};
type ViolationsData = {
  lateLogin: LateLoginRow[]; availabilityGaps: AvailGapRow[];
  missedWhileAvail: MissedCallEntry[]; verifiedKeys: string[];
};

function deptBadge(dept: string): string {
  const d = dept.toLowerCase();
  if (d === "retention") return "bg-muted-foreground/15 metric-info border-border";
  if (d === "cs") return "bg-muted-foreground/15 metric-good border-border";
  if (d === "nsf") return "bg-muted/50 metric-info border-border";
  return "bg-zinc-700/40 text-zinc-300 border-zinc-600/30";
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Los_Angeles",
  });
}
function fmtDate(d: string): string {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
}
function fmtMins(m: number): string {
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
// LA-local hour-of-day (0–23) for an ISO timestamp.
function laHourOf(iso: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Los_Angeles" }).format(new Date(iso)),
    10,
  );
}
// "Jun 2, 9:14 AM" in LA time.
function fmtDateTimeLA(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  });
}
function fmtHourLabel(h: number): string {
  if (h === 0 || h === 24) return "12 AM";
  if (h === 12) return "12 PM";
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention QA Panel (AI-scored call reviews)
// ─────────────────────────────────────────────────────────────────────────────
interface QAStats {
  reviewed: number; avgScore: number; avgProtocol: number; avgSoftSkills: number;
  failed: number; criticalFails: number; pendingReviews: number; avgVariance: number;
  taxMentions: number;
  byDept: Record<string, { reviewed: number; avgScore: number; criticalFails: number; failed: number; taxMentions: number }>;
}
interface QAReview {
  id: string; agentName: string; phoneNumber: string | null; callDate: string;
  department: string;
  score: number; softSkillsScore: number; protocolScore: number;
  pass: boolean; criticalFail: boolean; managerReviewRequired: boolean;
  strengths: string[]; missedItems: string[]; criticalIssues: string[]; reason: string | null;
  categoryScores: Record<string, number>; aiSummary: string | null; transcript: string | null;
}
interface QATask {
  id: string; agentName: string; department: string;
  aiScore: number; score: number; reason: string;
  criticalFail: boolean; source: string; status: string; createdAt: string;
  managerScore: number | null; variance: number | null; finalScore: number | null;
  comments: string | null; coachingComplete: boolean;
  resolvedBy: string | null; resolvedAt: string | null; notes: string | null;
}
type QADept = "all" | "Retention" | "CS" | "NSF";

// ─────────────────────────────────────────────────────────────────────────────
// Inbound Live Transfers (partner warm-transfers + internal team transfers)
// ─────────────────────────────────────────────────────────────────────────────
type LTGran = "all" | "month" | "day";
interface LTStatus {
  running: boolean;
  lastRunAt: string | null;
  progressDone: number;
  progressTotal: number;
  totalIncoming: number;
  totalLive: number;
  partnerTotal: number;
  aspire: number;
  resync: number;
  clarity: number;
  concordia: number;
  unspecified: number;
  internalTotal: number;
  internalByDept: { dept: string; count: number }[];
}

function ltLaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function ltLastDayOfMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y!, m!, 0).getDate();
  return `${ym}-${String(d).padStart(2, "0")}`;
}

function LiveTransfersCard() {
  const { token } = useUser();
  const today = ltLaToday();
  const [downloading, setDownloading] = useState(false);

  // Filter is locked to today.
  const from = today;
  const to = today;
  const qs = `?from=${from}&to=${to}`;

  const { data: status, refetch } = useQuery<LTStatus>({
    queryKey: ["liveTransfersStatus", from, to, token],
    queryFn: async () => {
      const res = await fetch(`/api/live-transfers/status${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<LTStatus>;
    },
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
    refetchOnWindowFocus: false,
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/live-transfers/refresh`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
      return res.json().catch(() => ({}));
    },
    onSuccess: () => setTimeout(() => refetch(), 800),
  });

  const download = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/api/live-transfers/download${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const tag = today;
      const a = document.createElement("a");
      a.href = url;
      a.download = `Live_Transfers_${tag}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const running = status?.running ?? refreshMutation.isPending;
  const lastRun = status?.lastRunAt
    ? new Date(status.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;
  const progressPct =
    running && status && status.progressTotal > 0
      ? Math.round((status.progressDone / status.progressTotal) * 100)
      : 0;
  const rangeLabel = new Date(`${today}T00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

  return (
    <div className="rounded-xl border border-border bg-card backdrop-blur p-5 space-y-4">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 metric-info" />
            Inbound Live Transfers
          </h2>
          <div className="flex items-center gap-2 text-sm text-zinc-400 flex-wrap">
            <span>Partner (Aspire · Resync · Clarity · Concordia) + internal team transfers · {rangeLabel}</span>
            <span className="flex items-center gap-1 metric-info/80">
              <Sparkles className="h-3 w-3" />
              AI-classified from call transcripts
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted-foreground/10 px-3 py-1.5 text-xs font-medium metric-info">
            <CalendarDays className="h-3.5 w-3.5" />Today
          </span>
          <Button size="sm" variant="outline" onClick={() => refreshMutation.mutate()} disabled={running}>
            {running
              ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Refreshing…</>
              : <><RefreshCw className="h-4 w-4 mr-1" />Refresh</>}
          </Button>
          <Button size="sm" onClick={download} disabled={downloading || !status || status.totalLive === 0}>
            {downloading
              ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Preparing…</>
              : <><Download className="h-4 w-4 mr-1" />Download Excel</>}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border bg-gradient-to-br p-3.5 from-card to-muted/50 border-border metric-info">
          <div className="flex items-center gap-1.5 text-xs opacity-80"><ArrowLeftRight className="h-3.5 w-3.5" />Total Live Transfers</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.totalLive ?? 0).toLocaleString()}</div>
          <div className="text-xs opacity-70 mt-0.5">of {(status?.totalIncoming ?? 0).toLocaleString()} inbound considered</div>
        </div>
        <div className="rounded-xl border bg-gradient-to-br p-3.5 from-teal-500/15 to-teal-500/5 border-teal-500/30 text-teal-200">
          <div className="flex items-center gap-1.5 text-xs opacity-80"><PhoneIncoming className="h-3.5 w-3.5" />Partner Transfers</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.partnerTotal ?? 0).toLocaleString()}</div>
        </div>
        <div className="rounded-xl border bg-gradient-to-br p-3.5 from-card to-muted/50 border-border metric-info">
          <div className="flex items-center gap-1.5 text-xs opacity-80"><ArrowLeftRight className="h-3.5 w-3.5" />Internal Transfers</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.internalTotal ?? 0).toLocaleString()}</div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Partner companies</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="rounded-xl border bg-gradient-to-br p-3.5 from-card to-muted/50 border-border metric-info">
            <div className="flex items-center gap-1.5 text-xs opacity-80"><PhoneIncoming className="h-3.5 w-3.5" />Aspire</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.aspire ?? 0).toLocaleString()}</div>
          </div>
          <div className="rounded-xl border bg-gradient-to-br p-3.5 from-card to-muted/50 border-border metric-good">
            <div className="flex items-center gap-1.5 text-xs opacity-80"><PhoneIncoming className="h-3.5 w-3.5" />Resync</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.resync ?? 0).toLocaleString()}</div>
          </div>
          <div className="rounded-xl border bg-gradient-to-br p-3.5 from-card to-muted/50 border-border metric-warn">
            <div className="flex items-center gap-1.5 text-xs opacity-80"><PhoneIncoming className="h-3.5 w-3.5" />Clarity</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.clarity ?? 0).toLocaleString()}</div>
          </div>
          <div className="rounded-xl border bg-gradient-to-br p-3.5 from-card to-muted/50 border-border metric-secondary">
            <div className="flex items-center gap-1.5 text-xs opacity-80"><PhoneIncoming className="h-3.5 w-3.5" />Concordia</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.concordia ?? 0).toLocaleString()}</div>
          </div>
          <div className="rounded-xl border bg-gradient-to-br p-3.5 from-zinc-500/15 to-zinc-500/5 border-zinc-500/30 text-zinc-300">
            <div className="flex items-center gap-1.5 text-xs opacity-80"><Info className="h-3.5 w-3.5" />Unspecified</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{(status?.unspecified ?? 0).toLocaleString()}</div>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Internal departments (transferred by)</div>
        {status && status.internalByDept.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {status.internalByDept.map((d) => (
              <div key={d.dept} className="rounded-xl border bg-gradient-to-br p-3.5 from-card to-muted/50 border-border metric-info">
                <div className="flex items-center gap-1.5 text-xs opacity-80"><ArrowLeftRight className="h-3.5 w-3.5" />{d.dept}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{d.count.toLocaleString()}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-zinc-500 italic">No internal transfers found in this range.</div>
        )}
      </div>

      {running && status && status.progressTotal > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>Classifying new transcripts…</span>
            <span className="tabular-nums">{status.progressDone}/{status.progressTotal} ({progressPct}%)</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-muted-foreground transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}
      {lastRun && !running && (
        <div className="text-xs metric-good flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Last classified {lastRun}
        </div>
      )}
    </div>
  );
}

function QAPanel() {
  const { token, user } = useUser();
  const qaRoster = useRoster();
  const qc = useQueryClient();
  const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  // QA filter is locked to today.
  const from = todayLA;
  const to = todayLA;
  const [sub, setSub] = useState<"reviews" | "tasks">("reviews");
  const [dept, setDept] = useState<QADept>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [reviewingTask, setReviewingTask] = useState<QATask | null>(null);

  const range = useMemo(() => {
    const fromISO = new Date(`${from}T00:00:00-07:00`).toISOString();
    const toISO   = new Date(`${to}T23:59:59-07:00`).toISOString();
    return { fromISO, toISO };
  }, [from, to]);

  const deptParam = dept === "all" ? "" : `&department=${dept}`;

  const stats = useQuery<QAStats>({
    queryKey: ["qa-stats", range.fromISO, range.toISO, dept, token],
    queryFn: async () => {
      const r = await fetch(`/api/qa/stats?from=${range.fromISO}&to=${range.toISO}${deptParam}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<QAStats>;
    },
    refetchInterval: 60_000,
  });

  const reviews = useQuery<{ reviews: QAReview[] }>({
    queryKey: ["qa-reviews", range.fromISO, range.toISO, dept, token],
    queryFn: async () => {
      const r = await fetch(`/api/qa/reviews?from=${range.fromISO}&to=${range.toISO}&limit=200${deptParam}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<{ reviews: QAReview[] }>;
    },
    refetchInterval: 60_000,
    enabled: sub === "reviews",
  });

  const tasks = useQuery<{ tasks: QATask[] }>({
    queryKey: ["qa-tasks", dept, token],
    queryFn: async () => {
      const r = await fetch(`/api/qa/tasks?status=open&limit=200${deptParam}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<{ tasks: QATask[] }>;
    },
    refetchInterval: 60_000,
    enabled: sub === "tasks",
  });

  const runProcessor = useCallback(async () => {
    setProcessing(true);
    try {
      await fetch("/api/qa/process", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ batchSize: 10 }),
      });
      await Promise.all([stats.refetch(), reviews.refetch(), tasks.refetch()]);
    } finally { setProcessing(false); }
  }, [token, stats, reviews, tasks]);

  const resolveTask = useCallback(async (
    id: string,
    body: { managerScore?: number | null; comments?: string; coachingComplete?: boolean } = {},
  ) => {
    await fetch(`/api/qa/tasks/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ resolvedBy: user.username, ...body }),
    });
    void qc.invalidateQueries({ queryKey: ["qa-tasks"] });
    void qc.invalidateQueries({ queryKey: ["qa-stats"] });
  }, [token, user.username, qc]);

  const [downloadingQa, setDownloadingQa] = useState(false);
  const downloadQa = useCallback(async () => {
    setDownloadingQa(true);
    try {
      const res = await fetch(`/api/qa/download?from=${range.fromISO}&to=${range.toISO}${deptParam}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `QA_Reviews_${dept === "all" ? "AllDepts" : dept}_${from}_to_${to}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } finally {
      setDownloadingQa(false);
    }
  }, [token, range.fromISO, range.toISO, deptParam, dept, from, to]);

  const reviewRows = reviews.data?.reviews ?? [];
  const taskRows = tasks.data?.tasks ?? [];

  return (
    <div className="space-y-4">
      {/* Inbound Live Transfers (Aspire / Resync) */}
      <LiveTransfersCard />

      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/70 px-3 h-8 text-xs font-medium text-zinc-300">
          <CalendarDays className="h-3.5 w-3.5 text-zinc-400" />Today
        </span>
        <div className="flex items-center gap-1 ml-2">
          {(["all", "Retention", "CS", "NSF"] as QADept[]).map((d) => (
            <button
              key={d}
              onClick={() => setDept(d)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${dept === d ? "bg-primary text-primary-foreground" : "bg-zinc-900/60 text-zinc-400 hover:text-white"}`}
            >
              {d === "all" ? "All depts" : d}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={downloadQa} disabled={downloadingQa || !stats.data || stats.data.reviewed === 0} size="sm" variant="outline">
            {downloadingQa
              ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Preparing…</>
              : <><Download className="h-3.5 w-3.5 mr-1.5" />Export Excel</>}
          </Button>
          <Button onClick={runProcessor} disabled={processing} size="sm" className="bg-primary hover:bg-primary/90">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${processing ? "animate-spin" : ""}`} />
            {processing ? "Evaluating…" : "Run QA now"}
          </Button>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <QATile label="Reviewed" value={stats.data?.reviewed ?? 0} />
        <QATile label="Avg score" value={`${stats.data?.avgScore ?? 0}/100`} accent={stats.data && stats.data.avgScore >= 80 ? "good" : "warn"} />
        <QATile label="Protocol %" value={`${stats.data?.avgProtocol ?? 0}`} accent={stats.data && stats.data.avgProtocol >= 70 ? "good" : "bad"} />
        <QATile label="Soft skills" value={`${stats.data?.avgSoftSkills ?? 0}`} accent={stats.data && stats.data.avgSoftSkills >= 70 ? "good" : "warn"} />
        <QATile label="Failed" value={stats.data?.failed ?? 0} accent={stats.data && stats.data.failed > 0 ? "bad" : undefined} />
        <QATile label="Critical fails" value={stats.data?.criticalFails ?? 0} accent={stats.data && stats.data.criticalFails > 0 ? "bad" : undefined} />
        <QATile label="Manager queue" value={stats.data?.pendingReviews ?? 0} accent={stats.data && stats.data.pendingReviews > 0 ? "warn" : undefined} />
        <QATile label="Mention Tax" value={stats.data?.taxMentions ?? 0} accent={stats.data && stats.data.taxMentions > 0 ? "warn" : undefined} />
      </div>

      {/* Per-department breakdown */}
      {stats.data?.byDept && Object.keys(stats.data.byDept).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(["Retention", "CS", "NSF"] as const).map((d) => {
            const b = stats.data!.byDept[d] ?? { reviewed: 0, avgScore: 0, criticalFails: 0, failed: 0, taxMentions: 0 };
            return (
              <Card key={d} className="bg-zinc-950/40 border-zinc-800/60">
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">{d}</div>
                    <div className="text-lg font-semibold text-zinc-100">{b.reviewed} reviewed · avg {b.avgScore}</div>
                    <div className="text-xs metric-warn/90 flex items-center gap-1 mt-0.5">
                      <Receipt className="h-3 w-3" />{b.taxMentions} mention tax
                    </div>
                  </div>
                  <div className="text-right text-xs">
                    <div className={b.criticalFails > 0 ? "metric-bad" : "text-zinc-500"}>{b.criticalFails} crit</div>
                    <div className={b.failed > 0 ? "metric-warn" : "text-zinc-500"}>{b.failed} fail</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Tabs value={sub} onValueChange={(v) => setSub(v as "reviews" | "tasks")}>
        <TabsList className="bg-zinc-900/60">
          <TabsTrigger value="reviews">All reviews</TabsTrigger>
          <TabsTrigger value="tasks">Manager queue</TabsTrigger>
        </TabsList>

        <TabsContent value="reviews" className="pt-3">
          <Card className="bg-zinc-950/40 border-zinc-800/60">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="text-zinc-400">Agent Name</TableHead>
                    <TableHead className="text-zinc-400">Dept</TableHead>
                    <TableHead className="text-zinc-400">When</TableHead>
                    <TableHead className="text-zinc-400">Customer</TableHead>
                    <TableHead className="text-zinc-400 text-right">Score</TableHead>
                    <TableHead className="text-zinc-400 text-right">Proto</TableHead>
                    <TableHead className="text-zinc-400">Status</TableHead>
                    <TableHead className="text-zinc-400">Review</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviews.isLoading ? (
                    <TableRow><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : reviewRows.length === 0 ? (
                    <TableRow><TableCell colSpan={8} className="text-center text-zinc-500 py-8">No QA reviews in this date range yet. Click "Run QA now" to evaluate recent calls.</TableCell></TableRow>
                  ) : reviewRows.map((r) => {
                    const isOpen = expanded === r.id;
                    const deptColor = r.department === "Retention" ? "border-border metric-info"
                      : r.department === "CS" ? "border-border metric-info"
                      : "border-border metric-warn";
                    const parts = agentNameParts(r.agentName, qaRoster);
                    return (
                      <Fragment key={r.id}>
                        <TableRow className="border-zinc-800/60 hover:bg-zinc-900/40 cursor-pointer" onClick={() => setExpanded(isOpen ? null : r.id)}>
                        <TableCell className="font-medium">
                          <AvatarName name={parts.agentName} size="sm" textClassName="text-foreground" />
                        </TableCell>
                          <TableCell><Badge variant="outline" className={`${deptColor} text-[10px]`}>{r.department}</Badge></TableCell>
                          <TableCell className="text-xs text-zinc-400">{new Date(r.callDate).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</TableCell>
                          <TableCell className="text-xs text-zinc-400 font-mono">{r.phoneNumber ?? "—"}</TableCell>
                          <TableCell className="text-right">
                            <span className={`font-semibold ${r.score >= 80 ? "metric-good" : r.score >= 60 ? "metric-warn" : "metric-bad"}`}>{r.score}</span>
                            <span className="text-xs text-zinc-500">/100</span>
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            <span className={r.protocolScore >= 70 ? "metric-good" : "metric-bad"}>{r.protocolScore}</span>
                          </TableCell>
                          <TableCell>
                            {r.criticalFail
                              ? <Badge className="bg-muted metric-bad border-border">Critical fail</Badge>
                              : r.pass
                                ? <Badge className="bg-muted metric-good border-border">Pass</Badge>
                                : <Badge className="bg-muted metric-warn border-border">Fail</Badge>}
                          </TableCell>
                          <TableCell>
                            {r.managerReviewRequired
                              ? <Badge variant="outline" className="border-border metric-info">Manager</Badge>
                              : <span className="text-xs text-zinc-500">—</span>}
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="border-zinc-800/60 bg-zinc-950/60">
                            <TableCell colSpan={8} className="p-4">
                              <div className="grid md:grid-cols-2 gap-4 text-sm">
                                <div>
                                  <div className="text-xs font-medium text-zinc-400 mb-1">Strengths</div>
                                  {r.strengths.length ? (
                                    <ul className="list-disc list-inside metric-good space-y-0.5">{r.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                                  ) : <div className="text-zinc-500 italic">None noted</div>}
                                </div>
                                <div>
                                  <div className="text-xs font-medium text-zinc-400 mb-1">Missed</div>
                                  {r.missedItems.length ? (
                                    <ul className="list-disc list-inside metric-bad space-y-0.5">{r.missedItems.map((s, i) => <li key={i}>{s}</li>)}</ul>
                                  ) : <div className="text-zinc-500 italic">Nothing flagged</div>}
                                </div>
                              </div>
                              {r.criticalIssues && r.criticalIssues.length > 0 && (
                                <div className="mt-3">
                                  <div className="text-xs font-medium metric-bad mb-1">Critical issues</div>
                                  <ul className="list-disc list-inside metric-bad space-y-0.5 text-sm">{r.criticalIssues.map((s, i) => <li key={i}>{s}</li>)}</ul>
                                </div>
                              )}
                              {r.reason && <div className="text-sm mt-3 text-zinc-300"><span className="text-zinc-500">Summary: </span>{r.reason}</div>}
                              {Object.keys(r.categoryScores).length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-3">
                                  {Object.entries(r.categoryScores).map(([k, v]) => (
                                    <Badge key={k} variant="outline" className="border-zinc-700 text-zinc-300 text-[10px]">{k}: {v}</Badge>
                                  ))}
                                </div>
                              )}
                              {r.aiSummary && <div className="text-xs mt-3 text-zinc-500"><span className="font-medium text-zinc-400">OpenPhone summary: </span>{r.aiSummary}</div>}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tasks" className="pt-3">
          <Card className="bg-zinc-950/40 border-zinc-800/60">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="text-zinc-400">Agent Name</TableHead>
                    <TableHead className="text-zinc-400">Dept</TableHead>
                    <TableHead className="text-zinc-400 text-right">AI</TableHead>
                    <TableHead className="text-zinc-400">Source</TableHead>
                    <TableHead className="text-zinc-400">Reason</TableHead>
                    <TableHead className="text-zinc-400">Created</TableHead>
                    <TableHead className="text-zinc-400 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.isLoading ? (
                    <TableRow><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ) : taskRows.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="text-center text-zinc-500 py-8">No open manager reviews. Nice.</TableCell></TableRow>
                  ) : taskRows.map((t) => {
                    const deptColor = t.department === "Retention" ? "border-border metric-info"
                      : t.department === "CS" ? "border-border metric-info"
                      : "border-border metric-warn";
                    const srcLabel = t.source === "weekly_lowest" ? "Weekly · lowest"
                      : t.source === "weekly_random" ? "Weekly · random"
                      : t.source === "manual" ? "Manual"
                      : "Auto flag";
                    const parts = agentNameParts(t.agentName, qaRoster);
                    return (
                      <TableRow key={t.id} className="border-zinc-800/60">
                        <TableCell className="font-medium">
                          <AvatarName name={parts.agentName} size="sm" textClassName="text-foreground" />
                        </TableCell>
                        <TableCell><Badge variant="outline" className={`${deptColor} text-[10px]`}>{t.department}</Badge></TableCell>
                        <TableCell className="text-right">
                          <span className={`font-semibold ${t.criticalFail ? "metric-bad" : t.aiScore < 60 ? "metric-bad" : "metric-warn"}`}>{t.aiScore}</span>
                        </TableCell>
                        <TableCell className="text-[11px] text-zinc-400">{srcLabel}</TableCell>
                        <TableCell className="text-sm text-zinc-300 max-w-md">
                          {t.criticalFail && <Badge className="bg-muted metric-bad border-border mr-2">Critical</Badge>}
                          {t.reason}
                        </TableCell>
                        <TableCell className="text-xs text-zinc-400">{new Date(t.createdAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</TableCell>
                        <TableCell className="text-right space-x-1">
                          <Button size="sm" variant="outline" className="border-border metric-info h-7" onClick={() => setReviewingTask(t)}>Review</Button>
                          <Button size="sm" variant="ghost" className="text-zinc-400 h-7 px-2" onClick={() => resolveTask(t.id)}>Skip</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {reviewingTask && (
        <ManagerReviewDialog
          task={reviewingTask}
          token={token}
          onClose={() => setReviewingTask(null)}
          onSubmit={async (body) => {
            await resolveTask(reviewingTask.id, body);
            setReviewingTask(null);
          }}
        />
      )}
    </div>
  );
}

function ManagerReviewDialog({
  task, token, onClose, onSubmit,
}: {
  task: QATask; token: string; onClose: () => void;
  onSubmit: (body: { managerScore: number | null; comments: string; coachingComplete: boolean }) => Promise<void>;
}) {
  const [managerScore, setManagerScore] = useState<string>(String(task.aiScore));
  const [comments, setComments] = useState("");
  const [coachingComplete, setCoachingComplete] = useState(false);
  const [saving, setSaving] = useState(false);
  const review = useQuery<QAReview>({
    queryKey: ["qa-review-detail", task.id, token],
    queryFn: async () => {
      const r = await fetch(`/api/qa/reviews/${task.id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<QAReview>;
    },
  });

  const ms = managerScore === "" ? null : Math.max(0, Math.min(100, Number(managerScore) || 0));
  const variance = ms !== null ? ms - task.aiScore : null;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl bg-zinc-950 border-zinc-800 text-zinc-100 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manager review · {task.agentName} · {task.department}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md bg-zinc-900/60 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">AI score</div>
              <div className="text-2xl font-semibold text-zinc-100">{task.aiScore}<span className="text-xs text-zinc-500">/100</span></div>
            </div>
            <div className="rounded-md bg-zinc-900/60 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Your score</div>
              <Input
                type="number" min={0} max={100}
                value={managerScore}
                onChange={(e) => setManagerScore(e.target.value)}
                className="h-8 mt-1 bg-zinc-950 border-zinc-800"
              />
            </div>
            <div className="rounded-md bg-zinc-900/60 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Variance</div>
              <div className={`text-2xl font-semibold ${variance === null ? "text-zinc-500" : variance === 0 ? "text-zinc-300" : variance > 0 ? "metric-good" : "metric-bad"}`}>
                {variance === null ? "—" : (variance > 0 ? `+${variance}` : variance)}
              </div>
            </div>
          </div>

          {review.data && (
            <div className="rounded-md border border-zinc-800 p-3 space-y-2">
              <div className="text-xs text-zinc-400">AI assessment</div>
              {review.data.reason && <div className="text-zinc-200">{review.data.reason}</div>}
              {review.data.criticalIssues && review.data.criticalIssues.length > 0 && (
                <div>
                  <div className="text-[11px] metric-bad font-medium">Critical issues</div>
                  <ul className="list-disc list-inside metric-bad text-xs space-y-0.5">{review.data.criticalIssues.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
              )}
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] metric-good font-medium">Strengths</div>
                  <ul className="list-disc list-inside metric-good text-xs space-y-0.5">{review.data.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
                <div>
                  <div className="text-[11px] metric-warn font-medium">Missed</div>
                  <ul className="list-disc list-inside metric-warn text-xs space-y-0.5">{review.data.missedItems.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
              </div>
              {review.data.transcript && (
                <details className="text-xs">
                  <summary className="text-zinc-400 cursor-pointer">Show transcript</summary>
                  <pre className="whitespace-pre-wrap text-zinc-400 mt-2 max-h-64 overflow-y-auto">{review.data.transcript}</pre>
                </details>
              )}
            </div>
          )}

          <div>
            <Label className="text-xs text-zinc-400">Manager comments</Label>
            <textarea
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              rows={3}
              placeholder="What did the agent do well or poorly? Coaching notes for the agent…"
              className="w-full mt-1 rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-ring/50"
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" checked={coachingComplete} onChange={(e) => setCoachingComplete(e.target.checked)} className="h-4 w-4" />
            Coaching delivered to agent
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-zinc-700">Cancel</Button>
          <Button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try { await onSubmit({ managerScore: ms, comments, coachingComplete }); }
              finally { setSaving(false); }
            }}
            className="bg-primary hover:bg-primary/90"
          >{saving ? "Saving…" : "Submit review"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QATile({ label, value, accent }: { label: string; value: number | string; accent?: "good" | "warn" | "bad" }) {
  const color = accent === "good" ? "metric-good" : accent === "warn" ? "metric-warn" : accent === "bad" ? "metric-bad" : "text-zinc-100";
  return (
    <Card className="bg-zinc-950/40 border-zinc-800/60">
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
        <div className={`text-xl font-semibold mt-0.5 ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function ViolationsPanel() {
  const { token, user } = useUser();
  const todayLA = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const sevenAgo = new Date(Date.now() - 6 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const [from, setFrom] = useState(todayLA);
  const [to, setTo]     = useState(todayLA);
  const [sub, setSub]   = useState<"late" | "gaps" | "missed" | "cancels" | "verified">("missed");
  const [deptFilter, setDeptFilter] = useState<string>("all");
  const [sortLate, setSortLate]     = useState<"date" | "mins">("date");
  const [sortGaps, setSortGaps]     = useState<"date" | "count">("count");
  const [gapHourFrom, setGapHourFrom] = useState(0);
  const [gapHourTo, setGapHourTo]     = useState(24);
  const [sortMissed, setSortMissed] = useState<"date" | "avail">("date");
  const [localVerified, setLocalVerified] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [localDismissed, setLocalDismissed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("dismissed_violations") ?? "[]") as string[]); }
    catch { return new Set<string>(); }
  });
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery<ViolationsData>({
    queryKey: ["violations", from, to, token],
    queryFn: async () => {
      const r = await fetch(`/api/violations?from=${from}&to=${to}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<ViolationsData>;
    },
    staleTime: 2 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const { data: verifiedData, refetch: refetchVerified } = useQuery<{ items: VerifiedItem[] }>({
    queryKey: ["violations-verified", token],
    queryFn: async () => {
      const r = await fetch("/api/violations/verified", { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await r.text());
      return r.json() as Promise<{ items: VerifiedItem[] }>;
    },
    staleTime: 30 * 1000,
  });

  const violationsRoster = useRoster();
  const { data: cancelData, isLoading: cancelLoading } = useQuery<CancelViolation[]>({
    queryKey: ["cancel-violations", violationsRoster.version],
    queryFn: () => fetchCancelViolations(violationsRoster),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (data?.verifiedKeys) setLocalVerified(new Set(data.verifiedKeys));
  }, [data?.verifiedKeys]);

  const toggleVerify = useCallback(async (
    key: string, type: string, member: string, department: string, date: string, details: object,
  ) => {
    const isNowVerified = !localVerified.has(key);
    setLocalVerified(prev => { const s = new Set(prev); isNowVerified ? s.add(key) : s.delete(key); return s; });
    setPending(prev => new Set(prev).add(key));
    try {
      if (isNowVerified) {
        await fetch("/api/violations/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ key, type, member, department, date, details: JSON.stringify(details), verifiedBy: user.username }),
        });
      } else {
        await fetch("/api/violations/verify", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ key }),
        });
      }
      void refetchVerified();
    } catch { /* optimistic — keep local state */ }
    finally { setPending(prev => { const s = new Set(prev); s.delete(key); return s; }); }
  }, [localVerified, token, user.username, refetchVerified]);

  const dismissViolation = useCallback((key: string) => {
    setLocalDismissed(prev => {
      const s = new Set(prev);
      s.add(key);
      try { localStorage.setItem("dismissed_violations", JSON.stringify(Array.from(s))); } catch { /* ignore */ }
      return s;
    });
  }, []);

  const depts = useMemo(() => {
    const s = new Set<string>();
    for (const r of data?.lateLogin ?? []) s.add(r.department.toUpperCase());
    for (const r of data?.availabilityGaps ?? []) s.add(r.department.toUpperCase());
    for (const r of data?.missedWhileAvail ?? []) s.add(r.team.toUpperCase());
    for (const r of cancelData ?? []) s.add(r.team.toUpperCase());
    return ["all", ...Array.from(s).sort()];
  }, [data, cancelData]);

  const cancelRows = useMemo(() => {
    return (cancelData ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.team.toUpperCase() === deptFilter)
    );
  }, [cancelData, deptFilter, localDismissed]);

  const lateRows = useMemo(() => {
    let rows = (data?.lateLogin ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.department.toUpperCase() === deptFilter)
    );
    if (sortLate === "mins") rows = [...rows].sort((a, b) => b.minutesLate - a.minutesLate);
    else rows = [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.minutesLate - a.minutesLate);
    return rows;
  }, [data, deptFilter, sortLate, localDismissed]);

  const gapRows = useMemo(() => {
    let rows = (data?.availabilityGaps ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.department.toUpperCase() === deptFilter)
    );
    const longest = (r: AvailGapRow) => Math.max(...r.gaps.map(g => g.minutes));
    if (sortGaps === "count") rows = [...rows].sort((a, b) => b.gapCount - a.gapCount || longest(b) - longest(a));
    else rows = [...rows].sort((a, b) => b.date.localeCompare(a.date) || b.gapCount - a.gapCount);
    return rows;
  }, [data, deptFilter, sortGaps, localDismissed]);

  // Whole-day window (0→24) means "no filter".
  const gapHourActive = !(gapHourFrom === 0 && gapHourTo === 24);
  const inGapHourWindow = (iso: string) => {
    if (!gapHourActive) return true;
    const h = laHourOf(iso);
    return gapHourFrom <= gapHourTo
      ? h >= gapHourFrom && h < gapHourTo
      : h >= gapHourFrom || h < gapHourTo; // wrap-around (e.g. 10 PM → 4 AM)
  };
  // Rows with gaps filtered to the selected hour-of-day window; empty rows dropped.
  const displayGapRows = useMemo(() => {
    if (!gapHourActive) return gapRows;
    const filtered = gapRows
      .map(r => ({ ...r, gaps: r.gaps.filter(g => inGapHourWindow(g.start)) }))
      .filter(r => r.gaps.length > 0)
      .map(r => ({ ...r, gapCount: r.gaps.length }));
    // Re-sort using the recomputed (filtered) gapCount so "By Count" stays accurate.
    const longest = (r: AvailGapRow) => Math.max(...r.gaps.map(g => g.minutes));
    if (sortGaps === "count") filtered.sort((a, b) => b.gapCount - a.gapCount || longest(b) - longest(a));
    else filtered.sort((a, b) => b.date.localeCompare(a.date) || b.gapCount - a.gapCount);
    return filtered;
  }, [gapRows, gapHourActive, gapHourFrom, gapHourTo, sortGaps]);

  const exportGapsCsv = () => {
    const rows: Record<string, string | number>[] = [];
    for (const r of displayGapRows) {
      for (const g of r.gaps) {
        rows.push({
          Date: r.date,
          Agent: r.member,
          Dept: r.department,
          "Gap Start (LA)": fmtDateTimeLA(g.start),
          "Gap End (LA)": fmtDateTimeLA(g.end),
          "Duration (min)": g.minutes,
        });
      }
    }
    const csv = Papa.unparse(rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const win = gapHourActive ? `_${fmtHourLabel(gapHourFrom)}-${fmtHourLabel(gapHourTo)}`.replace(/\s/g, "") : "";
    a.download = `availability_gaps${win}_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const missedRows = useMemo(() => {
    let rows = (data?.missedWhileAvail ?? []).filter(r =>
      !localDismissed.has(r.key) &&
      (deptFilter === "all" || r.team.toUpperCase() === deptFilter)
    );
    if (sortMissed === "avail") rows = [...rows].sort((a, b) => b.availableAgents.length - a.availableAgents.length);
    else rows = [...rows].sort((a, b) => b.missedAt.localeCompare(a.missedAt));
    return rows;
  }, [data, deptFilter, sortMissed, localDismissed]);

  const lateMinsColor = (m: number) =>
    m > 60 ? "metric-bad font-bold" : m > 30 ? "metric-warn font-semibold" : "metric-warn";

  const verifiedCount = localVerified.size;
  const availabilityViolationCount = displayGapRows.reduce((s, r) => s + r.gapCount, 0);

  function ViolationMetricCard({
    icon,
    label,
    value,
    tone,
  }: {
    icon: React.ReactNode;
    label: string;
    value: number;
    tone: "amber" | "rose" | "emerald" | "sky";
  }) {
    const toneClass = {
      amber: "border-amber-400/25 bg-amber-950/40 text-amber-100",
      rose: "border-rose-400/25 bg-rose-950/45 text-rose-100",
      emerald: "border-emerald-400/25 bg-emerald-950/40 text-emerald-100",
      sky: "border-sky-400/25 bg-sky-950/40 text-sky-100",
    }[tone];
    const accentClass = {
      amber: "bg-amber-400/90",
      rose: "bg-rose-400/90",
      emerald: "bg-emerald-400/90",
      sky: "bg-sky-400/90",
    }[tone];
    return (
      <div className={`ops-card min-h-[92px] min-w-[170px] flex-1 rounded-lg border px-4 py-3 ${toneClass}`}>
        <div className={`absolute left-0 right-0 top-0 h-[3px] ${accentClass}`} />
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/20">
            {icon}
          </span>
        <div>
            <p className="text-xs font-semibold text-[#b4aea4]">{label}</p>
            <p className="font-mono text-2xl font-medium text-white">{value}</p>
          </div>
        </div>
      </div>
    );
  }

  const handleSend = useCallback(() => {
    const items = verifiedData?.items ?? [];
    if (items.length === 0) return;
    const lines: string[] = [
      `VIOLATION REPORT — ${from} to ${to}`,
      `Generated by Backend Tracker | ${new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric" })}`,
      "",
    ];
    const lateItems   = items.filter(i => i.type === "late_login");
    const gapItems    = items.filter(i => i.type === "availability_gap");
    const missItems   = items.filter(i => i.type === "missed_call");
    const cancelItems = items.filter(i => i.type === "unauthorized_cancel");
    if (lateItems.length > 0) {
      lines.push(`LATE LOGIN (${lateItems.length})`);
      lines.push("─".repeat(30));
      for (const it of lateItems) {
        try {
          const d = JSON.parse(it.details) as LateLoginRow;
          lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}: ${fmtMins(d.minutesLate)} late (shift ${fmtTime(d.shiftStart)}, first call ${fmtTime(d.firstCallAt)})`);
        } catch { lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    if (gapItems.length > 0) {
      lines.push(`AVAILABILITY GAPS (${gapItems.length})`);
      lines.push("─".repeat(30));
      for (const it of gapItems) {
        try {
          const d = JSON.parse(it.details) as AvailGapRow;
          const longest = Math.max(...d.gaps.map(g => g.minutes));
          lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}: ${d.gapCount} gaps, longest ${fmtMins(longest)}`);
        } catch { lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    if (missItems.length > 0) {
      lines.push(`MISSED CALLS (${missItems.length})`);
      lines.push("─".repeat(30));
      for (const it of missItems) {
        try {
          const d = JSON.parse(it.details) as MissedCallEntry;
          lines.push(`• ${fmtDate(it.date)} ${fmtTime(d.missedAt)} — ${d.ringGroupName}: ${d.fromNumber} | Available: ${d.availableAgents.join(", ")}`);
        } catch { lines.push(`• ${it.member} — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    if (cancelItems.length > 0) {
      lines.push(`UNAUTHORIZED CANCELLATIONS (${cancelItems.length})`);
      lines.push("─".repeat(30));
      for (const it of cancelItems) {
        try {
          const d = JSON.parse(it.details) as CancelViolation;
          const fid = d.fileId ? ` [${d.fileId}]` : "";
          lines.push(`• ${d.agent} (${d.team}) — ${fmtDate(d.date)}${fid}: ${d.rawStatus}`);
        } catch { lines.push(`• ${it.member} (${it.department}) — ${fmtDate(it.date)}`); }
      }
      lines.push("");
    }
    void navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }, [verifiedData, from, to]);

  const SUB_TABS = [
    { id: "late"     as const, label: "Late Login",    count: lateRows.length },
    { id: "gaps"     as const, label: "Availability",  count: availabilityViolationCount },
    { id: "missed"   as const, label: "Missed Calls",  count: missedRows.length },
    { id: "cancels"  as const, label: "Cancels",       count: cancelRows.length, urgent: cancelRows.length > 0 },
    { id: "verified" as const, label: "Verified",      count: verifiedCount, accent: true },
  ];

  const Checkbox = ({ vkey, type, member, department, date, details }: {
    vkey: string; type: string; member: string; department: string; date: string; details: object;
  }) => {
    const checked = localVerified.has(vkey);
    const busy    = pending.has(vkey);
    return (
      <button
        onClick={() => void toggleVerify(vkey, type, member, department, date, details)}
        disabled={busy}
        className={`flex-shrink-0 h-4 w-4 rounded border transition-all ${busy ? "opacity-40 cursor-wait" : "cursor-pointer"} ${
          checked ? "bg-muted-foreground border-border" : "bg-transparent border-zinc-600 hover:border-zinc-400"
        }`}
        title={checked ? "Unmark verified" : "Mark as verified"}
      >
        {checked && <svg viewBox="0 0 10 8" className="w-full h-full p-0.5 text-white fill-none stroke-current stroke-2"><polyline points="1,4 4,7 9,1"/></svg>}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Calendar className="h-4 w-4" />
          <span>From</span>
          <AnimatedDatePicker
            value={from}
            max={to}
            onChange={setFrom}
            className="w-36 bg-zinc-900/60 border-white/10 text-white"
            ariaLabel="Violations from date"
            title="From date"
          />
          <span>to</span>
          <AnimatedDatePicker
            value={to}
            min={from}
            max={todayLA}
            onChange={setTo}
            className="w-36 bg-zinc-900/60 border-white/10 text-white"
            ariaLabel="Violations to date"
            title="To date"
          />
        </div>
        <button onClick={() => void refetch()}
          className="ml-auto p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-700/60 transition-colors">
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Summary cards */}
      {data && (
        <div className="flex flex-wrap gap-3">
          <ViolationMetricCard icon={<Clock className="h-4 w-4 text-amber-200" />} label="Late Logins" value={lateRows.length} tone="amber" />
          <ViolationMetricCard icon={<ShieldAlert className="h-4 w-4 text-rose-200" />} label="Availability Violations" value={availabilityViolationCount} tone="rose" />
          <ViolationMetricCard icon={<PhoneMissed className="h-4 w-4 text-amber-200" />} label="Missed While Available" value={missedRows.length} tone="amber" />
          <ViolationMetricCard icon={<ShieldAlert className="h-4 w-4 text-rose-200" />} label="Unauthorized Cancels" value={cancelRows.length} tone="rose" />
          <ViolationMetricCard icon={<UserCheck className="h-4 w-4 text-emerald-200" />} label="Verified" value={verifiedCount} tone="emerald" />
        </div>
      )}

      {/* Sub-tab + dept filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="ops-panel flex overflow-hidden rounded-lg p-1">
          {SUB_TABS.map(t => (
            <button key={t.id} onClick={() => setSub(t.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                sub === t.id
                  ? t.accent ? "bg-emerald-400 text-emerald-950" : t.urgent ? "bg-rose-400 text-rose-950" : "bg-primary text-primary-foreground"
                  : "text-zinc-400 hover:bg-white/[0.04] hover:text-white"
              }`}>
              {t.label}
              {t.count !== undefined && (
                <span className={`rounded-full px-1.5 py-0 text-[10px] font-bold ${
                  sub === t.id ? "bg-white/20 text-white"
                  : t.urgent && (t.count ?? 0) > 0 ? "bg-red-500 text-white"
                  : "bg-zinc-700 text-zinc-300"
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
        {sub !== "verified" && (
          <div className="ops-panel flex overflow-hidden rounded-lg p-1 text-xs">
            {depts.map((d) => (
              <button key={d} onClick={() => setDeptFilter(d)}
                className={`rounded-md px-3 py-1.5 capitalize transition-colors ${deptFilter === d ? "bg-cyan-400 text-cyan-950" : "text-zinc-400 hover:bg-white/[0.04] hover:text-white"}`}>
                {d}
              </button>
            ))}
          </div>
        )}
      </div>

      {isLoading && <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
      {isError  && <div className="rounded-xl border border-border bg-muted/50 p-4 metric-bad text-sm">Failed to load violations.</div>}

      {/* ── Late Login ─────────────────────────────────────────────────── */}
      {!isLoading && !isError && sub === "late" && (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-white/8 flex items-center justify-between">
            <p className="text-xs font-semibold metric-warn flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />Late Login — first call {">"} 10 min after shift start
            </p>
            <div className="flex gap-1">
              {(["date","mins"] as const).map(s => (
                <button key={s} onClick={() => setSortLate(s)}
                  className={`text-[10px] px-2 py-0.5 rounded ${sortLate === s ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {s === "date" ? "By Date" : "By Delay"}
                </button>
              ))}
            </div>
          </div>
          {lateRows.length === 0
            ? <div className="py-10 text-center text-sm text-zinc-500">No late login violations for this range.</div>
            : <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="w-8" />
                    <TableHead className="text-xs w-28">Date</TableHead>
                    <TableHead className="text-xs">Agent Name</TableHead>
                    <TableHead className="text-xs">Dept</TableHead>
                    <TableHead className="text-xs">Shift Start</TableHead>
                    <TableHead className="text-xs">First Call</TableHead>
                    <TableHead className="text-xs text-right">Late By</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lateRows.map((r, i) => {
                    const parts = agentNameParts(r.member, violationsRoster);
                    return (
                    <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "hover:bg-zinc-800/20"}`}>
                      <TableCell className="pl-3 pr-1">
                        <Checkbox vkey={r.key} type="late_login" member={r.member} department={r.department} date={r.date} details={r} />
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(r.date)}</TableCell>
                      <TableCell className={`text-xs font-medium ${localVerified.has(r.key) ? "metric-good line-through decoration-emerald-600/50" : "text-white"}`}>
                        <AvatarName name={parts.agentName} size="xs" textClassName={localVerified.has(r.key) ? "metric-good line-through decoration-emerald-600/50" : "text-white"} />
                      </TableCell>
                      <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(r.department)}`}>{r.department}</Badge></TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtTime(r.shiftStart)}</TableCell>
                      <TableCell className="text-xs text-zinc-300 tabular-nums">{fmtTime(r.firstCallAt)}</TableCell>
                      <TableCell className={`text-xs tabular-nums text-right ${lateMinsColor(r.minutesLate)}`}>{fmtMins(r.minutesLate)}</TableCell>
                      <TableCell className="pr-3">
                        <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                        </button>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
          }
        </div>
      )}

      {/* ── Availability Gaps ──────────────────────────────────────────── */}
      {!isLoading && !isError && sub === "gaps" && (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-white/8 flex items-center justify-between">
            <p className="text-xs font-semibold metric-bad flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />Availability — gaps {">"} 5 min between consecutive calls
            </p>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 text-[10px] text-zinc-400">
                <span>Hours</span>
                <AnimatedValueSelect
                  value={String(gapHourFrom)}
                  onChange={(value) => setGapHourFrom(Number(value))}
                  ariaLabel="Choose start hour"
                  triggerClassName="h-6 min-w-[76px] rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200"
                  menuClassName="w-28"
                  options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: fmtHourLabel(h), emoji: "🕒" }))}
                />
                <span>→</span>
                <AnimatedValueSelect
                  value={String(gapHourTo)}
                  onChange={(value) => setGapHourTo(Number(value))}
                  ariaLabel="Choose end hour"
                  triggerClassName="h-6 min-w-[76px] rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200"
                  menuClassName="w-28"
                  options={Array.from({ length: 24 }, (_, h) => h + 1).map((h) => ({ value: String(h), label: fmtHourLabel(h), emoji: "🕒" }))}
                />
                {gapHourActive && (
                  <button
                    onClick={() => { setGapHourFrom(0); setGapHourTo(24); }}
                    className="text-zinc-500 hover:text-zinc-300 underline"
                  >
                    clear
                  </button>
                )}
              </div>
              <div className="flex gap-1">
                {(["count","date"] as const).map(s => (
                  <button key={s} onClick={() => setSortGaps(s)}
                    className={`text-[10px] px-2 py-0.5 rounded ${sortGaps === s ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                    {s === "count" ? "By Count" : "By Date"}
                  </button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={displayGapRows.length === 0}
                onClick={exportGapsCsv}
                data-testid="button-export-availability-gaps"
              >
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Export CSV
              </Button>
            </div>
          </div>
          {displayGapRows.length === 0
            ? <div className="py-10 text-center text-sm text-zinc-500">{gapHourActive ? "No gaps in the selected hours." : "No availability violations for this range."}</div>
            : <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="w-8" />
                    <TableHead className="text-xs w-28">Date</TableHead>
                    <TableHead className="text-xs">Agent Name</TableHead>
                    <TableHead className="text-xs">Dept</TableHead>
                    <TableHead className="text-xs text-center">Gaps</TableHead>
                    <TableHead className="text-xs">Gap Durations (LA time)</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayGapRows.map((r, i) => {
                    const parts = agentNameParts(r.member, violationsRoster);
                    return (
                    <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "hover:bg-zinc-800/20"}`}>
                      <TableCell className="pl-3 pr-1">
                        <Checkbox vkey={r.key} type="availability_gap" member={r.member} department={r.department} date={r.date} details={r} />
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(r.date)}</TableCell>
                      <TableCell className={`text-xs font-medium ${localVerified.has(r.key) ? "metric-good line-through decoration-emerald-600/50" : "text-white"}`}>
                        <AvatarName name={parts.agentName} size="xs" textClassName={localVerified.has(r.key) ? "metric-good line-through decoration-emerald-600/50" : "text-white"} />
                      </TableCell>
                      <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(r.department)}`}>{r.department}</Badge></TableCell>
                      <TableCell className="text-xs text-center">
                        <span className={`font-bold ${r.gapCount >= 5 ? "metric-bad" : r.gapCount >= 3 ? "metric-warn" : "metric-warn"}`}>{r.gapCount}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.gaps.map((g, j) => (
                            <Tooltip key={j}>
                              <TooltipTrigger asChild>
                                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium cursor-default
                                  ${g.minutes > 30 ? "bg-muted metric-bad" : g.minutes > 15 ? "bg-muted metric-warn" : "bg-muted metric-warn"}`}>
                                  {fmtMins(g.minutes)}{g.source ? ` · ${g.source === "combined" ? "QUO+PBX" : g.source.toUpperCase()}` : ""}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">{fmtTime(g.start)} → {fmtTime(g.end)}</TooltipContent>
                            </Tooltip>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="pr-3">
                        <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                        </button>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
          }
        </div>
      )}

      {/* ── Missed While Available ─────────────────────────────────────── */}
      {!isLoading && !isError && sub === "missed" && (
        <div className="rounded-xl border border-white/8 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-white/8 flex items-center justify-between">
            <p className="text-xs font-semibold metric-warn flex items-center gap-1.5">
              <PhoneMissed className="h-3.5 w-3.5" />Missed calls — agent was on shift and not on another call
            </p>
            <div className="flex gap-1">
              {(["date","avail"] as const).map(s => (
                <button key={s} onClick={() => setSortMissed(s)}
                  className={`text-[10px] px-2 py-0.5 rounded ${sortMissed === s ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                  {s === "date" ? "By Date" : "By Available"}
                </button>
              ))}
            </div>
          </div>
          {missedRows.length === 0
            ? <div className="py-10 text-center text-sm text-zinc-500">No missed-while-available violations for this range.</div>
            : <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="w-8" />
                    <TableHead className="text-xs w-32">Date / Time</TableHead>
                    <TableHead className="text-xs">Ring Group</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">Caller</TableHead>
                    <TableHead className="text-xs">Available (on shift)</TableHead>
                    <TableHead className="text-xs text-zinc-600">Busy</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {missedRows.map((r, i) => (
                    <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "hover:bg-zinc-800/20"}`}>
                      <TableCell className="pl-3 pr-1">
                        <Checkbox vkey={r.key} type="missed_call" member={r.availableAgents[0] ?? ""} department={r.team} date={r.date} details={r} />
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums whitespace-nowrap">
                        <div>{fmtDate(r.date)}</div>
                        <div className="text-[10px] text-zinc-500">{fmtTime(r.missedAt)}</div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="text-zinc-200 font-medium">{r.ringGroupName}</div>
                        <Badge className={`text-[10px] px-1.5 py-0 mt-0.5 border ${deptBadge(r.team.charAt(0).toUpperCase() + r.team.slice(1))}`}>
                          {r.team}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.source === "quo"
                          ? <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted-foreground/15 metric-info border border-border">OpenPhone</span>
                          : <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted/50 metric-info border border-border">PBX</span>
                        }
                      </TableCell>
                      <TableCell className="text-xs text-zinc-400 tabular-nums font-mono">
                        {r.fromNumber.replace(/(\+1)(\d{3})(\d{3})(\d{4})/, "$1 ($2) $3-$4")}
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.availableAgents.map((a, j) => (
                            <span key={j} className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted/60 metric-warn border border-border">
                              {a}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1">
                          {r.busyAgents.map((a, j) => (
                            <span key={j} className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] text-zinc-600 bg-zinc-800/40">
                              {a}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="pr-3">
                        <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
          }
        </div>
      )}

      {/* ── Unauthorized Cancels ───────────────────────────────────────── */}
      {sub === "cancels" && (
        <div className="rounded-xl border border-red-500/30 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-red-500/20 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5" />Unauthorized cancellations — CS/NSF agents are not allowed to cancel files
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={cancelLoading || cancelRows.length === 0}
              onClick={() => {
                const rows = cancelRows.map((r) => ({
                  Date: r.date,
                  Agent: r.agent,
                  Team: r.team,
                  "File ID": r.fileId,
                  Status: r.rawStatus,
                }));
                const csv = Papa.unparse(rows);
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `unauthorized_cancels_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              data-testid="button-export-unauthorized-cancels"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export CSV
            </Button>
          </div>
          {cancelLoading
            ? <div className="py-10 text-center text-sm text-zinc-500">Scanning sheets…</div>
            : cancelRows.length === 0
              ? <div className="py-10 text-center text-sm text-zinc-500">No unauthorized cancellations found.</div>
              : <Table>
                  <TableHeader>
                    <TableRow className="border-white/8 bg-zinc-900/40">
                      <TableHead className="w-8" />
                      <TableHead className="text-xs w-28">Date</TableHead>
                      <TableHead className="text-xs">Agent Name</TableHead>
                      <TableHead className="text-xs">Team</TableHead>
                      <TableHead className="text-xs">File ID</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cancelRows.map((r, i) => {
                      const parts = agentNameParts(r.agent, violationsRoster);
                      return (
                      <TableRow key={i} className={`border-white/5 transition-colors group ${localVerified.has(r.key) ? "bg-emerald-950/20" : "bg-red-950/10 hover:bg-red-950/20"}`}>
                        <TableCell className="pl-3 pr-1">
                          <Checkbox vkey={r.key} type="unauthorized_cancel" member={r.agent} department={r.team} date={r.date} details={r} />
                        </TableCell>
                        <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(r.date)}</TableCell>
                        <TableCell className={`text-xs font-medium ${localVerified.has(r.key) ? "metric-good line-through decoration-emerald-600/50" : "text-red-200"}`}>
                          <AvatarName name={parts.agentName} size="xs" textClassName={localVerified.has(r.key) ? "metric-good line-through decoration-emerald-600/50" : "text-red-200"} />
                        </TableCell>
                        <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(r.team)}`}>{r.team}</Badge></TableCell>
                        <TableCell className="text-xs font-mono text-zinc-300">{r.fileId || <span className="text-zinc-600">—</span>}</TableCell>
                        <TableCell className="text-xs text-red-400 font-medium">{r.rawStatus}</TableCell>
                        <TableCell className="pr-3">
                          <button onClick={() => dismissViolation(r.key)} title="Dismiss" className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors">
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>
                          </button>
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
          }
        </div>
      )}

      {/* ── Verified Tab ───────────────────────────────────────────────── */}
      {sub === "verified" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-400">
              {verifiedData?.items.length ?? 0} verified violation{verifiedData?.items.length !== 1 ? "s" : ""} ready to send
            </p>
            <button
              onClick={handleSend}
              disabled={!verifiedData?.items.length}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all
                ${verifiedData?.items.length
                  ? copied ? "bg-primary text-primary-foreground" : "bg-primary hover:bg-primary/90 text-primary-foreground"
                  : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                }`}
            >
              {copied ? <><UserCheck className="h-4 w-4" />Copied!</> : <><Send className="h-4 w-4" />Copy Report</>}
            </button>
          </div>
          {!verifiedData?.items.length ? (
            <div className="rounded-xl border border-white/8 bg-zinc-900/40 py-12 text-center">
              <UserCheck className="h-8 w-8 mx-auto text-zinc-600 mb-2" />
              <p className="text-sm text-zinc-500">No verified violations yet.</p>
              <p className="text-xs text-zinc-600 mt-1">Check the box next to any violation to verify it.</p>
            </div>
          ) : (
            <div className="rounded-xl border border-white/8 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/8 bg-zinc-900/40">
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-xs">Agent Name / Info</TableHead>
                    <TableHead className="text-xs">Dept</TableHead>
                    <TableHead className="text-xs w-28">Date</TableHead>
                    <TableHead className="text-xs text-right">Verified By</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {verifiedData.items.map((it, i) => {
                    let detail = "";
                    try {
                      const d = JSON.parse(it.details);
                      if (it.type === "late_login")          detail = `${fmtMins((d as LateLoginRow).minutesLate)} late`;
                      if (it.type === "availability_gap")    detail = `${(d as AvailGapRow).gapCount} gaps`;
                      if (it.type === "missed_call")         detail = `${(d as MissedCallEntry).availableAgents.length} available`;
                      if (it.type === "unauthorized_cancel") { const cd = d as CancelViolation; detail = cd.fileId ? `File ${cd.fileId}` : ""; }
                    } catch { /* ignore */ }
                    const typeBadge =
                      it.type === "late_login"          ? "bg-muted/60 metric-warn border-border" :
                      it.type === "availability_gap"    ? "bg-muted/60 metric-bad border-border" :
                      it.type === "unauthorized_cancel" ? "bg-red-500/15 text-red-300 border-red-500/30" :
                                                          "bg-muted/60 metric-warn border-border";
                    const typeLabel =
                      it.type === "late_login"          ? "Late Login" :
                      it.type === "availability_gap"    ? "Avail Gap" :
                      it.type === "unauthorized_cancel" ? "Cancel" : "Missed Call";
                    const parts = agentNameParts(it.member, violationsRoster);
                    return (
                      <TableRow key={i} className="border-white/5 hover:bg-zinc-800/20 group">
                        <TableCell className="text-xs">
                          <Badge className={`text-[10px] px-1.5 py-0 border ${typeBadge}`}>{typeLabel}</Badge>
                          {detail && <span className="ml-1.5 text-zinc-500 text-[10px]">{detail}</span>}
                        </TableCell>
                        <TableCell className="text-xs font-medium text-white">
                          <AvatarName name={parts.agentName} size="xs" textClassName="text-white" />
                        </TableCell>
                        <TableCell className="text-xs"><Badge className={`text-[10px] px-1.5 py-0 border ${deptBadge(it.department)}`}>{it.department}</Badge></TableCell>
                        <TableCell className="text-xs text-zinc-400 tabular-nums">{fmtDate(it.date)}</TableCell>
                        <TableCell className="text-xs text-right text-zinc-500">{it.verifiedBy}</TableCell>
                        <TableCell className="pr-3">
                          <button
                            onClick={() => void toggleVerify(it.key, it.type, it.member, it.department, it.date, {})}
                            disabled={pending.has(it.key)}
                            title="Remove flag"
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 disabled:cursor-wait"
                          >
                            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current"><path d="M6.5 1h3a.5.5 0 0 1 .5.5v1H6v-1a.5.5 0 0 1 .5-.5M11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3A1.5 1.5 0 0 0 5 1.5v1H1.5a.5.5 0 0 0 0 1h.538l.853 10.66A2 2 0 0 0 4.885 16h6.23a2 2 0 0 0 1.994-1.84l.853-10.66h.538a.5.5 0 0 0 0-1zm1.958 1-.846 10.58a1 1 0 0 1-.997.92h-6.23a1 1 0 0 1-.997-.92L3.042 3.5zm-7.487 1a.5.5 0 0 1 .528.47l.5 8.5a.5.5 0 0 1-1 .06L5 5.03a.5.5 0 0 1 .47-.53Zm5.058 0a.5.5 0 0 1 .47.53l-.5 8.5a.5.5 0 1 1-1-.06l.5-8.5a.5.5 0 0 1 .53-.47M8 4.5a.5.5 0 0 1 .5.5v8.5a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5"/></svg>
                          </button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Backend Statistics ──────────────────────────────────────────────────────
// A single, filter-free overview of EVERY file submitted across all three teams
// (Retention, NSF, Internal CS). Anyone who submits any file shows up here.

const BSTAT_STATUS_COLORS: Record<string, string> = {
  Retained: "#34d399",
  Fixed: "#38bdf8",
  "IDP-Handled": "#fbbf24",
  Cancelled: "#fb7185",
};
const BSTAT_TEAM_META: Record<RosterTeam, { label: string; color: string }> = {
  retention: { label: "Retention", color: "#a78bfa" },
  nsf: { label: "NSF", color: "#f0abfc" },
  cs: { label: "Internal CS", color: "#38bdf8" },
  killers: { label: "ReadyMode Killers", color: "#2dd4bf" },
};
const bstatChartTooltip = {
  contentStyle: {
    background: "rgba(24,24,27,0.95)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 10,
    fontSize: 12,
    color: "#e4e4e7",
    boxShadow: "0 10px 40px -10px rgba(0,0,0,0.6)",
  },
  labelStyle: { color: "#a1a1aa" },
  itemStyle: { color: "#e4e4e7" },
} as const;

type BStatRow = { agent: string; agentKey: string; team: RosterTeam; status: string; date: string; fileId: string; source: string; idpCancel: boolean };

// Resolve a raw submission name to a single canonical agent identity. Mirrors
// aggregate()'s roster-aware resolution but ALSO applies NAME_ALIASES, so Arabic
// and compound Discord-bot names collapse onto one agent (e.g. "Ahmed Ayman" +
// "Ahmed Ayman-Levi Miller" → Levi Miller; "Kevin Michael" + "Kevin Micheal").
function bstatResolveAgent(raw: string, roster: RosterIndex, fallbackTeam: TeamMode): { key: string; display: string; team: RosterTeam } {
  const aliased = normalizeAgent(raw); // NAME_ALIASES[norm] ?? norm
  const hit = resolveSheetAgent(raw, roster) ?? resolveSheetAgent(aliased, roster);
  // ReadyMode Killers are a first-class team here: an agent counts as a Killer
  // when the roster assigns them the "killers" team OR their name is in the fixed
  // Killer roster (isKillerAgentKey). Otherwise fall back to the loader's team.
  if (hit) {
    const key = normalizeAgent(hit.name);
    debugSheetAgentResolution("backend-stats", raw, sheetAgentCandidates(raw), hit, "backend-stats-roster-resolved", {
      agentColumn: "Agent Name",
      counted: true,
    });
    return { key, display: hit.name, team: hit.team === "killers" || isKillerAgentKey(key) ? "killers" : hit.team };
  }
  if (!raw.trim()) return { key: "unknown", display: "Unknown", team: fallbackTeam };
  const key = aliased;
  if (!key) return { key: "unknown", display: "Unknown", team: fallbackTeam };
  debugUnresolvedSheetAgent("backend-stats", raw);
  if (!isKillerAgentKey(key)) return { key: "unknown", display: "Unknown", team: fallbackTeam };
  const display = NAME_DISPLAY[key] ?? key.replace(/\b\w/g, (c) => c.toUpperCase());
  return { key, display, team: isKillerAgentKey(key) ? "killers" : fallbackTeam };
}

function bstatRetentionStatus(update: string, context: string): "Retained" | "Cancelled" | null {
  const value = update.trim().toLowerCase();
  if (!value) return null;
  const hasRetain = /\bretain(?:ed)?\b/.test(value);
  const hasCancel = /\bcancel(?:l?ed|ling)?\b/.test(value);
  if (hasRetain && hasCancel) {
    console.warn(`[backend-stats] ${context}: ambiguous retain/cancel value; row was kept but not double-counted.`);
    return null;
  }
  if (hasRetain) return "Retained";
  if (hasCancel) return "Cancelled";
  return null;
}

async function fetchBackendStatsSubmissions(roster: RosterIndex): Promise<BStatRow[]> {
  const [retainedCancels, fixes] = await Promise.all([
    fetchHeaderCsv(NEW_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
    fetchHeaderCsv(NEW_NSF_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] })),
  ]);
  const idpHandled = await fetchHeaderCsv(IDP_RETENTION_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));
  const idpCancelRetained = await fetchHeaderCsv(IDP_CANCEL_RETAINED_URL).catch(() => ({ headers: [] as string[], rows: [] as Row[] }));

  const out: BStatRow[] = [];
  const add = (rawAgent: string, status: string, date: string, fileId: string, source: string, fallbackTeam: TeamMode) => {
    const resolved = bstatResolveAgent(rawAgent, roster, fallbackTeam);
    out.push({
      agent: resolved.display,
      agentKey: resolved.key === "unknown" ? `${resolved.team}:unknown` : resolved.key,
      team: resolved.team,
      status,
      date,
      fileId,
      source,
      idpCancel: source === "idp-cancel-retained",
    });
  };

  const retTs = resolveSheetColumn(retainedCancels, "Retained & Cancels", "Timestamp", TIMESTAMP_HEADERS, 0);
  const retAgent = resolveSheetColumn(retainedCancels, "Retained & Cancels", "Agent Name", AGENT_HEADERS, 1);
  const retUpdate = resolveSheetColumn(retainedCancels, "Retained & Cancels", "Cancel request update", CANCEL_UPDATE_HEADERS, 5);
  const retFile = findColumnByHeader(retainedCancels.headers, FILE_ID_HEADERS);
  for (const r of retainedCancels.rows) {
    if (!isSubmittedRow(r)) continue;
    const d = parseEgyptTimestamp(cell(r, retTs)) ?? parseDate(cell(r, retTs));
    const date = d ? toCaliforniaDateStr(d) : cell(r, retTs);
    const status = bstatRetentionStatus(cell(r, retUpdate), "Retained & Cancels");
    if (!status) continue;
    add(cell(r, retAgent), status, date, cell(r, retFile), "Retained & Cancels", "retention");
  }

  const fixesTs = resolveSheetColumn(fixes, "Fixes", "Timestamp", TIMESTAMP_HEADERS, 0);
  const fixesAgent = resolveSheetColumn(fixes, "Fixes", "Agent Name", AGENT_HEADERS, 1);
  const fixesFile = findColumnByHeader(fixes.headers, FILE_ID_HEADERS);
  for (const r of fixes.rows) {
    if (!isSubmittedRow(r)) continue;
    const d = parseEgyptTimestamp(cell(r, fixesTs)) ?? parseDate(cell(r, fixesTs));
    add(cell(r, fixesAgent), "Fixed", d ? toCaliforniaDateStr(d) : cell(r, fixesTs), cell(r, fixesFile), "Fixes", "nsf");
  }

  const idpTs = resolveSheetColumn(idpHandled, "idp-handled", "Timestamp", TIMESTAMP_HEADERS, 0);
  const idpAgent = resolveSheetColumn(idpHandled, "idp-handled", "Agent Name", AGENT_HEADERS, 1);
  const idpFile = findColumnByHeader(idpHandled.headers, FILE_ID_HEADERS);
  for (const r of idpHandled.rows) {
    if (!isSubmittedRow(r)) continue;
    const d = parseEgyptTimestamp(cell(r, idpTs)) ?? parseDate(cell(r, idpTs));
    add(cell(r, idpAgent), "IDP-Handled", d ? toCaliforniaDateStr(d) : cell(r, idpTs), cell(r, idpFile), "idp-handled", "nsf");
  }

  const idpCancelTs = resolveSheetColumn(idpCancelRetained, "idp-cancel-retained", "Timestamp", TIMESTAMP_HEADERS, 0);
  const idpCancelAgent = resolveSheetColumn(idpCancelRetained, "idp-cancel-retained", "Agent Name", AGENT_HEADERS, 1);
  const idpCancelFile = findColumnByHeader(idpCancelRetained.headers, FILE_ID_HEADERS);
  for (const r of idpCancelRetained.rows) {
    if (!isSubmittedRow(r)) continue;
    const d = parseEgyptTimestamp(cell(r, idpCancelTs)) ?? parseDate(cell(r, idpCancelTs));
    add(cell(r, idpCancelAgent), "Retained", d ? toCaliforniaDateStr(d) : cell(r, idpCancelTs), cell(r, idpCancelFile), "idp-cancel-retained", "nsf");
  }

  return out;
}

async function fetchBackendStatsSheetForTeam(roster: RosterIndex, team: TeamMode): Promise<SheetData> {
  const rows = (await fetchBackendStatsSubmissions(roster))
    .filter((r) => r.team === team)
    .map((r) => ({
      Agent: r.agent,
      Status: r.status,
      Date: r.date,
      "File ID": r.fileId,
      Source: r.source,
      ...(r.idpCancel ? { __sourceTab: "IDP-Cancel-Retained" } : {}),
    }));
  return { headers: ["Agent", "Status", "Date", "File ID", "Source"], rows };
}

function fetchRetentionBackendStatsSheet(roster: RosterIndex): Promise<SheetData> {
  return fetchBackendStatsSheetForTeam(roster, "retention");
}

function fetchNSFBackendStatsSheet(roster: RosterIndex): Promise<SheetData> {
  return fetchBackendStatsSheetForTeam(roster, "nsf");
}

function fetchCSBackendStatsSheet(roster: RosterIndex): Promise<SheetData> {
  return fetchBackendStatsSheetForTeam(roster, "cs");
}

function bstatMonthLabel(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

function BStatKpi({ icon: Icon, label, value, accent }: { icon: typeof Activity; label: string; value: number; accent: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-white/5 bg-card/60 backdrop-blur-xl p-4">
      <div className={`pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full blur-2xl ${accent}`} />
      <div className="relative flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5 text-white/80">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{label}</p>
          <p className="text-xl font-bold tabular-nums text-white">{value.toLocaleString()}</p>
        </div>
      </div>
    </div>
  );
}

function BackendStatsPanel() {
  const roster = useRoster();
  const { data: rows, isLoading, isError, refetch, isFetching } = useQuery<BStatRow[]>({
    queryKey: ["backend-stats-all", roster.version],
    queryFn: () => fetchBackendStatsSubmissions(roster),
    staleTime: 60_000,
  });

  const today = todayPDT();
  const currentMonth = today.slice(0, 7);
  // Default to the current month on open. "all" = All time, "today" = just today.
  const [month, setMonth] = useState<string>(currentMonth);
  // When on, the leaderboard shows only the Ready-Mode Killers roster.
  const [killersOnly, setKillersOnly] = useState(false);
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) {
      const m = /^(\d{4}-\d{2})/.exec(r.date);
      if (m) set.add(m[1]!);
    }
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [rows]);
  // Always offer the current month as an option even before any rows land in it,
  // so the default selection has a matching <option>.
  const monthOptions = useMemo(() => {
    const set = new Set(months);
    set.add(currentMonth);
    return [...set].sort((a, b) => b.localeCompare(a));
  }, [months, currentMonth]);
  const filtered = useMemo(() => {
    const rs = rows ?? [];
    if (month === "all") return rs;
    if (month === "today") return rs.filter((r) => r.date === today);
    return rs.filter((r) => r.date.startsWith(month));
  }, [rows, month, today]);
  // If a selected past month disappears after a refresh, fall back to All time
  // instead of silently showing an empty view. The current month and "today"
  // are always valid selections and never reset (they can legitimately be empty).
  useEffect(() => {
    if (month !== "all" && month !== "today" && month !== currentMonth
        && months.length > 0 && !months.includes(month)) setMonth("all");
  }, [months, month, currentMonth]);

  const stats = useMemo(() => {
    const rs = filtered;
    const byDay = new Map<string, number>();
    const byStatus = new Map<string, number>();
    const byTeam = new Map<RosterTeam, number>();
    const byAgent = new Map<string, { agent: string; agentKey: string; team: RosterTeam; total: number; retained: number; idpCancelRetained: number; fixed: number; idp: number; cancelled: number }>();
    for (const r of rs) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.date)) byDay.set(r.date, (byDay.get(r.date) ?? 0) + 1);
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      byTeam.set(r.team, (byTeam.get(r.team) ?? 0) + 1);
      const a = byAgent.get(r.agentKey) ?? { agent: r.agent, agentKey: r.agentKey, team: r.team, total: 0, retained: 0, idpCancelRetained: 0, fixed: 0, idp: 0, cancelled: 0 };
      a.total++;
      if (r.status === "Retained") { if (r.idpCancel) a.idpCancelRetained++; else a.retained++; }
      else if (r.status === "Fixed") a.fixed++;
      else if (r.status === "IDP-Handled") a.idp++;
      else if (r.status === "Cancelled") a.cancelled++;
      byAgent.set(r.agentKey, a);
    }
    const dayData = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, label: date.slice(5), count }));
    const statusOrder = ["Retained", "Fixed", "IDP-Handled", "Cancelled"];
    const statusData = [...byStatus.entries()]
      .sort((a, b) => (statusOrder.indexOf(a[0]) + 1 || 99) - (statusOrder.indexOf(b[0]) + 1 || 99))
      .map(([name, value]) => ({ name, value, color: BSTAT_STATUS_COLORS[name] ?? "#a1a1aa" }));
    const teamData = (["retention", "nsf", "cs", "killers"] as RosterTeam[])
      .filter((t) => byTeam.get(t))
      .map((t) => ({ name: BSTAT_TEAM_META[t].label, value: byTeam.get(t) ?? 0, color: BSTAT_TEAM_META[t].color }));
    const agents = [...byAgent.values()].sort((a, b) => b.total - a.total);
    const topAgents = agents.slice(0, 12).map((a) => ({ name: a.agent, value: a.total, color: BSTAT_TEAM_META[a.team].color })).reverse();
    return {
      dayData,
      statusData,
      teamData,
      agents,
      topAgents,
      totalFiles: rs.length,
      contributors: agents.length,
      retained: byStatus.get("Retained") ?? 0,
      fixed: byStatus.get("Fixed") ?? 0,
      idp: byStatus.get("IDP-Handled") ?? 0,
      cancelled: byStatus.get("Cancelled") ?? 0,
    };
  }, [filtered]);

  const hasKillers = useMemo(() => stats.agents.some((a) => a.team === "killers"), [stats.agents]);
  const leaderboardAgents = useMemo(
    () => (killersOnly ? stats.agents.filter((a) => a.team === "killers") : stats.agents),
    [stats.agents, killersOnly],
  );

  function exportBackendRows() {
    const exportRows = filtered.map((r) => ({
      Agent: r.agent,
      Team: BSTAT_TEAM_META[r.team].label,
      Status: r.status,
      Source: r.source,
      Date: r.date,
      "File ID": r.fileId,
    }));
    const csv = Papa.unparse(exportRows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `backend_submissions_${new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[72px] rounded-xl" />)}
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <div className="grid lg:grid-cols-2 gap-4">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <Card className="border-white/5 bg-card/60 backdrop-blur-xl">
        <CardContent className="flex flex-col items-center gap-3 py-16 text-zinc-400">
          <ShieldAlert className="h-8 w-8 text-rose-400/70" />
          <p className="text-sm">Couldn't load file submissions.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {/* Title row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-[0_0_24px_-6px_rgba(37,99,235,0.7)]">
            <BarChart3 className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight bg-gradient-to-r from-blue-300 via-cyan-300 to-sky-300 bg-clip-text text-transparent">
              Backend Statistics
            </h2>
            <p className="text-xs text-muted-foreground">Every file submitted across all teams.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="appearance-none pl-9 pr-9 py-2 rounded-lg bg-zinc-800/80 border border-white/10 text-sm font-medium text-white cursor-pointer hover:bg-zinc-700/80 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50"
            >
              <option value="all">All time</option>
              <option value="today">Today</option>
              {monthOptions.map((m) => <option key={m} value={m}>{bstatMonthLabel(m)}</option>)}
            </select>
            <Calendar className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 text-xs">▾</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-2">
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportBackendRows} disabled={!filtered.length} className="gap-2">
            <Download className="h-3.5 w-3.5" />
            Export Rows
          </Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <BStatKpi icon={Layers} label="Total Files" value={stats.totalFiles} accent="bg-blue-500/30" />
        <BStatKpi icon={Users} label="Contributors" value={stats.contributors} accent="bg-cyan-500/30" />
        <BStatKpi icon={CheckCircle2} label="Retained" value={stats.retained} accent="bg-emerald-500/30" />
        <BStatKpi icon={Wrench} label="Fixed" value={stats.fixed} accent="bg-sky-500/30" />
        <BStatKpi icon={TrendingUp} label="IDP-Handled" value={stats.idp} accent="bg-amber-500/30" />
        <BStatKpi icon={XCircle} label="Cancelled" value={stats.cancelled} accent="bg-rose-500/30" />
      </div>

      {stats.totalFiles === 0 ? (
        <Card className="border-white/5 bg-card/60 backdrop-blur-xl">
          <CardContent className="flex flex-col items-center gap-2 py-16 text-zinc-500">
            <Layers className="h-8 w-8 opacity-30" />
            <p className="text-sm">No file submissions found yet.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Submissions over time */}
          <Card className="border-white/5 bg-card/60 backdrop-blur-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                <Activity className="h-4 w-4 text-blue-300" /> Files submitted over time
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={stats.dayData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <defs>
                    <linearGradient id="bstatArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="#a78bfa" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: "#71717a", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis tick={{ fill: "#71717a", fontSize: 11 }} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                  <RTooltip {...bstatChartTooltip} />
                  <Area type="monotone" dataKey="count" name="Files" stroke="#c4b5fd" strokeWidth={2} fill="url(#bstatArea)" />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Status + Team breakdowns */}
          <div className="grid lg:grid-cols-2 gap-4">
            <Card className="border-white/5 bg-card/60 backdrop-blur-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-zinc-200">By status</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={stats.statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2} stroke="none">
                      {stats.statusData.map((s) => <Cell key={s.name} fill={s.color} />)}
                    </Pie>
                    <RTooltip {...bstatChartTooltip} />
                    <RLegend wrapperStyle={{ fontSize: 12, color: "#a1a1aa" }} />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="border-white/5 bg-card/60 backdrop-blur-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-zinc-200">By team</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={stats.teamData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fill: "#a1a1aa", fontSize: 12 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: "#71717a", fontSize: 11 }} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
                    <RTooltip {...bstatChartTooltip} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Bar dataKey="value" name="Files" radius={[6, 6, 0, 0]} maxBarSize={90}>
                      {stats.teamData.map((t) => <Cell key={t.name} fill={t.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Top contributors */}
          <Card className="border-white/5 bg-card/60 backdrop-blur-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-zinc-200">Top contributors</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={Math.max(220, stats.topAgents.length * 30)}>
                <BarChart data={stats.topAgents} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                  <XAxis type="number" tick={{ fill: "#71717a", fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={{ fill: "#a1a1aa", fontSize: 11 }} tickLine={false} axisLine={false} width={130} />
                  <RTooltip {...bstatChartTooltip} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="value" name="Files" radius={[0, 6, 6, 0]} maxBarSize={20}>
                    {stats.topAgents.map((a) => <Cell key={a.name} fill={a.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Full leaderboard */}
          <Card className="border-white/5 bg-card/60 backdrop-blur-xl">
            <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-sm font-semibold text-zinc-200">All contributors ({leaderboardAgents.length})</CardTitle>
              {hasKillers && (
                <button
                  type="button"
                  onClick={() => setKillersOnly((v) => !v)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${killersOnly ? "border-rose-500/50 bg-rose-500/15 text-rose-200" : "border-white/10 text-zinc-400 hover:text-white hover:bg-white/5"}`}
                >
                  ⚔ Killers only
                </button>
              )}
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/5 hover:bg-transparent">
                      <TableHead className="w-10 text-zinc-400">#</TableHead>
                      <TableHead className="text-zinc-400">Agent</TableHead>
                      <TableHead className="text-zinc-400">Team</TableHead>
                      <TableHead className="text-right text-zinc-400">Total</TableHead>
                      <TableHead className="text-right text-zinc-400">IDP-Cancel-Retained</TableHead>
                      <TableHead className="text-right text-zinc-400">Retained</TableHead>
                      <TableHead className="text-right text-zinc-400">Total Retained</TableHead>
                      <TableHead className="text-right text-zinc-400">Fixed</TableHead>
                      <TableHead className="text-right text-zinc-400">IDP</TableHead>
                      <TableHead className="text-right text-zinc-400">Cancelled</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {leaderboardAgents.map((a, i) => (
                      <TableRow key={a.agent} className="border-white/5">
                        <TableCell className="text-zinc-500 tabular-nums">{i + 1}</TableCell>
                        <TableCell className="font-medium text-zinc-100">{a.agent}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5 text-xs text-zinc-300">
                            <span className="h-2 w-2 rounded-full" style={{ background: BSTAT_TEAM_META[a.team].color }} />
                            {BSTAT_TEAM_META[a.team].label}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-white">{a.total.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums text-teal-300/90">{a.idpCancelRetained || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-emerald-300/90">{a.retained || "—"}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-emerald-200">{(a.retained + a.idpCancelRetained) || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-sky-300/90">{a.fixed || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-amber-300/90">{a.idp || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums text-rose-300/90">{a.cancelled || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

type DashView = "metrics" | "attendance" | "phones" | "backend-stats";

function Dashboard() {
  const { user, token, logout, can, canSeeTab } = useUser();
  const qc = useQueryClient();
  const [showUsers, setShowUsers] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const rmFileRef = useRef<HTMLInputElement>(null);
  const [rmUploading, setRmUploading] = useState(false);
  const canUploadRm = user.role === "admin" || user.role === "edit";

  async function handleRmUpload(file: File) {
    // Daily reports label the day as a weekday ("Thursday"), not a calendar
    // date, so ask which day this report covers. Default to yesterday.
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yIso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    const date = window.prompt(
      "Which day does this report cover? (YYYY-MM-DD)",
      yIso,
    );
    if (date === null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      window.alert("Please enter the date as YYYY-MM-DD (e.g. 2026-05-28).");
      return;
    }
    setRmUploading(true);
    try {
      const csv = await file.text();
      const r = await fetch("/api/readymode/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ csv, filename: file.name, date: date.trim() }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean; rowsStored?: number; days?: number; error?: string;
      };
      if (!r.ok || !data.ok) {
        window.alert(`Upload failed: ${data.error ?? `HTTP ${r.status}`}`);
        return;
      }
      qc.invalidateQueries({ queryKey: ["readymodeStats"] });
      window.alert(`ReadyMode CSV uploaded: ${data.rowsStored ?? 0} rows across ${data.days ?? 0} day(s).`);
    } catch (e) {
      window.alert(`Upload failed: ${String(e)}`);
    } finally {
      setRmUploading(false);
    }
  }
  const defaultView: DashView = can("view_metrics") ? "metrics" : canSeeTab("backend-stats") ? "backend-stats" : "attendance";
  const [view, setView] = useState<DashView>(defaultView);

  const ta = user.teamAccess ?? null;
  // Backend Statistics is its own top-level view (header dropdown), not a metrics subtab.
  const metricsTabs = ALL_TABS.filter((t) => t.value !== "backend-stats" && canSeeTab(t.value));
  const defaultTab = ta ?? "retention";
  const [metricsTab, setMetricsTab] = useState(metricsTabs[0]?.value ?? defaultTab);
  const metricsTabValues = metricsTabs.map((t) => t.value).join("|");
  const viewOptions: AnimatedSelectOption<DashView>[] = [
    ...(can("view_metrics") ? [{
      value: "metrics" as const,
      label: "Metrics",
      description: "Retention, CS, NSF and QA views",
      icon: TrendingUp,
      emoji: "📈",
    }] : []),
    ...(canSeeTab("backend-stats") ? [{
      value: "backend-stats" as const,
      label: "Backend Stats",
      description: "Submission and backend health overview",
      icon: BarChart3,
      emoji: "📊",
    }] : []),
    ...(can("view_metrics") && user.role === "admin" ? [{
      value: "phones" as const,
      label: "Phones",
      description: "Live QUO line and phone data",
      icon: Phone,
      emoji: "📞",
    }] : []),
    ...(can("view_attendance") ? [{
      value: "attendance" as const,
      label: "Attendance",
      description: "Team shifts and attendance tracking",
      icon: CalendarDays,
      emoji: "🗓️",
    }] : []),
  ];

  useEffect(() => {
    if (view !== "metrics") return;
    if (!metricsTabs.some((t) => t.value === metricsTab)) {
      setMetricsTab(metricsTabs[0]?.value ?? defaultTab);
    }
  }, [view, metricsTab, metricsTabValues, defaultTab]);

  const roleBadgeCls =
    user.role === "admin" ? "bg-muted metric-info border-border" :
    user.role === "edit"  ? "bg-muted metric-warn border-border" :
                            "bg-zinc-500/20 text-zinc-300 border-zinc-500/30";
  const RoleIcon = user.role === "admin" ? ShieldCheck : user.role === "edit" ? Pencil : Eye;

  return (
    <div className="ops-shell min-h-screen bg-background relative overflow-x-hidden overflow-y-visible">
      {showUsers && <UserManagementPanel onClose={() => setShowUsers(false)} />}
      {showBlocked && <BlockedNumbersPanel onClose={() => setShowBlocked(false)} />}
      {showAgents && <AgentRosterPanel onClose={() => setShowAgents(false)} />}

      <div className="pointer-events-none absolute inset-0 -z-0">
        <div className="theme-ambient theme-ambient-primary absolute -top-32 -left-32 h-[500px] w-[500px]" />
        <div className="theme-ambient theme-ambient-secondary absolute top-20 right-0 h-[400px] w-[400px]" />
        <div className="theme-ambient theme-ambient-muted absolute bottom-0 left-1/3 h-[400px] w-[400px]" />
      </div>

      <header className="relative z-[100] overflow-visible border-b border-border bg-card/85 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-3 py-3 sm:px-6 sm:py-4 flex items-center gap-3">
          <div className="h-9 w-9 sm:h-10 sm:w-10 shrink-0 rounded-lg overflow-hidden ring-1 ring-emerald-300/20 shadow-[0_0_24px_-6px_rgba(52,211,153,0.45)]">
            <img src={companyLogo} alt="Company logo" className="h-full w-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base sm:text-xl font-bold tracking-tight text-foreground truncate">
              Backend Tracker
            </h1>
            <p className="text-xs text-muted-foreground hidden sm:block">Retention, NSF &amp; CS team metrics at a glance</p>
          </div>

          {/* View switcher — only show tabs user has access to */}
          {(can("view_metrics") || can("view_attendance") || canSeeTab("backend-stats")) && (
            <AnimatedDashboardSelect
              value={view}
              options={viewOptions}
              onChange={setView}
              label="Choose dashboard view"
              className="shrink-0"
            />
          )}

          {/* User info */}
          <div className="flex items-center gap-2 pl-2 border-l border-border">
            <ThemeToggle />
            <div className="text-right hidden sm:block">
              <div className="flex justify-end">
                <AvatarName name={user.username} size="xs" textClassName="text-xs font-medium text-foreground leading-tight" className="max-w-[140px]" />
              </div>
              <Badge className={`text-[10px] px-1.5 py-0 flex items-center gap-1 border w-fit ml-auto mt-0.5 ${roleBadgeCls}`}>
                <RoleIcon className="h-2.5 w-2.5" />{user.role}
              </Badge>
            </div>
            {canUploadRm && (
              <>
                <input
                  ref={rmFileRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleRmUpload(f);
                    e.target.value = "";
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => rmFileRef.current?.click()}
                      disabled={rmUploading}
                      className="p-2 rounded-lg text-zinc-400 hover:metric-secondary hover:bg-muted/50 transition-colors disabled:opacity-50"
                    >
                      <Upload className={`h-4 w-4 ${rmUploading ? "animate-pulse" : ""}`} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{rmUploading ? "Uploading…" : "Upload ReadyMode CSV"}</TooltipContent>
                </Tooltip>
              </>
            )}
            <div className="relative z-50 -my-3">
              <AnimatedActionMenu>
                {user.role === "admin" && (
                  <AnimatedMenuItem
                    label="Blocked numbers"
                    icon={<ShieldCheck />}
                    emoji="🚫"
                    onClick={() => setShowBlocked(true)}
                    tone="danger"
                  />
                )}
                {user.role === "admin" && (
                  <AnimatedMenuItem
                    label="Manage agents"
                    icon={<Users />}
                    emoji="👥"
                    onClick={() => setShowAgents(true)}
                  />
                )}
                {user.role === "admin" && (
                  <AnimatedMenuItem
                    label="Manage users"
                    icon={<UserCog />}
                    emoji="⚙️"
                    onClick={() => setShowUsers(true)}
                  />
                )}
                <AnimatedMenuItem
                  label="Sign out"
                  icon={<LogOut />}
                  emoji="👋"
                  onClick={logout}
                  tone="danger"
                />
              </AnimatedActionMenu>
            </div>
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-[1400px] mx-auto px-3 py-4 sm:px-6 sm:py-8">
        {view === "phones" && user.role === "admin" ? (
          <PhonesPanel />
        ) : view === "backend-stats" && canSeeTab("backend-stats") ? (
          <BackendStatsPanel />
        ) : view === "metrics" && can("view_metrics") ? (
          <Tabs value={metricsTab} onValueChange={setMetricsTab} className="space-y-6">
            <AnimatedMetricsNav tabs={metricsTabs} value={metricsTab} onChange={setMetricsTab} />
            {canSeeTab("retention") && (
              <TabsContent value="retention">
                <RetentionPanel />
              </TabsContent>
            )}
            {canSeeTab("cs") && (
              <TabsContent value="cs">
                <CSPanel />
              </TabsContent>
            )}
            {canSeeTab("nsf") && (
              <TabsContent value="nsf">
                <TeamPanel urls={NSF} sheetKey="nsf" label="NSF Team" mode="nsf" statusQueryFn={fetchNSFBackendStatsSheet} />
              </TabsContent>
            )}
            {canSeeTab("rmk") && (
              <TabsContent value="rmk">
                <ReadyModeKillersPanel />
              </TabsContent>
            )}
            {canSeeTab("missed-no-cb") && (
              <TabsContent value="missed-no-cb">
                <MissedNoCBPanel lockedTeam={ta} />
              </TabsContent>
            )}
            {canSeeTab("callback-review") && (
              <TabsContent value="callback-review">
                <CallbackReviewPanel />
              </TabsContent>
            )}
            {canSeeTab("violations") && (
              <TabsContent value="violations">
                <ViolationsPanel />
              </TabsContent>
            )}
            {canSeeTab("qa") && (
              <TabsContent value="qa">
                <QAPanel />
              </TabsContent>
            )}
            {canSeeTab("onboarding") && (
              <TabsContent value="onboarding">
                <OnboardingPanel />
              </TabsContent>
            )}
          </Tabs>
        ) : view === "attendance" && can("view_attendance") ? (
          <AttendancePanel />
        ) : (
          <div className="flex flex-col items-center justify-center py-32 gap-3 text-zinc-500">
            <ShieldCheck className="h-10 w-10 opacity-30" />
            <p className="text-sm">You don't have permission to view this section.</p>
          </div>
        )}
      </main>
      {user.role === "admin" && <SamiaChat />}
    </div>
  );
}


// ─── Samia AI Chat ─────────────────────────────────────────────────────────────

interface SamiaMessage { role: "user" | "assistant"; content: string; images?: string[] }
interface HistoryGroup { key: string; label: string; preview: string; messages: SamiaMessage[] }

type ChatSize = "normal" | "minimized" | "maximized";

function SamiaChat() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState<ChatSize>("normal");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<SamiaMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  // Name gate
  const [chatName, setChatName] = useState<string>(() => localStorage.getItem("samia_display_name") ?? "");
  const [nameInput, setNameInput] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  // Admin "All chats" state
  const [adminView, setAdminView] = useState<"chat" | "users" | "viewUser" | "history" | "viewDate">("chat");
  const [adminUsers, setAdminUsers] = useState<{ userId: number; username: string }[]>([]);
  const [adminViewUser, setAdminViewUser] = useState<{ userId: number; username: string } | null>(null);
  const [adminMessages, setAdminMessages] = useState<SamiaMessage[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  // Personal chat history (grouped by date)
  const [historyGroups, setHistoryGroups] = useState<HistoryGroup[]>([]);
  const [historyGroup, setHistoryGroup] = useState<HistoryGroup | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { token, user } = useUser();
  const isAdmin = user.role === "admin";
  if (!isAdmin) return null;

  function submitName() {
    const n = nameInput.trim();
    if (!n) return;
    localStorage.setItem("samia_display_name", n);
    setChatName(n);
  }

  useEffect(() => {
    if (open) {
      setTimeout(() => {
        if (!chatName) { nameRef.current?.focus(); return; }
        inputRef.current?.focus();
      }, 80);
      if (!historyLoaded) {
        const hr = new Date().getHours();
        const timeGreet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
        const greeting = { role: "assistant" as const, content: `${timeGreet}. I'm Samia — I know every number in this dashboard cold. What do you need?` };
        // Start each session clean — past conversations live behind the History button.
        setMessages([greeting]);
        setHistoryLoaded(true);
      }
    }
  }, [open]);

  function openAdminUsers() {
    setAdminView("users");
    setAdminLoading(true);
    fetch("/api/samia/users", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: { userId: number; username: string }[]) => setAdminUsers(rows))
      .catch(() => setAdminUsers([]))
      .finally(() => setAdminLoading(false));
  }

  function viewUserChat(u: { userId: number; username: string }) {
    setAdminViewUser(u);
    setAdminView("viewUser");
    setAdminLoading(true);
    fetch(`/api/samia/history/${u.userId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: Array<{ role: string; content: string; images?: string[] | null }>) =>
        setAdminMessages(rows.map((r) => ({ role: r.role as "user" | "assistant", content: r.content, images: r.images ?? undefined })))
      )
      .catch(() => setAdminMessages([]))
      .finally(() => setAdminLoading(false));
  }

  function openHistory() {
    setAdminView("history");
    setHistoryLoading(true);
    fetch("/api/samia/history", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : [])
      .then((rows: Array<{ role: string; content: string; images?: string[] | null; createdAt: string }>) => {
        const byKey = new Map<string, HistoryGroup>();
        const order: string[] = [];
        const today = new Date().toLocaleDateString("en-CA");
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA");
        for (const r of rows) {
          const d = new Date(r.createdAt);
          const key = d.toLocaleDateString("en-CA");
          let g = byKey.get(key);
          if (!g) {
            const label = key === today ? "Today" : key === yesterday ? "Yesterday"
              : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
            g = { key, label, preview: "", messages: [] };
            byKey.set(key, g);
            order.push(key);
          }
          g.messages.push({ role: r.role as "user" | "assistant", content: r.content, images: r.images ?? undefined });
        }
        // Preview = first user line of the day (fallback to first message)
        for (const g of byKey.values()) {
          const firstUser = g.messages.find((m) => m.role === "user" && m.content.trim());
          const src = (firstUser ?? g.messages[0])?.content ?? "";
          g.preview = src.length > 60 ? src.slice(0, 60) + "…" : src || "(image only)";
        }
        // Newest day first
        setHistoryGroups(order.map((k) => byKey.get(k)!).reverse());
      })
      .catch(() => setHistoryGroups([]))
      .finally(() => setHistoryLoading(false));
  }

  function viewHistoryDate(g: HistoryGroup) {
    setHistoryGroup(g);
    setAdminView("viewDate");
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addImages(files: FileList | File[]) {
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/")).slice(0, 4);
    const urls = await Promise.all(arr.map(readFileAsDataURL));
    setPendingImages((prev) => [...prev, ...urls].slice(0, 4));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
    if (items.length === 0) return;
    e.preventDefault();
    const files = items.map((i) => i.getAsFile()).filter(Boolean) as File[];
    void addImages(files);
  }

  async function send() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || loading) return;
    const images = [...pendingImages];
    setInput("");
    setPendingImages([]);
    setMessages((prev) => [...prev, { role: "user", content: text, images: images.length ? images : undefined }]);
    setLoading(true);
    try {
      const res = await fetch("/api/samia/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text || "What do you see in this image?", images, displayName: chatName || undefined }),
      });
      const data = (await res.json()) as { reply?: string; error?: string; fallbackUsed?: boolean };
      const note = data.fallbackUsed ? "\n\nUsed backup model." : "";
      setMessages((prev) => [...prev, { role: "assistant", content: `${data.reply ?? data.error ?? "Sorry, something went wrong."}${note}` }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Network error — try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Floating bubble */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full bg-primary text-white shadow-lg flex items-center justify-center hover:scale-105 transition-transform"
        aria-label="Open Samia"
      >
        {open ? <X className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
      </button>

      {/* Chat panel */}
      {open && (
        <div className={`fixed z-50 flex flex-col rounded-2xl border border-white/10 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden transition-all duration-200 ${
          size === "maximized"
            ? "bottom-4 right-4 left-4 top-4 w-auto max-h-none"
            : size === "minimized"
            ? "bottom-24 right-4 sm:right-6 w-[calc(100vw-32px)] sm:w-[360px] max-h-none"
            : "bottom-24 right-4 sm:right-6 w-[calc(100vw-32px)] sm:w-[360px] max-h-[560px]"
        }`}>
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-white/8 bg-muted/40 flex-shrink-0">
            {(adminView === "users" || adminView === "viewUser" || adminView === "history" || adminView === "viewDate") ? (
              <button onClick={() => adminView === "viewUser" ? setAdminView("users") : adminView === "viewDate" ? setAdminView("history") : setAdminView("chat")} className="text-zinc-400 hover:text-white transition-colors p-1 -ml-1">
                <ChevronLeft className="h-4 w-4" />
              </button>
            ) : (
              <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center text-white font-bold text-sm shadow-md flex-shrink-0">S</div>
            )}
            <div>
              <p className="text-sm font-semibold text-white leading-none">
                {adminView === "users" ? "All Chats" : adminView === "viewUser" ? adminViewUser?.username ?? "User" : adminView === "history" ? "Chat History" : adminView === "viewDate" ? historyGroup?.label ?? "Chat" : "Samia"}
              </p>
              <p className="text-[10px] metric-info mt-0.5 flex items-center gap-1">
                {adminView === "chat" && <><span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse" />AI Analyst · Live data</>}
                {adminView === "users" && "Select a user to view their chat"}
                {adminView === "viewUser" && "Read-only · Admin view"}
                {adminView === "history" && "Your past conversations by date"}
                {adminView === "viewDate" && "Read-only · Past conversation"}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {/* Personal chat history button */}
              {adminView === "chat" && (
                <button onClick={openHistory} title="Chat history" className="text-zinc-500 hover:metric-info transition-colors p-1">
                  <Clock className="h-4 w-4" />
                </button>
              )}
              {/* Admin all-chats button */}
              {isAdmin && adminView === "chat" && (
                <button onClick={openAdminUsers} title="View all user chats" className="text-zinc-500 hover:metric-info transition-colors p-1">
                  <Users className="h-4 w-4" />
                </button>
              )}
              {/* Minimize */}
              <button
                onClick={() => setSize((s) => s === "minimized" ? "normal" : "minimized")}
                title={size === "minimized" ? "Restore" : "Minimize"}
                className="text-zinc-500 hover:text-white transition-colors p-1"
              >
                <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${size === "minimized" ? "rotate-180" : ""}`} />
              </button>
              {/* Maximize */}
              <button
                onClick={() => setSize((s) => s === "maximized" ? "normal" : "maximized")}
                title={size === "maximized" ? "Restore" : "Maximize"}
                className="text-zinc-500 hover:text-white transition-colors p-1"
              >
                {size === "maximized" ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              {/* Close */}
              <button onClick={() => { setOpen(false); setSize("normal"); setAdminView("chat"); setHistoryGroup(null); }} className="text-zinc-500 hover:text-white transition-colors p-1">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Name gate — shown if user hasn't set their display name yet */}
          {!chatName ? (
            <div className="flex-1 flex flex-col items-center justify-center px-6 py-8 gap-5">
              <div className="h-14 w-14 rounded-full bg-primary flex items-center justify-center text-white font-bold text-xl shadow-lg">S</div>
              <div className="text-center">
                <p className="text-sm font-semibold text-white mb-1">Hey, before we start —</p>
                <p className="text-xs text-zinc-400">What's your name? Samia will use it to remember you.</p>
              </div>
              <div className="w-full flex gap-2">
                <input
                  ref={nameRef}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitName(); }}
                  placeholder="Your first name…"
                  className="flex-1 text-sm rounded-xl bg-zinc-800 border border-white/10 px-3 py-2.5 text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  onClick={submitName}
                  disabled={!nameInput.trim()}
                  className="px-4 rounded-xl bg-primary text-white text-sm font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
                >
                  Go
                </button>
              </div>
            </div>
          ) : adminView === "users" ? (
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1 min-h-0">
              {adminLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-6">
                  <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!adminLoading && adminUsers.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No chat history yet.</p>
              )}
              {adminUsers.map((u) => (
                <button
                  key={u.userId}
                  onClick={() => viewUserChat(u)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
                >
                  <AvatarName name={u.username} size="md" textClassName="text-sm text-white" />
                  <ChevronRight className="h-4 w-4 text-zinc-600 ml-auto" />
                </button>
              ))}
            </div>
          ) : adminView === "viewUser" ? (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
              {adminLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-4">
                  <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!adminLoading && adminMessages.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No messages yet.</p>
              )}
              {adminMessages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                  )}
                  <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                  }`}>{m.content}</div>
                </div>
              ))}
            </div>
          ) : adminView === "history" ? (
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1 min-h-0">
              {historyLoading && (
                <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-6">
                  <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Loading…
                </div>
              )}
              {!historyLoading && historyGroups.length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No past conversations yet.</p>
              )}
              {historyGroups.map((g) => (
                <button
                  key={g.key}
                  onClick={() => viewHistoryDate(g)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left"
                >
                  <div className="h-8 w-8 rounded-full bg-zinc-700 flex items-center justify-center metric-info flex-shrink-0">
                    <Clock className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-white leading-tight">{g.label}</p>
                    <p className="text-[11px] text-zinc-500 truncate">{g.preview}</p>
                  </div>
                  <span className="text-[10px] text-zinc-600 flex-shrink-0">{g.messages.length} msg</span>
                  <ChevronRight className="h-4 w-4 text-zinc-600 flex-shrink-0" />
                </button>
              ))}
            </div>
          ) : adminView === "viewDate" ? (
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
              {(historyGroup?.messages ?? []).length === 0 && (
                <p className="text-center text-xs text-zinc-500 py-6">No messages.</p>
              )}
              {(historyGroup?.messages ?? []).map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                  )}
                  <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                  }`}>{m.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Normal chat messages */}
              <div className={`flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0 ${size === "minimized" ? "hidden" : ""}`}>
                {historyLoading && (
                  <div className="flex items-center justify-center gap-2 text-muted-foreground text-xs py-4">
                    <div className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                    Loading memory…
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    {m.role === "assistant" && (
                      <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                    )}
                    <div className={`max-w-[80%] flex flex-col gap-1.5 ${m.role === "user" ? "items-end" : "items-start"}`}>
                      {m.images?.map((src, idx) => (
                        <img key={idx} src={src} alt="attachment" className="max-w-[220px] rounded-xl border border-white/10 object-cover" />
                      ))}
                      {m.content && (
                        <div className={`rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                          m.role === "user" ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                        }`}>{m.content}</div>
                      )}
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold mr-2 mt-0.5 flex-shrink-0">S</div>
                    <div className="bg-zinc-800 rounded-2xl rounded-bl-sm px-3 py-2">
                      <div className="flex gap-1 items-center h-4">
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:0ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:300ms]" />
                      </div>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input bar */}
              <div className={`px-3 pb-3 pt-2 border-t border-white/8 flex flex-col gap-2 ${size === "minimized" ? "hidden" : ""}`}>
                {pendingImages.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {pendingImages.map((src, idx) => (
                      <div key={idx} className="relative group">
                        <img src={src} alt="pending" className="h-16 w-16 rounded-lg object-cover border border-white/10" />
                        <button
                          onClick={() => setPendingImages((p) => p.filter((_, i) => i !== idx))}
                          className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-zinc-700 border border-white/20 text-zinc-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-center">
                  <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => { if (e.target.files) { void addImages(e.target.files); e.target.value = ""; } }} />
                  <button onClick={() => fileInputRef.current?.click()} disabled={loading} title="Attach image"
                    className="h-9 w-9 rounded-xl bg-zinc-800 border border-white/10 text-zinc-400 hover:metric-info flex items-center justify-center transition-colors disabled:opacity-40 flex-shrink-0">
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                    onPaste={handlePaste} placeholder="Ask Samia anything… or paste a screenshot" disabled={loading}
                    className="flex-1 text-sm rounded-xl bg-zinc-800 border border-white/10 px-3 py-2 text-white placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50" />
                  <button onClick={() => void send()} disabled={(!input.trim() && pendingImages.length === 0) || loading}
                    className="h-9 w-9 rounded-xl bg-primary text-white flex items-center justify-center disabled:opacity-40 hover:opacity-90 transition-opacity flex-shrink-0">
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ─── Attendance ────────────────────────────────────────────────────────────────

interface AttMember { id: number; name: string; shift: string; shiftHours: string; department: string; active: boolean; }

// Convert an Egypt-local shift hour (e.g. 4 → "4 PM") to a friendly label.
// All shifts are afternoon/evening so values 1–11 are always PM.
function shiftLabel(shift: string): string {
  const n = parseInt(shift);
  if (!n) return shift;
  const h12 = n % 12 === 0 ? 12 : n % 12;
  const ampm = n >= 12 ? "AM" : "PM";
  return `${h12} ${ampm}`;
}
interface AttRecord { id: number; memberId: number; date: string; status: string; note: string | null; coaching: boolean; }
interface AttData { members: AttMember[]; records: AttRecord[]; }

const ATT_STATUS = [
  { s: "in",   label: "In",        cell: "bg-muted-foreground/25 metric-good", badge: "metric-good" },
  { s: "off",  label: "Off",       cell: "bg-muted metric-warn",     badge: "metric-warn" },
  { s: "late", label: "Late",      cell: "bg-yellow-400/25 text-yellow-300",   badge: "text-yellow-400" },
  { s: "pto",  label: "PTO",       cell: "bg-muted-foreground/25 metric-info",       badge: "metric-info" },
  { s: "nsnc", label: "NSNC",      cell: "bg-red-700/30 text-red-400",         badge: "text-red-400" },
  { s: "conf", label: "Confirmed", cell: "bg-teal-500/25 text-teal-300",       badge: "text-teal-400" },
  { s: "",     label: "Clear",     cell: "",                                    badge: "text-zinc-500" },
] as const;

function AttCell({ status, note, coaching, weekend }: { status: string; note?: string | null; coaching?: boolean; weekend?: boolean }) {
  const cfg = ATT_STATUS.find((x) => x.s === status);
  if (!status) return weekend
    ? <span className="text-zinc-800 text-xs font-medium select-none">—</span>
    : <span className="text-zinc-700 text-base leading-none">·</span>;
  const label = status === "in" ? "In" : status === "off" ? "Off" : status === "late" ? "Late" : status === "pto" ? "PTO" : status === "nsnc" ? "NSNC" : "Conf";
  return (
    <span className={`relative inline-flex items-center justify-center px-1.5 h-5 rounded text-[10px] font-bold whitespace-nowrap ${cfg?.cell ?? ""}`}>
      {label}
      {note && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-red-500 ring-1 ring-zinc-900" />}
      {coaching && <span className="absolute -bottom-1 -right-1 w-2 h-2 rounded-full bg-indigo-400 ring-1 ring-zinc-900" title="Got coaching" />}
    </span>
  );
}

const WDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function AttendancePanel() {
  const { token, can, user } = useUser();
  const roster = useRoster();
  const canEdit = can("edit_attendance");
  const canManage = can("manage_members");
  // Lock attendance view to the user's team when teamAccess is set (admins/unrestricted = null → see all).
  const TEAM_TO_DEPT: Record<string, string> = { retention: "Retention", nsf: "NSF", cs: "CS" };
  const lockedDept = user.teamAccess ? TEAM_TO_DEPT[user.teamAccess] : null;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString().slice(0, 10);
  const [monthOff, setMonthOff] = useState(0);
  const [deptFilter, setDeptFilter] = useState<string>(lockedDept ?? "All");
  const [editCell, setEditCell] = useState<{ memberId: number; date: string; name: string } | null>(null);
  const [editStatus, setEditStatus] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editCoaching, setEditCoaching] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newShift, setNewShift] = useState("");
  const [newShiftHours, setNewShiftHours] = useState("8");
  const [newDept, setNewDept] = useState("");
  const [importing, setImporting] = useState(false);
  const [autoMarking, setAutoMarking] = useState(false);
  const [autoMarkResult, setAutoMarkResult] = useState<string | null>(null);
  const [editingMember, setEditingMember] = useState<AttMember | null>(null);
  const [viewingMember, setViewingMember] = useState<AttMember | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const monthStart = new Date(today.getFullYear(), today.getMonth() + monthOff, 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + monthOff + 1, 0);
  const fromStr = monthStart.toISOString().slice(0, 10);
  const toStr = monthEnd.toISOString().slice(0, 10);
  const monthLabel = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const dateCols = useMemo(() => {
    const cols: string[] = [];
    const d = new Date(monthStart);
    while (d <= monthEnd) {
      cols.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return cols;
  }, [monthOff]);

  const qc = useQueryClient();
  const { data, isLoading } = useQuery<AttData>({
    queryKey: ["attendance", fromStr, toStr, showInactive],
    queryFn: async () => {
      const params = new URLSearchParams({ from: fromStr, to: toStr });
      if (showInactive) params.set("includeInactive", "true");
      const r = await fetch(`/api/attendance?${params}`);
      if (!r.ok) throw new Error("fetch failed");
      return r.json();
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const recordMap = useMemo(() => {
    const m = new Map<string, AttRecord>();
    for (const rec of data?.records ?? []) m.set(`${rec.memberId}_${rec.date}`, rec);
    return m;
  }, [data]);

  // Members the current user is allowed to see at all (team-lock).
  const scopedMembers = useMemo(
    () => (data?.members ?? []).filter((m) => !lockedDept || m.department === lockedDept),
    [data, lockedDept],
  );

  const departments = useMemo(() => {
    const s = new Set<string>(["All"]);
    for (const m of scopedMembers) if (m.department) s.add(m.department);
    // Killers span teams; offer them as a pseudo-department when any are present.
    if (scopedMembers.some((m) => isKillerAgentKey(normalizeAgent(m.name)))) s.add("Killers");
    return [...s];
  }, [scopedMembers]);

  const visible = useMemo(
    () => scopedMembers
      .filter((m) =>
        deptFilter === "All" ||
        (deptFilter === "Killers"
          ? isKillerAgentKey(normalizeAgent(m.name))
          : m.department === deptFilter))
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return parseFloat(a.shift || "0") - parseFloat(b.shift || "0");
      }),
    [scopedMembers, deptFilter],
  );

  const todaySummary = useMemo(() => {
    const c = { in: 0, off: 0, late: 0, pto: 0, nsnc: 0, absent: 0 };
    for (const m of scopedMembers) {
      const s = recordMap.get(`${m.id}_${todayStr}`)?.status ?? "";
      if (s === "in") c.in++; else if (s === "off") c.off++;
      else if (s === "late") c.late++; else if (s === "pto") c.pto++;
      else if (s === "nsnc") c.nsnc++; else c.absent++;
    }
    return c;
  }, [scopedMembers, recordMap, todayStr]);

  const teamSummary = useMemo(() => {
    const map = new Map<string, { present: number; total: number }>();
    for (const m of scopedMembers) {
      const dept = m.department || "Other";
      if (!map.has(dept)) map.set(dept, { present: 0, total: 0 });
      const entry = map.get(dept)!;
      entry.total++;
      const s = recordMap.get(`${m.id}_${todayStr}`)?.status ?? "";
      if (s === "in" || s === "late") entry.present++;
    }
    return [...map.entries()]
      .map(([dept, { present, total }]) => ({ dept, present, total }))
      .sort((a, b) => a.dept.localeCompare(b.dept));
  }, [scopedMembers, recordMap, todayStr]);

  async function upsert(memberId: number, date: string, status: string, note: string, coaching: boolean) {
    await fetch("/api/attendance/record", {
      method: "PUT", headers: authHeaders(token),
      body: JSON.stringify({ memberId, date, status, note: note || null, coaching }),
    });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  function openCell(m: AttMember, date: string) {
    const rec = recordMap.get(`${m.id}_${date}`);
    setEditCell({ memberId: m.id, date, name: m.name });
    setEditStatus(rec?.status ?? "");
    setEditNote(rec?.note ?? "");
    setEditCoaching(rec?.coaching ?? false);
  }

  async function saveCell() {
    if (!editCell) return;
    await upsert(editCell.memberId, editCell.date, editStatus, editNote, editCoaching);
    setEditCell(null);
  }

  async function addMember() {
    if (!newName.trim()) return;
    await fetch("/api/attendance/members", {
      method: "POST", headers: authHeaders(token),
      body: JSON.stringify({ name: newName.trim(), shift: newShift.trim(), shiftHours: newShiftHours.trim() || "8", department: newDept.trim() }),
    });
    setNewName(""); setNewShift(""); setNewShiftHours("8"); setNewDept(""); setShowAdd(false);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function saveMember() {
    if (!editingMember) return;
    await fetch(`/api/attendance/members/${editingMember.id}`, {
      method: "PATCH", headers: authHeaders(token),
      body: JSON.stringify({ name: editingMember.name, shift: editingMember.shift, shiftHours: editingMember.shiftHours, department: editingMember.department }),
    });
    setEditingMember(null);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function setMemberActive(id: number, active: boolean) {
    await fetch(`/api/attendance/members/${id}`, {
      method: "PATCH", headers: authHeaders(token),
      body: JSON.stringify({ active }),
    });
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }

  async function doImport() {
    setImporting(true);
    await fetch("/api/attendance/import", { method: "POST", headers: authHeaders(token) });
    qc.invalidateQueries({ queryKey: ["attendance"] });
    setImporting(false);
  }

  async function doAutoMark() {
    setAutoMarking(true);
    setAutoMarkResult(null);
    try {
      const r = await fetch("/api/attendance/auto-mark", { method: "POST", headers: authHeaders(token) });
      const data = await r.json() as { success: boolean; results?: { name: string; status: string; note: string; skipped?: string }[] };
      if (data.success && data.results) {
        const marked = data.results.filter((x) => x.status);
        const late = marked.filter((x) => x.status === "late");
        const inTime = marked.filter((x) => x.status === "in");
        setAutoMarkResult(`Marked ${marked.length} agents: ${inTime.length} on time${late.length ? `, ${late.length} late` : ""}`);
      }
      qc.invalidateQueries({ queryKey: ["attendance"] });
    } finally {
      setAutoMarking(false);
    }
  }

  const showTodaySummary = dateCols.includes(todayStr) && (data?.members?.length ?? 0) > 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Attendance</h2>
          <p className="text-sm text-muted-foreground">Track daily presence, mark status, and add notes per agent</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canManage && (data?.members.length ?? 0) === 0 && (
            <Button size="sm" variant="outline" onClick={doImport} disabled={importing}>
              {importing ? "Importing…" : "Import from Sheets"}
            </Button>
          )}
          {canEdit && (
            <Button size="sm" variant="outline" onClick={doAutoMark} disabled={autoMarking}
              title="Check each agent's first call today vs their shift start and auto-mark late/on-time">
              {autoMarking ? "Checking…" : "Auto-mark today"}
            </Button>
          )}
          {autoMarkResult && (
            <span className="text-xs metric-good">{autoMarkResult}</span>
          )}
          {canManage && (
            <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => setShowAdd((v) => !v)}>
              + Add Member
            </Button>
          )}
          {!canEdit && !canManage && (
            <Badge className="text-[10px] px-2 py-1 bg-zinc-500/20 text-zinc-400 border-zinc-500/30 border flex items-center gap-1">
              <Eye className="h-3 w-3" />View only
            </Badge>
          )}
        </div>
      </div>

      {/* Add Member form */}
      {showAdd && (
        <Card className="border-border bg-zinc-900/70 p-4">
          <div className="flex gap-3 items-end flex-wrap">
            <div className="flex-1 min-w-[160px]">
              <Label className="text-xs text-muted-foreground mb-1 block">Name *</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" className="h-8" onKeyDown={(e) => e.key === "Enter" && addMember()} />
            </div>
            <div className="w-24">
              <Label className="text-xs text-muted-foreground mb-1 block">Shift start</Label>
              <Input value={newShift} onChange={(e) => setNewShift(e.target.value)} placeholder="e.g. 8 (8 AM)" className="h-8" />
            </div>
            <div className="w-20">
              <Label className="text-xs text-muted-foreground mb-1 block">Hours</Label>
              <Input value={newShiftHours} onChange={(e) => setNewShiftHours(e.target.value)} placeholder="8" className="h-8" />
            </div>
            <div className="w-44">
              <Label className="text-xs text-muted-foreground mb-1 block">Department</Label>
              <Input value={newDept} onChange={(e) => setNewDept(e.target.value)} placeholder="e.g. Retention" className="h-8" />
            </div>
            <Button size="sm" onClick={addMember} disabled={!newName.trim()}>Add</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {/* Today summary tiles */}
      {showTodaySummary && (
        <div className="space-y-3">
          {/* Overall breakdown */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 sm:gap-3">
            {[
              { label: "Present", value: todaySummary.in,     color: "metric-good" },
              { label: "Off",     value: todaySummary.off,    color: "metric-warn" },
              { label: "Late",    value: todaySummary.late,   color: "text-yellow-400" },
              { label: "PTO",     value: todaySummary.pto,    color: "metric-info" },
              { label: "NSNC",    value: todaySummary.nsnc,   color: "text-red-400" },
              { label: "No Data", value: todaySummary.absent, color: "text-zinc-500" },
            ].map(({ label, value, color }) => (
              <Card key={label} className="bg-zinc-900/60 border-white/10 p-3">
                <div className="text-xs text-muted-foreground mb-1">Today — {label}</div>
                <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
              </Card>
            ))}
          </div>

          {/* Per-team present breakdown */}
          <div className="flex gap-3 flex-wrap">
            {teamSummary.map(({ dept, present, total }) => {
              const pct = total > 0 ? Math.round((present / total) * 100) : 0;
              const barColor = pct >= 80 ? "bg-muted-foreground" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
              return (
                <Card key={dept} className="bg-zinc-900/60 border-white/10 p-3 flex-1 min-w-[120px]">
                  <div className="text-xs text-muted-foreground mb-1">{dept} — Present</div>
                  <div className={`text-2xl font-bold tabular-nums ${pct >= 80 ? "metric-good" : pct >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                    {present}<span className="text-sm font-normal text-muted-foreground">/{total}</span>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Dept filter + month navigation */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-1.5 flex-wrap items-center">
          {lockedDept ? (
            <div className="px-3 py-1 rounded-md text-sm font-medium bg-muted metric-info border border-border">
              {lockedDept} team
            </div>
          ) : departments.map((d) => (
            <button
              key={d}
              onClick={() => setDeptFilter(d)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${deptFilter === d ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-white hover:bg-white/5"}`}
            >
              {d}
            </button>
          ))}
          {canManage && (
            <button
              onClick={() => setShowInactive((v) => !v)}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors border ${showInactive ? "border-border bg-muted/50 metric-warn" : "border-white/10 text-zinc-500 hover:text-zinc-300 hover:bg-white/5"}`}
            >
              {showInactive ? "Hide inactive" : "Show inactive"}
            </button>
          )}
        </div>
        <div className="calendar-month-nav flex items-center gap-2">
          <button onClick={() => setMonthOff((v) => v - 1)} className="calendar-animated-control px-2 py-1 rounded text-muted-foreground hover:text-white hover:bg-white/5 transition-colors">←</button>
          <span className="calendar-month-label text-sm font-medium text-white w-32 text-center">{monthLabel}</span>
          <button onClick={() => setMonthOff((v) => v + 1)} className="calendar-animated-control px-2 py-1 rounded text-muted-foreground hover:text-white hover:bg-white/5 transition-colors">→</button>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : (
        <div className="attendance-calendar-grid overflow-x-auto rounded-lg border border-white/10">
          <table className="border-collapse text-sm" style={{ minWidth: `${220 + dateCols.length * 50}px` }}>
            <thead>
              <tr className="bg-zinc-950">
                <th className="sticky left-0 z-20 bg-zinc-950 text-left text-xs text-muted-foreground font-medium px-3 py-2 border-b border-white/10 min-w-[160px]">Agent Name</th>
                <th className="sticky left-[160px] z-20 bg-zinc-950 text-center text-xs text-muted-foreground font-medium px-1 py-2 border-b border-white/10 w-[90px]">Shift / Hrs</th>
                <th className="sticky left-[250px] z-20 bg-zinc-950 text-left text-xs text-muted-foreground font-medium px-2 py-2 border-b border-white/10 w-24">Dept</th>
                {dateCols.map((d) => {
                  const dt = new Date(d + "T12:00:00");
                  const isToday = d === todayStr;
                  const isTomorrow = d === tomorrowStr;
                  const isWknd = dt.getDay() === 0 || dt.getDay() === 6;
                  return (
                    <th
                      key={d}
                      className={`calendar-day-header text-center px-0 py-1 border-b border-white/10 w-12 ${isToday ? "bg-blue-900/40" : isTomorrow ? "bg-teal-900/30" : ""}`}
                      style={isWknd && !isToday && !isTomorrow ? { background: "repeating-linear-gradient(135deg, #0f0f12 0px, #0f0f12 4px, #16141a 4px, #16141a 8px)" } : undefined}
                    >
                      <div className={`text-[11px] font-semibold ${isToday ? "metric-info" : isTomorrow ? "text-teal-300" : isWknd ? "text-amber-700/80" : "text-muted-foreground"}`}>{dt.getDate()}</div>
                      <div className={`text-[9px] ${isToday ? "metric-info" : isTomorrow ? "text-teal-500" : isWknd ? "text-amber-800/70" : "text-zinc-600"}`}>{WDAYS[dt.getDay()]}</div>
                    </th>
                  );
                })}
                <th className="text-center text-xs text-emerald-500/70 font-medium px-2 py-2 border-b border-white/10 border-l border-white/10 w-8">In</th>
                <th className="text-center text-xs text-amber-500/70 font-medium px-2 py-2 border-b border-white/10 w-8">Off</th>
                <th className="text-center text-xs text-yellow-400/70 font-medium px-2 py-2 border-b border-white/10 w-8">Late</th>
                <th className="text-center text-xs metric-info/70 font-medium px-2 py-2 border-b border-white/10 w-8">PTO</th>
                <th className="text-center text-xs text-red-400/70 font-medium px-2 py-2 border-b border-white/10 w-10">NSNC</th>
                <th className="text-center text-xs metric-warn/70 font-medium px-2 py-2 border-b border-white/10 w-8" title="Saturdays present this month">Sat</th>
                <th className="text-center text-xs text-muted-foreground/50 font-medium px-1 py-2 border-b border-white/10 w-10" title="View agent details">View</th>
                {canManage && <th className="text-center text-xs text-muted-foreground/50 font-medium px-1 py-2 border-b border-white/10 w-6" title="Edit agent">⋯</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((member, mi) => {
                let cIn = 0, cOff = 0, cLate = 0, cPto = 0, cNsnc = 0, cSat = 0;
                for (const d of dateCols) {
                  const s = recordMap.get(`${member.id}_${d}`)?.status ?? "";
                  if (s === "in") cIn++; else if (s === "off") cOff++;
                  else if (s === "late") cLate++; else if (s === "pto") cPto++;
                  else if (s === "nsnc") cNsnc++;
                  if ((s === "in" || s === "late") && new Date(d + "T12:00:00").getDay() === 6) cSat++;
                }
                const rowBg = mi % 2 === 0 ? "bg-zinc-900/20" : "bg-zinc-900/50";
                const parts = agentNameParts(member.name, roster);
                return (
                  <tr key={member.id} className={`${rowBg} hover:bg-white/[0.03] transition-colors ${!member.active ? "opacity-40" : ""}`}>
                    <td className={`sticky left-0 z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} px-3 py-1.5 text-sm font-medium border-b border-white/5 whitespace-nowrap ${member.active ? "text-white" : "text-zinc-400 line-through"}`}>
                      <AvatarName name={parts.agentName} size="sm" textClassName={member.active ? "text-white" : "text-zinc-400 line-through"} />
                      {!member.active && <span className="ml-1.5 no-underline text-[10px] font-normal text-amber-500/70 bg-muted/50 px-1 rounded" style={{textDecoration:"none"}}>inactive</span>}
                    </td>
                    <td className={`sticky left-[160px] z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} text-center text-xs text-zinc-500 px-1 border-b border-white/5`} title={`Shift ${member.shift} (LA time) · ${member.shiftHours || "8"}h shift`}>
                      <div>{shiftLabel(member.shift)}</div>
                      {member.shiftHours && member.shiftHours !== "8" && (
                        <span className="text-[9px] font-semibold metric-warn bg-muted/60 rounded px-1">{member.shiftHours}h</span>
                      )}
                    </td>
                    <td className={`sticky left-[250px] z-10 ${mi % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900"} px-2 border-b border-white/5`}>
                      {member.department && (
                        <Badge className="text-[10px] px-1.5 py-0 bg-muted-foreground/20 metric-info border-border">{member.department}</Badge>
                      )}
                    </td>
                    {dateCols.map((d) => {
                      const rec = recordMap.get(`${member.id}_${d}`);
                      const isTomorrow = d === tomorrowStr;
                      const isFuture = d > tomorrowStr;
                      const isToday = d === todayStr;
                      const dt = new Date(d + "T12:00:00");
                      const isWknd = dt.getDay() === 0 || dt.getDay() === 6;
                      return (
                        <td
                          key={d}
                          onClick={() => canEdit && openCell(member, d)}
                          title={rec?.note ? `📝 ${rec.note}` : undefined}
                          className={`calendar-day-cell text-center border-b border-white/5 w-12 h-8 transition-colors
                            ${isToday ? "bg-blue-950/40" : isTomorrow ? "bg-teal-950/30" : ""}
                            ${!canEdit ? "cursor-default opacity-20" : "cursor-pointer hover:bg-white/5"}`}
                          style={isWknd && !isToday && !isTomorrow ? { background: "repeating-linear-gradient(135deg, #0f0f12 0px, #0f0f12 4px, #16141a 4px, #16141a 8px)" } : undefined}
                        >
                          <AttCell status={rec?.status ?? ""} note={rec?.note} coaching={rec?.coaching} weekend={isWknd && !isTomorrow} />
                        </td>
                      );
                    })}
                    <td className="text-center text-xs font-mono border-b border-white/5 border-l border-white/10 tabular-nums metric-good">{cIn || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums metric-warn">{cOff || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums text-yellow-400">{cLate || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums metric-info">{cPto || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums text-red-400">{cNsnc || "—"}</td>
                    <td className="text-center text-xs font-mono border-b border-white/5 tabular-nums metric-warn" title="Saturdays present (In or Late) this month">{cSat || "—"}</td>
                    <td className="text-center border-b border-white/5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => setViewingMember(member)}
                      >
                        <Eye className="mr-1 h-3 w-3" />
                        View
                      </Button>
                    </td>
                    {canManage && <td className="text-center border-b border-white/5">
                      {canManage && <button onClick={() => setEditingMember(member)} className="text-zinc-600 hover:text-zinc-300 transition-colors px-1 text-base leading-none">⋯</button>}
                    </td>}
                  </tr>
                );
              })}
              {visible.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={dateCols.length + 11 + (canManage ? 1 : 0)} className="text-center py-16 text-muted-foreground text-sm">
                    {(data?.members.length ?? 0) === 0 ? (
                      <>No members yet — <button onClick={doImport} disabled={importing} className="metric-info hover:metric-info underline">{importing ? "Importing…" : "import from Google Sheets"}</button> or add one above.</>
                    ) : (
                      <>No members in this department.</>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
        <span className="font-medium">Legend:</span>
        {ATT_STATUS.filter((x) => x.s).map(({ s, label, badge }) => (
          <span key={s} className={`flex items-center gap-1 ${badge}`} title={label}>
            <AttCell status={s} />
          </span>
        ))}
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Has note</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-indigo-400 inline-block" /> Got coaching</span>
        <span className="ml-auto italic">Click any past cell to mark attendance or add a note</span>
      </div>

      {viewingMember && (
        <RosterAgentDetailsDialog rawName={viewingMember.name} open={!!viewingMember} onOpenChange={(open) => !open && setViewingMember(null)}>
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <div className="text-xs text-muted-foreground">Department</div>
              <div className="font-medium">{viewingMember.department || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Shift</div>
              <div className="font-medium">{shiftLabel(viewingMember.shift) || "—"} · {viewingMember.shiftHours || "8"}h</div>
            </div>
          </div>
        </RosterAgentDetailsDialog>
      )}

      {/* Cell editor overlay */}
      {editCell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={(e) => { if (e.target === e.currentTarget) setEditCell(null); }}>
          <Card className="w-80 bg-zinc-900 border-border p-5 space-y-4 shadow-2xl">
            <div>
              <AvatarName name={editCell.name} size="md" textClassName="font-semibold text-white" />
              <div className="text-xs text-muted-foreground mt-0.5">
                {new Date(editCell.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {ATT_STATUS.map(({ s, label, cell }) => (
                <button
                  key={s}
                  onClick={() => setEditStatus(s)}
                  className={`px-3 py-1.5 rounded border text-xs font-medium transition-all
                    ${s ? cell : "bg-zinc-800/60 text-zinc-400 border-zinc-700/50"}
                    ${editStatus === s ? "ring-2 ring-white/40 opacity-100" : "opacity-60 hover:opacity-90"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Note (optional)</Label>
              <Input
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                placeholder="e.g. working from home, sick leave…"
                className="h-8 text-sm"
                onKeyDown={(e) => e.key === "Enter" && saveCell()}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Coaching</Label>
              <button
                onClick={() => setEditCoaching((v) => !v)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded border text-xs font-medium transition-all w-full
                  ${editCoaching
                    ? "bg-indigo-500/25 text-indigo-300 border-indigo-500/50 ring-2 ring-indigo-400/40"
                    : "bg-zinc-800/60 text-zinc-400 border-zinc-700/50 hover:opacity-90"}`}
              >
                <span className={`w-2 h-2 rounded-full ${editCoaching ? "bg-indigo-400" : "bg-zinc-600"}`} />
                {editCoaching ? "Got coaching today" : "No coaching"}
              </button>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <Button size="sm" variant="ghost" onClick={() => setEditCell(null)}>Cancel</Button>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={saveCell}>Save</Button>
            </div>
          </Card>
        </div>
      )}

      {/* Edit member overlay */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={(e) => { if (e.target === e.currentTarget) setEditingMember(null); }}>
          <Card className="w-80 bg-zinc-900 border-white/20 p-5 space-y-4 shadow-2xl">
            <div className="font-semibold text-white">Edit Member</div>
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Name</Label>
                <Input value={editingMember.name} onChange={(e) => setEditingMember({ ...editingMember, name: e.target.value })} className="h-8" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground mb-1 block">Shift start</Label>
                  <Input value={editingMember.shift} onChange={(e) => setEditingMember({ ...editingMember, shift: e.target.value })} className="h-8" placeholder="e.g. 8 (8 AM)" />
                </div>
                <div className="w-20">
                  <Label className="text-xs text-muted-foreground mb-1 block">Hours</Label>
                  <Input value={editingMember.shiftHours ?? "8"} onChange={(e) => setEditingMember({ ...editingMember, shiftHours: e.target.value })} className="h-8" placeholder="8" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Department</Label>
                <Input value={editingMember.department} onChange={(e) => setEditingMember({ ...editingMember, department: e.target.value })} className="h-8" placeholder="e.g. Retention" />
              </div>
            </div>
            <div className="flex gap-2 justify-between pt-1">
              {editingMember.active ? (
                <Button size="sm" variant="destructive" onClick={() => { setMemberActive(editingMember.id, false); setEditingMember(null); }}>
                  Set inactive
                </Button>
              ) : (
                <Button size="sm" className="bg-emerald-700 hover:bg-primary text-primary-foreground" onClick={() => { setMemberActive(editingMember.id, true); setEditingMember(null); }}>
                  Reactivate
                </Button>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditingMember(null)}>Cancel</Button>
                <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={saveMember}>Save</Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <LoginGate>
            <RosterProvider>
              <Dashboard />
            </RosterProvider>
          </LoginGate>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;



