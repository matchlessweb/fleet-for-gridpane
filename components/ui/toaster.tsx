"use client";

import { useTheme } from "next-themes";
import { Toaster as SonnerToaster } from "sonner";

/** Theme-aware toast host — follows the app theme instead of being locked dark. */
export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      richColors
      closeButton
      position="top-right"
      // Phones: clear the masthead icon cluster (~110px tall) and stay off
      // the screen edges; desktop keeps the default top-right offset.
      mobileOffset={{ top: 116, right: 12, left: 12 }}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
    />
  );
}
