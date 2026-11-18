import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spaces — conversations that belong to you",
  description: "Shared workspaces and channels built on your atproto account.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
