import type { Oklch } from 'culori/fn';

// Reference: Chromium's color mix implementation
// https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/graphics/color.cc

// Chromium uses float instead of double for color calculations
const f16 = Math.fround;

const blend = (from: number, to: number, progress: number) => {
  const fromF = f16(from), toF = f16(to);
  return f16(fromF + f16(f16(toF - fromF) * f16(progress)));
};

export type HueInterpolationMethod = 'shorter' | 'longer' | 'increasing' | 'decreasing';

const hueInterpolation = (fromHue: number, toHue: number, progress: number, method: HueInterpolationMethod) => {
  let v1 = f16(fromHue), v2 = f16(toHue);
  if (method === 'shorter') {
    const diff = f16(v2 - v1);
    if (diff > 180) v1 = f16(v1 + 360);
    else if (diff < -180) v2 = f16(v2 + 360);
  } else if (method === 'longer') {
    const diff = f16(v2 - v1);
    if (diff > 0 && diff < 180) v1 = f16(v1 + 360);
    else if (diff > -180 && diff <= 0) v2 = f16(v2 + 360);
  } else if (method === 'increasing') {
    if (v2 < v1) v2 = f16(v2 + 360);
  } else if (method === 'decreasing') {
    if (v1 < v2) v1 = f16(v1 + 360);
  }
  const hRaw = blend(v1, v2, progress);
  return f16(f16(f16(hRaw % 360) + 360) % 360);
};

/**
 * @note This color mix implementation is based on the Chromium's algorithm, NOT handling "powerless hue"s. To mix a color with black/white,
 * make sure to use `undefined` for the hue. Any number here is considered a valid hue for hue interpolation.
 */
export const colorMix = (fromColor: Oklch, toColor: Oklch, progress: number, hueMethod: HueInterpolationMethod = 'shorter'): Oklch => {
  const alpha1 = f16(fromColor.alpha ?? 1);
  const alpha2 = f16(toColor.alpha ?? 1);

  const alphaOut = blend(alpha1, alpha2, progress);

  if (alphaOut === 0) return { mode: 'oklch', l: 0, c: 0, h: undefined, alpha: 0 };

  const l1 = f16(fromColor.l), l2 = f16(toColor.l);
  const c1 = f16(fromColor.c), c2 = f16(toColor.c);

  const l1Pre = f16(l1 * alpha1), l2Pre = f16(l2 * alpha2);
  const c1Pre = f16(c1 * alpha1), c2Pre = f16(c2 * alpha2);

  const lPre = blend(l1Pre, l2Pre, progress);
  const cPre = blend(c1Pre, c2Pre, progress);

  const lOut = f16(lPre / alphaOut);
  const cOut = f16(cPre / alphaOut);

  const h1Sub = fromColor.h ?? toColor.h, h2Sub = toColor.h ?? fromColor.h;
  const hOut = h1Sub == null || h2Sub == null ? undefined : hueInterpolation(h1Sub, h2Sub, progress, hueMethod);

  const result: Oklch = { mode: 'oklch', l: lOut, c: cOut };
  if (hOut != null) result.h = hOut;
  if (alphaOut < 1) result.alpha = alphaOut;

  return result;
};
