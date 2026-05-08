import { convertRgbToOklab, convertLabToLch, convertLchToLab, convertOklabToRgb, parseHex } from 'culori/fn';
import type { Oklch, Rgb } from 'culori/fn';
export type { Oklch } from 'culori/fn';

import { isOklchSupported } from './is-supported';
import { cssExprOklch, cssExprRgba } from './utils';

export const oklch = (l: number, c: number, h?: number | undefined, alpha = 1): Oklch => ({ mode: 'oklch', l, c, h, alpha });

export function rgb(r: number, g: number, b: number, alpha?: number): Oklch;
export function rgb(hex: string): Oklch;
export function rgb(rOrHex: number | string, g?: number, b?: number, alpha = 1): Oklch {
  let rgbValue: Rgb | undefined;
  if (typeof rOrHex === 'string' && arguments.length === 1) {
    rgbValue = parseHex(rOrHex);
    if (!rgbValue) throw new Error(`Invalid hex color: ${rOrHex}`);
  } else if (typeof rOrHex === 'number' && typeof g === 'number' && typeof b === 'number') {
    rgbValue = { mode: 'rgb', r: rOrHex, g, b, alpha };
  } else throw new Error(`Invalid RGB color: ${Array.from(arguments).join(', ')}`);;

  const oklch = convertLabToLch(convertRgbToOklab(rgbValue), 'oklch');
  const ACHROMATIC_CHROMA_THRESHOLD = 0.02; // https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/graphics/color.cc
  if (Math.abs(oklch.c) < ACHROMATIC_CHROMA_THRESHOLD) oklch.h = undefined;
  return oklch;
}

export const toCssStringOklch = (color: Oklch): string => cssExprOklch(color.l, color.c, color.h, color.alpha);

// NOTE: `toGamut` may be more "correct" theoretically, but modern browsers displays oklch() on sRGB monitors
// by just clamping every R/G/B channel. Align with browser behavior.
const clampRgbValue = (value: number): number => Math.max(0, Math.min(255, value * 255));
export const toRgb = (color: Oklch): Rgb => {
  const { r, g, b } = convertOklabToRgb(convertLchToLab(color));
  return { mode: 'rgb', r: clampRgbValue(r), g: clampRgbValue(g), b: clampRgbValue(b), alpha: color.alpha };
};
export const toCssStringRgbPart = (color: Oklch): string => {
  const { r, g, b } = toRgb(color);
  return `${r}, ${g}, ${b}`;
};

export const toCssStringRgba = (color: Oklch): string => cssExprRgba(toCssStringRgbPart(color), color.alpha);

export const toCssString = (color: Oklch, forceRepresentation?: 'oklch' | 'rgb'): string => {
  const shouldUseOklch = isOklchSupported ? forceRepresentation !== 'rgb' : forceRepresentation === 'oklch';
  return shouldUseOklch ? toCssStringOklch(color) : toCssStringRgba(color);
};
