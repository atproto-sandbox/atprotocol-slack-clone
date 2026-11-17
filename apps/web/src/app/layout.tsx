import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LOOPBACK_PATH_HEADER, resolveLoopbackRedirect } from "../lib/loopback-redirect";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spaces — conversations that belong to you",
  description: "Shared workspaces and channels built on your atproto account.",
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
