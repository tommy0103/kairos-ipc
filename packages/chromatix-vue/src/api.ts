import type { ComputedRef } from 'vue';

import type { Oklch, ShadeConfig } from '@kairos-ipc/chromatix';
import { toCssString, colorMix } from '@kairos-ipc/chromatix';

/**
 * Represents a palette of colors with a given hue value and theme shade configs.
 */
export interface ChromatixPalette<ShadeLevel extends number, ShadeAlias extends string> {
  /**
   * Get the hue value of the palette. Reactive if used by palette name.
   */
  readonly hue: number | ComputedRef<number>;

  /**
   * Pick a shade level (by shade level, shade alias or given independent shade config) for the palette's hue value.
   *
   * The `ChromatixColor` object is not reactive. If reactivity is needed, please wrap it in a computed ref.
   */
  shade(shade: ShadeLevel | ShadeAlias | ShadeConfig, alpha?: number): ChromatixColor;

  /**
   * Shorthand for `shade(shade).css()`.
   */
  css(shade: ShadeLevel | ShadeAlias | ShadeConfig, alpha?: number): string;
}

export class ChromatixColor implements Oklch {
  public readonly mode = 'oklch';
  public readonly l: number;
  public readonly c: number;
  public readonly h?: number | undefined;
  public readonly alpha?: number | undefined;

  constructor(l: number, c: number, h?: number | undefined, alpha?: number | undefined);
  constructor(oklch: Oklch);
  constructor(lOrOklch: number | Oklch, c?: number, h?: number | undefined, alpha?: number | undefined) {
    if (typeof lOrOklch === 'object') {
      this.l = lOrOklch.l;
      this.c = lOrOklch.c;
      this.h = lOrOklch.h;
      this.alpha = lOrOklch.alpha;
    } else if (typeof lOrOklch === 'number' && typeof c === 'number') {
      this.l = lOrOklch;
      this.c = c;
      this.h = h;
      this.alpha = alpha;
    } else {
      throw new Error(`Invalid ChromatixColor constructor arguments: ${JSON.stringify(arguments)}`);
    }
  }

  /**
   * Return the CSS string representation of the color. Will use OKLCH if supported, otherwise RGBA.
   */
  css(alpha?: number): string {
    return toCssString({ ...this, alpha: alpha ?? this.alpha });
  }

  /**
   * Mix this color with another color.
   * @param incomingColor - The color to mix with.
   * @param incomingColorPercentage - The percentage of the incoming color to mix with. Must be between 0 and 1.
   * @returns A new ChromatixColor instance.
   */
  mix(incomingColor: Oklch, incomingColorPercentage: number): ChromatixColor {
    return new ChromatixColor(colorMix(this, incomingColor, incomingColorPercentage));
  }
}
