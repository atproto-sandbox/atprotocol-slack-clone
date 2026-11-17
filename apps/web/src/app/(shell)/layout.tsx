import { Suspense } from "react";
import { browserSessionConfig } from "../browser-session-config";
import { AppEntry } from "../ui/app-entry";

export const dynamic = "force-dynamic";

/** Persistent app shell kept mounted across workspace, channel, DM, and extension navigations. */
export default function ShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <Suspense fallback={null}>
        <AppEntry config={browserSessionConfig()} />
      </Suspense>
      {children}
    </>
  );
}
