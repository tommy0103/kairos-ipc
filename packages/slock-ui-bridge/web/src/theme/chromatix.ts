import type { ShadeAlias, ShadeLevel } from "@kairos-ipc/chromatix";
import type { ChromatixPalette } from "@kairos-ipc/chromatix-vue";
import { createChromatix } from "@kairos-ipc/chromatix-vue";
import { slockChromatixConfig, slockPaletteHues } from "./chromatix.config";

export const {
  chromatixPlugin,
  PaletteHueProvider,
  providePaletteHue,
  useHue,
  useOverridenPaletteHueValues,
} = createChromatix(slockChromatixConfig, slockPaletteHues);

export type SlockShadeLevel = ShadeLevel<typeof slockChromatixConfig>;
export type SlockShadeAlias = ShadeAlias<typeof slockChromatixConfig>;
export type SlockPalette = ChromatixPalette<SlockShadeLevel, SlockShadeAlias>;
