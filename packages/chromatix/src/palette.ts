import { colorMix } from './color-mix';
import { COLOR_WHITE } from './constants';
import type { Oklch } from './conversion';
import { oklch, toCssStringRgbPart } from './conversion';
import { isOklchSupported } from './is-supported';
import type { Alpha } from './utils';
import { cssExprOklch, cssExprRgba } from './utils';

export interface ShadeConfig {
  lightness: number;
  chromaMultiplier: number;
  mixWithWhite?: number;
}

export const DEFAULT_SHADE_CONFIG = {
  50: { lightness: 0.95, chromaMultiplier: 0.3, mixWithWhite: 0.7 },
  100: { lightness: 0.95, chromaMultiplier: 0.5, mixWithWhite: 0.2 },
  200: { lightness: 0.90, chromaMultiplier: 0.6 },
  300: { lightness: 0.85, chromaMultiplier: 0.75 },
  400: { lightness: 0.74, chromaMultiplier: 0.85 },
  500: { lightness: 0.62, chromaMultiplier: 1.0 }, // base
  600: { lightness: 0.54, chromaMultiplier: 1.15 },
  700: { lightness: 0.49, chromaMultiplier: 1.1 },
  800: { lightness: 0.42, chromaMultiplier: 0.85 },
  900: { lightness: 0.37, chromaMultiplier: 0.7 },
  950: { lightness: 0.29, chromaMultiplier: 0.5 },
} satisfies Record<number, ShadeConfig>;

export const DEFAULT_SHADE_ALIASES = {
  DEFAULT: 500,
} satisfies Record<string, keyof typeof DEFAULT_SHADE_CONFIG>;

export const DEFAULT_CSS_VAR_PREFIX = 'chromatix';

export interface ChromatixTheme<
  ShadeLevel extends number = keyof typeof DEFAULT_SHADE_CONFIG,
  ShadeAlias extends string = keyof typeof DEFAULT_SHADE_ALIASES,
  PaletteName extends string = string,
> {
  /**
   * The shade configs for all palettes.
   *
   * @default DEFAULT_SHADE_CONFIG
   */
  shadeConfigs?: Record<ShadeLevel, ShadeConfig>;

  /**
   * The aliases for the shade levels.
   *
   * @default DEFAULT_SHADE_ALIASES
   */
  shadeAliases?: Record<ShadeAlias, ShadeLevel>;

  /**
   * The shade level for the `color.<paletteName>.DEFAULT` UnoCSS color (like `bg-primary` without `-500`).
   *
   * Only used in UnoCSS. Ignored in runtime.
   *
   * @default 500
   */
  defaultShadeLevel?: number;

  /**
   * The prefix for the CSS variables.
   *
   * @default DEFAULT_CSS_VAR_PREFIX
   */
  cssVarPrefix?: string;

  /**
   * The list of palette names.
   *
   * @example
   * ['primary']
   */
  palettes: PaletteName[];

  /**
   * Force the color mode (OKLCH or RGBA) to be used, bypassing the browser support check.
   *
   * Not recommended but useful for SSR. It's your responsibility to determine the suitable color mode for the client,
   * and ensure consistency between server and client side.
   *
   * @default undefined (auto-detect based on browser support)
   */
  forceColorMode?: 'oklch' | 'rgba';
}

export type ShadeLevel<Theme extends ChromatixTheme> = keyof Theme['shadeConfigs'];
export type ShadeAlias<Theme extends ChromatixTheme> = keyof Theme['shadeAliases'];
export type PaletteName<Theme extends ChromatixTheme> = Theme['palettes'][number];

export const getThemeCssVarName = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, suffix: string) => `--${theme.cssVarPrefix ?? DEFAULT_CSS_VAR_PREFIX}-${suffix}`;
export const getThemeCssVar = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, suffix: string) => `var(${getThemeCssVarName(theme, suffix)})`;
export const shouldUseOklch = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>) => theme.forceColorMode === 'oklch' ? true : (theme.forceColorMode !== 'rgba' && isOklchSupported);

