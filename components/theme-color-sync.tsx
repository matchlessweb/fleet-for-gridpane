"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { fleetConfig } from "@/fleet.config";

/**
 * The viewport export emits media-scoped <meta name="theme-color"> tags that
 * track the SYSTEM color scheme. The in-app toggle (next-themes, class-based)
 * can disagree with the system, which would leave the browser/status-bar chrome
 * tinted for the wrong theme. This keeps the meta tags in step with the theme
 * the app is actually rendering.
 */
const THEME_COLORS: Record<string, string> = fleetConfig.themeColor;

export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (!resolvedTheme) return;
    const color = THEME_COLORS[resolvedTheme] ?? THEME_COLORS.light;
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (metas.length === 0) {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = color;
      document.head.appendChild(meta);
      return;
    }
    metas.forEach((meta) => {
      meta.content = color;
      // media-scoped tags would let the system scheme override the app toggle
      meta.removeAttribute("media");
    });
  }, [resolvedTheme]);

  return null;
}
