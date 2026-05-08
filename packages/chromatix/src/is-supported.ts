export const isOklchSupported = typeof window === 'undefined' ? true : (window.CSS?.supports('color: oklch(0 0 0)') ?? false);