export const getShadeConfigOrThrow = <ShadeLevel extends number, ShadeAlias extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, string>, shadeLevelOrAlias: ShadeLevel | ShadeAlias) => {
  const shadeConfigs = theme.shadeConfigs ?? DEFAULT_SHADE_CONFIG as Record<ShadeLevel, ShadeConfig>;
  const shadeAliases = theme.shadeAliases ?? DEFAULT_SHADE_ALIASES as Record<ShadeAlias, ShadeLevel>;
  let resolvedShadeLevelOrAlias = shadeLevelOrAlias;
  while (!(resolvedShadeLevelOrAlias in shadeConfigs)) {
    if (!(resolvedShadeLevelOrAlias in shadeAliases)) {
      throw new Error(`Unknown shade level or alias: ${resolvedShadeLevelOrAlias} (resolved from ${shadeLevelOrAlias}). Available shade aliases: ${Object.keys(shadeAliases).join(', ')}. Available shade levels: ${Object.keys(shadeConfigs).join(', ')}.`);
    }
    resolvedShadeLevelOrAlias = shadeAliases[resolvedShadeLevelOrAlias as ShadeAlias];
  }
  const shadeConfig = shadeConfigs[resolvedShadeLevelOrAlias as ShadeLevel]!;
  return shadeConfig;
};

/**
 * Get a complex CSS expression that represents the given shade of color of the given palette in OKLCH format.
 *
 * Used both in runtime and UnoCSS.
 *
 * @note The `--chromatix-<palatteName>-hue` var must exist in the context. See also `getThemeContextVars`.
 */
export const getThemeCssColorExprOklch = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, paletteName: PaletteName, shadeLevelOrAlias: ShadeLevel | ShadeAlias, alpha?: Alpha) =>
  oklchExprFromShade(getThemeCssVar(theme, `${paletteName}-hue`), alpha, getShadeConfigOrThrow(theme, shadeLevelOrAlias));

/**
 * Get a complex CSS expression that represents the given shade of color of the given palette in RGBA format.
 *
 * Used for fallback (both in runtime and UnoCSS).
 *
 * @note This should not be called directly. Use `getThemeCssColorExpr` instead if you want to support both legacy and modern browsers.
 * @note The list of `--chromatix-<palatteName>-rgb-<shadeLevel>` vars must exist in the context. See also `getThemeContextVars`.
 */
export const getThemeCssColorExprRgba = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, paletteName: PaletteName, shadeLevelOrAlias: ShadeLevel | ShadeAlias, alpha?: Alpha) =>
  getShadeConfigOrThrow(theme, shadeLevelOrAlias) && cssExprRgba(getThemeCssVar(theme, `${paletteName}-rgb-${shadeLevelOrAlias}`), alpha);

/**
 * Used in runtime only. Calls `getThemeCssColorExprOklch` or `getThemeCssColorExprRgba` depending on the browser support of OKLCH.
 *
 * @note Use `getThemeCssColorExprOklch` if you target modern browsers only.
 */
export const getThemeCssColorExpr = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, paletteName: PaletteName, shadeLevelOrAlias: ShadeLevel | ShadeAlias, alpha?: Alpha) => shouldUseOklch(theme)
  ? getThemeCssColorExprOklch(theme, paletteName, shadeLevelOrAlias, alpha)
  : getThemeCssColorExprRgba(theme, paletteName, shadeLevelOrAlias, alpha);

const oklchExprFromShade = (hueVar: string, alpha: Alpha, { lightness, chromaMultiplier, mixWithWhite }: ShadeConfig): string => mixWithWhite
  ? `color-mix(in oklch, ${cssExprOklch(1, 0, undefined, alpha)} ${mixWithWhite * 100}%, ${oklchExprFromShade(hueVar, alpha, { lightness, chromaMultiplier })})`
  : cssExprOklch(
      lightness,
      `calc(${chromaMultiplier} * (0.18 + (cos(${hueVar} * 3.14159265 / 180) * 0.04)))`,
      hueVar,
      alpha,
    );

/**
 * The same as `getThemeCssColorExprOklch`, but accepts the hue value as a number and returns the `oklch()` value without any CSS variables.
 *
 * Useful for computing colors dynamically at runtime.
 */
