import type { MaybeRefOrGetter } from 'vue';
import { toValue } from 'vue';

import type { ChromatixTheme } from '@kairos-ipc/chromatix';
import { getThemeContextVars } from '@kairos-ipc/chromatix';
import type { ChromatixPalette } from './api';

const getHue = (hueOrPalette: number | ChromatixPalette<number, string>) => typeof hueOrPalette === 'number' ? hueOrPalette : typeof hueOrPalette.hue === 'number' ? hueOrPalette.hue : hueOrPalette.hue.value;

export const paletteHueValuesInputToValues = <PaletteName extends string>(
  paletteHueValuesInput: PaletteHueValuesInput<PaletteName> | PaletteHueValuesInputPartial<PaletteName>,
): Record<PaletteName, number> =>
  Object.fromEntries(Object.entries(toValue(paletteHueValuesInput) ?? {})
    .map(([paletteName, hueOrGetter]) => [paletteName, getHue(toValue(hueOrGetter) as number | ChromatixPalette<number, string>)])) as Record<PaletteName, number>;

export const paletteHueValuesInputToCssVariables = <PaletteName extends string>(
  theme: ChromatixTheme<number, string, PaletteName>,
  paletteHueValuesInput: PaletteHueValuesInput<PaletteName> | PaletteHueValuesInputPartial<PaletteName>,
): Record<string, string> =>
  Object.assign({}, ...Object.entries(toValue(paletteHueValuesInput) ?? {})
    .map(([paletteName, hueOrGetter]) => getThemeContextVars(theme, paletteName, getHue(toValue(hueOrGetter) as number | ChromatixPalette<number, string>)))) as Record<string, string>;

export type MaybeGetter<T> = T | (() => T);

export type PaletteHueValuesInput<PaletteName extends string> = MaybeGetter<Record<PaletteName, MaybeRefOrGetter<number | ChromatixPalette<number, string>>> | undefined>;
export type PaletteHueValuesInputPartial<PaletteName extends string> = MaybeGetter<Partial<Record<PaletteName, MaybeRefOrGetter<number | ChromatixPalette<number, string>>> | undefined>>;
