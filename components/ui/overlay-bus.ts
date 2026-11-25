/**
 * overlay-bus — one overlay open at a time. Pure module, no React.
 * Modal/Drawer claim on open (closing any previous overlay) and release
 * on close/unmount.
 */

let current: (() => void) | null = null;

export function claimOverlay(close: () => void): void {
  if (current && current !== close) current();
  current = close;
}

export function releaseOverlay(close: () => void): void {
  if (current === close) current = null;
}

export function closeCurrentOverlay(): void {
  const close = current;
  current = null;
  if (close) close();
}
