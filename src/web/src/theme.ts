import type { AreaId, Severity } from "@swarm/shared";

/**
 * Swarm placeholder identity: dark, neon accents, soft glow. This file is the single source of
 * truth: `applyTheme` publishes it as CSS variables and the canvas reads it directly, so the
 * whole look can be changed here. (Variables are set through the CSSOM, which the strict
 * style-src CSP allows.)
 */
export const theme = {
  name: "Swarm",
  colour: {
    bg: "#070b14",
    bgRaised: "#0d1424",
    panel: "rgba(16, 24, 44, 0.72)",
    panelBorder: "rgba(120, 160, 255, 0.18)",
    text: "#e6ecff",
    textMuted: "#9aa8c7",
    accent: "#22e5ff",
    accentAlt: "#b26bff",
    danger: "#ff4d6d",
    success: "#43f0a5",
    warning: "#ffb454",
  },
  area: {
    recon: "#38bdf8",
    unauth: "#a3e635",
    authn: "#f59e0b",
    llm: "#c084fc",
    logic: "#fb7185",
  } satisfies Record<AreaId, string>,
  severity: {
    critical: "#ff3b6b",
    high: "#ff7a45",
    medium: "#ffc247",
    low: "#5ad1ff",
    info: "#9aa8c7",
  } satisfies Record<Severity, string>,
  glow: {
    soft: "0 0 18px rgba(34, 229, 255, 0.25)",
    strong: "0 0 28px rgba(34, 229, 255, 0.5)",
  },
  font: {
    sans: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
    mono: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
  },
  radius: "12px",
} as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function applyTheme(root: HTMLElement = document.documentElement): void {
  const set = (name: string, value: string) => root.style.setProperty(`--${name}`, value);
  for (const [key, value] of Object.entries(theme.colour)) set(kebab(key), value);
  for (const [key, value] of Object.entries(theme.area)) set(`area-${key}`, value);
  for (const [key, value] of Object.entries(theme.severity)) set(`sev-${key}`, value);
  for (const [key, value] of Object.entries(theme.glow)) set(`glow-${key}`, value);
  set("font-sans", theme.font.sans);
  set("font-mono", theme.font.mono);
  set("radius", theme.radius);
}
