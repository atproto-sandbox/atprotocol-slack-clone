import { redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { browserSessionConfig } from "@/app/browser-session-config";
import { DmCallbackClient } from "./dm-callback-client";

export const dynamic = "force-dynamic";

export default async function DmCallbackPage() {
  const session = await getSession().catch(() => null);
  if (!session) redirect("/");

  return <DmCallbackClient expectedDid={session.did} dmConfig={browserSessionConfig()} />;
}
