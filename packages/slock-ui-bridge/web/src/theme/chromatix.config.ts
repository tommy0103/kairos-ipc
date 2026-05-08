import { DEFAULT_SHADE_CONFIG, type ChromatixTheme } from "@kairos-ipc/chromatix";

export const slockChromatixConfig = {
  cssVarPrefix: "slock",
  defaultShadeLevel: 500,
  forceColorMode: "oklch",
  shadeAliases: {
    quietest: 50,
    quiet: 100,
    soft: 200,
    muted: 300,
    DEFAULT: 500,
    strong: 600,
    solid: 700,
    ink: 900,
  },
  shadeConfigs: DEFAULT_SHADE_CONFIG,
  palettes: ["accent", "success", "warning", "danger", "info", "agent"],
} as const satisfies ChromatixTheme<number, string>;

export const slockPaletteHues = {
  accent: 178,
  success: 150,
  warning: 72,
  danger: 25,
  info: 225,
  agent: 92,
} as const;
