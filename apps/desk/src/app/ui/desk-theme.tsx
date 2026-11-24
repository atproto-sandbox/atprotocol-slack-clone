"use client";

import type { ReactNode } from "react";
import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export function DeskThemeProvider({ children }: { children: ReactNode }) {
  return (
    <Theme theme={neutralTheme} mode="light">
      <div className="desk-root">{children}</div>
    </Theme>
  );
}
