import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./desk.css";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LOOPBACK_PATH_HEADER, resolveLoopbackRedirect } from "../lib/loopback-redirect";
import { DeskThemeProvider } from "./ui/desk-theme";

export const metadata: Metadata = {
  title: "Flock Desk — Independent Atmosphere Groups & Spaces Client",
  description: "Standalone browser client talking directly to personal PDSes and Atmosphere Group Hosts.",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const requestHeaders = await headers();
  const redirectUrl = resolveLoopbackRedirect(
    requestHeaders.get("host"),
    requestHeaders.get(LOOPBACK_PATH_HEADER) ?? "/",
  );
  if (redirectUrl) {
    redirect(redirectUrl.toString());
  }

  return (
    <html lang="en" data-theme="light">
      <body>
        <DeskThemeProvider>{children}</DeskThemeProvider>
      </body>
    </html>
  );
}
