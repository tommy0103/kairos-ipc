import type { ComputedRef, InjectionKey, Plugin  } from 'vue';
import { computed, inject, watch } from 'vue';

import { getShadeConfigOrThrow, getThemeColorOklch } from '@kairos-ipc/chromatix';
import type { ChromatixTheme, ShadeConfig, DEFAULT_SHADE_CONFIG, DEFAULT_SHADE_ALIASES } from '@kairos-ipc/chromatix';
import type { ChromatixPalette } from './api';
import { ChromatixColor } from './api';
import { PaletteHueProvider, providePaletteHue } from './internal/provider';
import { paletteHueValuesInputToCssVariables, paletteHueValuesInputToValues, type PaletteHueValuesInput } from './utils';

export type { PaletteHueProvider } from './internal/provider';

// Sadly variables could not have generic type parameters.
export const ChromatixKey: InjectionKey<ComputedRef<{
  theme: ChromatixTheme<number, string>;
  paletteHueValues?: Record<string, number>;
  globalPaletteHueValues?: Record<string, number>;
}>> = Symbol('Chromatix');

/**
 * @param globalPaletteHueValuesInput These values are injected into the <html> element. Any hue value could be overriden by `providePalette` or `<PaletteProvider>`.
 * If no passed, all Chromatix colors will be unavailable (unless explicitly provided via `providePalette` or `<PaletteProvider>`).
 */
export const createChromatix = <ShadeLevel extends number = keyof typeof DEFAULT_SHADE_CONFIG, ShadeAlias extends string = keyof typeof DEFAULT_SHADE_ALIASES, PaletteName extends string = string>(
  theme: ChromatixTheme<ShadeLevel, ShadeAlias, PaletteName>,
  globalPaletteHueValuesInput?: PaletteHueValuesInput<PaletteName>,
) => {
  const chromatixPlugin: Plugin<[]> = app => {
    app.provide(ChromatixKey, computed(() => {
      const globalPaletteHueValues = paletteHueValuesInputToValues(globalPaletteHueValuesInput);
      return {
        theme: theme as ChromatixTheme,
        globalPaletteHueValues,
        paletteHueValues: globalPaletteHueValues,
      };
    }));

    // Set initial theme context variables on <html> element
    watch(
      () => paletteHueValuesInputToCssVariables(theme, globalPaletteHueValuesInput),
      (newCssVariables, oldCssVariables) => {
        for (const key of Object.keys(oldCssVariables ?? {}).filter(key => !(key in newCssVariables)))
          document.documentElement.style.removeProperty(key);
        for (const [key, value] of Object.entries(newCssVariables))
          document.documentElement.style.setProperty(key, value);
      }, { immediate: true, deep: true },
    );
  };

  const getChromatixPalette = (hue: number | ComputedRef<number>): ChromatixPalette<ShadeLevel, ShadeAlias> => {
    const shade = (shadeLevelOrAliasOrConfig: ShadeLevel | ShadeAlias | ShadeConfig, alpha?: number) => new ChromatixColor({
      ...getThemeColorOklch(typeof hue === 'number' ? hue : hue.value, typeof shadeLevelOrAliasOrConfig === 'object' ? shadeLevelOrAliasOrConfig : getShadeConfigOrThrow(theme, shadeLevelOrAliasOrConfig)),
      alpha: alpha ?? 1,
    });
    return {
      hue,
      shade,
      css: (shadeLevelOrAlias, alpha) => shade(shadeLevelOrAlias, alpha).css(),
    };
  };

  const injectOrThrow = () => {
    const context = inject(ChromatixKey);
    if (!context) throw new Error('Failed to inject Chromatix context. Using hue with palette name is only available within a Component context and `createChromatix()` plugin must be used globally.');
    return context;
  };

  /**
   * Using hue with number is available in any context.
   *
   * Using hue with palette name is only available within a Component context.
   */
  const useHue = (hueNumberOrPaletteName: number | PaletteName) => {
    if (typeof hueNumberOrPaletteName === 'number') return getChromatixPalette(hueNumberOrPaletteName);
    const context = injectOrThrow();
    if (!context.value.paletteHueValues)
      throw new Error('Palette hue values are not available. Please provide them via `createChromatix` or `providePalette` first or pass initial values globally to `createChromatix`.');
    if (!(hueNumberOrPaletteName in context.value.paletteHueValues))
      throw new Error(`Palette hue value not found for palette name "${hueNumberOrPaletteName}". Available palette names: ${Object.keys(context.value.paletteHueValues).join(', ')}`);
    return getChromatixPalette(computed(() => context.value.paletteHueValues![hueNumberOrPaletteName] as number));
  };

  /**
   * Returns the palette hue values that are overriden by `providePaletteHue` or `<PaletteHueProvider>`, which means these palettes
   * have different hue values at current DOM position compared to the values on :root. Useful for preserving the scoped hue values when using <Teleport>.
   */
  const useOverridenPaletteHueValues = () => {
    const context = injectOrThrow();
    return computed(() => {
      const overridenList = Object.keys(context.value.paletteHueValues ?? {}).map(paletteName => {
        const globalHue = context.value.globalPaletteHueValues?.[paletteName];
        const scopedHue = context.value.paletteHueValues?.[paletteName];
        return globalHue !== scopedHue ? [paletteName, scopedHue] as const : undefined;
      }).filter(x => x != null);
      return overridenList.length > 0 ? Object.fromEntries(overridenList) as Record<PaletteName, number> : undefined;
    });
  };

  return {
    chromatixPlugin,
    useHue,
    providePaletteHue: providePaletteHue<PaletteName>,
    PaletteHueProvider: PaletteHueProvider as PaletteHueProvider<PaletteName>,
    useOverridenPaletteHueValues,
  } as const;
};
