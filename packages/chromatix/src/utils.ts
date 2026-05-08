export type Alpha = undefined | null | number | '%alpha'; // Supports UnoCSS's %alpha placeholder

export const isAlphaEffective = (alpha: Alpha | undefined) => alpha != null && alpha !== 1;

export const cssExprOklch = (l: string | number, c: string | number, h: string | number | undefined, alpha: Alpha) =>
  `oklch(${l} ${c} ${h ?? 'none'}${isAlphaEffective(alpha) ? ` / ${alpha}` : ''})`;

export const cssExprRgba = (rgb: string, alpha: Alpha) => isAlphaEffective(alpha) ? `rgba(${rgb}, ${alpha})` : `rgb(${rgb})`;