export const getThemeCssColorValueOklch = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, hue: number, shadeLevelOrAlias: ShadeLevel | ShadeAlias, alpha?: Alpha) =>
  oklchValueFromShade(hue, alpha, getShadeConfigOrThrow(theme, shadeLevelOrAlias));

const calcChroma = (hue: number, chromaMultiplier: number) => chromaMultiplier * (0.18 + Math.cos(hue * Math.PI / 180) * 0.04);

const oklchValueFromShade = (hue: number, alpha: Alpha, { lightness, chromaMultiplier, mixWithWhite }: ShadeConfig): string => mixWithWhite
  ? `color-mix(in oklch, ${cssExprOklch(1, 0, undefined, alpha)} ${mixWithWhite * 100}%, ${oklchValueFromShade(hue, alpha, { lightness, chromaMultiplier })})`
  : cssExprOklch(
      lightness,
      calcChroma(hue, chromaMultiplier),
      hue,
      alpha,
    );

/**
 * @note This should not be called directly. Use `getThemeCssColorValue` instead if you want to support both legacy and modern browsers.
 */
export const getThemeCssColorValueRgba = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, hue: number, shadeLevelOrAlias: ShadeLevel | ShadeAlias, alpha?: Alpha) =>
  cssExprRgba(getThemeCssColorValueRgbPart(hue, getShadeConfigOrThrow(theme, shadeLevelOrAlias)), alpha);

export const getThemeColorOklch = (hue: number, { lightness, chromaMultiplier, mixWithWhite }: ShadeConfig): Oklch => mixWithWhite
  ? colorMix(getThemeColorOklch(hue, { lightness, chromaMultiplier }), COLOR_WHITE, mixWithWhite)
  : oklch(lightness, calcChroma(hue, chromaMultiplier), hue);

const getThemeCssColorValueRgbPart = (hue: number, shadeConfig: ShadeConfig) => toCssStringRgbPart(getThemeColorOklch(hue, shadeConfig));

/**
 * Used in runtime only. Calls `getThemeCssColorValueOklch` or `getThemeCssColorValueRgba` depending on the browser support of OKLCH.
 *
 * @note Use `getThemeCssColorValueOklch` if you target modern browsers only.
 */
export const getThemeCssColorValue = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, hue: number, shadeLevelOrAlias: ShadeLevel | ShadeAlias, alpha?: Alpha) => shouldUseOklch(theme)
  ? getThemeCssColorValueOklch(theme, hue, shadeLevelOrAlias, alpha)
  : getThemeCssColorValueRgba(theme, hue, shadeLevelOrAlias, alpha);

/**
 * Used in runtime only. Get the list of required context CSS variables for the given palette in OKLCH format, with the given hue value.
 */
export const getThemeContextVarsOklch = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, paletteName: PaletteName, hue: number): Record<string, string> => ({
  [getThemeCssVarName(theme, `${paletteName}-hue`)]: String(hue),
});

/**
 * Used in runtime only. Get the list of required context CSS variables for the given palette in RGBA format, with the given shade level.
 *
 * @note This should not be called directly. Use `getThemeContextVars` instead if you want to support both legacy and modern browsers.
 */
export const getThemeContextVarsRgba = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, paletteName: PaletteName, hue: number): Record<string, string> => Object.fromEntries(Object.entries(theme.shadeConfigs ?? DEFAULT_SHADE_CONFIG).map(([shadeLevel, shadeConfig]) =>
  [getThemeCssVarName(theme, `${paletteName}-rgb-${shadeLevel}`), getThemeCssColorValueRgbPart(hue, shadeConfig)]));

/**
 * Used in runtime only. Calls `getThemeContextVarsOklch` or `getThemeContextVarsRgba` depending on the browser support of OKLCH.
 *
 * @note Use `getThemeContextVarsOklch` if you target modern browsers only.
 */
export const getThemeContextVars = <ShadeLevel extends number, ShadeAlias extends string, PaletteName extends string>(theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>, paletteName: PaletteName, hue: number): Record<string, string> => shouldUseOklch(theme)
  ? getThemeContextVarsOklch(theme, paletteName, hue)
  : getThemeContextVarsRgba(theme, paletteName, hue);
