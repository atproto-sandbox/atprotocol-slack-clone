import { redirect } from "next/navigation";
import { DM_BROWSER_SCOPES } from "@/auth/permission-sets";
import { getSession } from "@/auth/session";
import { getConfig } from "@/lib/config";
import { DmCallbackClient } from "./dm-callback-client";

export const dynamic = "force-dynamic";

export default async function DmCallbackPage() {
  const session = await getSession().catch(() => null);
  if (!session) redirect("/");

  const { appUrl, plcDirectoryUrl, operatorServiceRef } = getConfig();
  const dmConfig = {
    appUrl: appUrl.origin,
    plcUrl: plcDirectoryUrl.toString(),
    scope: DM_BROWSER_SCOPES.join(" "),
    serviceRef: operatorServiceRef,
    loopback: appUrl.protocol === "http:",
  };
  return <DmCallbackClient expectedDid={session.did} dmConfig={dmConfig} />;
}
