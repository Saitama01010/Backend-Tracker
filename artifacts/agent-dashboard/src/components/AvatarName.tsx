import type * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

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
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function personInitials(name: string) {
  const parts = name.replace(/[^a-zA-Z0-9\s-]/g, " ").trim().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function AvatarIcon({ name, size = "md", className }: { name: string; size?: "xs" | "sm" | "md" | "lg"; className?: string }) {
  const palette = AVATAR_PALETTES[hashString(name || "user") % AVATAR_PALETTES.length];
  const sizeClass = size === "xs" ? "h-6 w-6 text-[10px]" : size === "sm" ? "h-7 w-7 text-[11px]" : size === "lg" ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs";
  return (
    <motion.span
      initial={{ scale: 0.82, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 350, damping: 28 }}
      className={cn("avatar-initial inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white shadow-sm ring-1 ring-white/15", palette, sizeClass, className)}
      aria-hidden="true"
    >
      {personInitials(name)}
    </motion.span>
  );
}

export function AvatarName({ name, subtitle, size = "md", className, textClassName, subtitleClassName }: {
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
