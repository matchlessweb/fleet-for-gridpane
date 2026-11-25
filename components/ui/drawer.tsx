"use client";

import * as React from "react";
import { Sheet } from "./sheet";

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  width?: number;
  footer?: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

/** Drawer — a Sheet on the right from `sm` up, a bottom sheet on phones. */
export function Drawer({ width = 440, ...props }: DrawerProps) {
  return <Sheet side="right" width={width} {...props} />;
}
