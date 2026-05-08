import type { CSSEntries } from '@unocss/core';
import { definePreset } from '@unocss/core';
import valueParser from 'postcss-value-parser';

import { DEFAULT_SHADE_CONFIG, getThemeCssColorExprOklch, getThemeCssColorExprRgba, type ChromatixTheme } from '@kairos-ipc/chromatix';

// When forceColorMode is NOT set, generate `--chromatix(oklch(...), rgba(...))` pseudo function expressions containing both OKLCH and RGBA
// as placeholder, and extract them to two `@supports` blocks with postprocess hook to support both OKLCH and RGBA.
const PLACEHOLDER_PSEUDO_FUNCTION = '--chromatix';
const getThemeCssColorExprForUnoCSS = (theme: ChromatixTheme<number, string>, paletteName: string, shadeLevel: number) => {
  const oklch = theme.forceColorMode === 'rgba' ? undefined : getThemeCssColorExprOklch(theme, paletteName, shadeLevel, '%alpha');
  const rgba = theme.forceColorMode === 'oklch' ? undefined : getThemeCssColorExprRgba(theme, paletteName, shadeLevel, '%alpha');
  if (oklch && rgba) return `${PLACEHOLDER_PSEUDO_FUNCTION}(${oklch}, ${rgba})`;
  if (oklch) return oklch;
  return rgba!;
};

export const presetChromatix = definePreset<ChromatixTheme<number, string>>(theme => ({
  name: 'preset-chromatic',
  ...theme && {
    theme: {
      colors: theme.palettes
        .reduce((colors, paletteName) => ({
          ...colors,
          [paletteName]: {
            ...Object.fromEntries(
              Object.keys(theme.shadeConfigs ?? DEFAULT_SHADE_CONFIG).map(
                shadeLevel =>
                  [shadeLevel, getThemeCssColorExprForUnoCSS(theme, paletteName, parseInt(shadeLevel))],
              ),
            ),
            DEFAULT: getThemeCssColorExprForUnoCSS(theme, paletteName, theme.defaultShadeLevel ?? 500),
          },
        }), {} as Record<string, Record<number, string>>),
    },
    // When forceColorMode is set, we just generate the CSS color expressions for one color mode, so no need to postprocess.
    postprocess: theme.forceColorMode ? undefined : util => {
      // Filter out entries that contain the placeholder pseudo function and preserve other entries
      const oklchEntries: CSSEntries = [];
      const rgbaEntries: CSSEntries = [];
      util.entries = util.entries.filter(entry => {
        const value = entry[1];
        if (typeof value !== 'string') return true;
        const parsed = valueParser(value);

        // Extract all --chromatix(oklch(...), rgba(...)) pseudo function expressions
        const pseudoExpressions: { stringified: string; oklchExpr: string; rgbaExpr: string }[] = [];
        parsed.walk(node => {
          if (node.type !== 'function' || node.value !== PLACEHOLDER_PSEUDO_FUNCTION) return;

          // Find the only comma separator position
          const commaIndexes = node.nodes.map((n, i) => n.type === 'div' && n.value === ',' ? i : -1).filter(i => i !== -1);
          if (commaIndexes.length !== 1) throw new Error(`Expected exactly one ',' separator in ${PLACEHOLDER_PSEUDO_FUNCTION}() pseudo expression but found ${commaIndexes.length} in: ${JSON.stringify(value)}. This must be a bug!`);

          pseudoExpressions.push({
            stringified: valueParser.stringify(node),
            oklchExpr: valueParser.stringify(node.nodes.slice(0, commaIndexes[0]!)).trim(),
            rgbaExpr: valueParser.stringify(node.nodes.slice(commaIndexes[0]! + 1)).trim(),
          });
        });

        if (pseudoExpressions.length > 0) {
          const fullOklchExpr = pseudoExpressions.reduce((full, current) => full.replaceAll(current.stringified, current.oklchExpr), value);
          const fullRgbaExpr = pseudoExpressions.reduce((full, current) => full.replaceAll(current.stringified, current.rgbaExpr), value);

          const rgbaEntry = [...entry] as typeof entry;
          rgbaEntry[1] = fullRgbaExpr;
          rgbaEntries.push(rgbaEntry);

          const oklchEntry = [...entry] as typeof entry;
          oklchEntry[1] = fullOklchExpr;
          oklchEntries.push(oklchEntry);

          return false; // Remove this entry from "common" entries
        }
        return true;
      });

      const result = [util, {
        ...util,
        parent: composeUnoCSSUtilParent(util.parent, '@supports not (color: oklch(0 0 0))'),
        entries: rgbaEntries,
      }, {
        ...util,
        parent: composeUnoCSSUtilParent(util.parent, '@supports (color: oklch(0 0 0))'),
        entries: oklchEntries,
      }].filter(u => u.entries.length > 0);
      return result;
    },
  },
}));

const composeUnoCSSUtilParent = (existingParent: string | undefined, appendParent: string) => existingParent ? `${existingParent} $$ ${appendParent}` : appendParent;
