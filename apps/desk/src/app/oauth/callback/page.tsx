import { getDeskConfig } from "@flock/deployment/config";
import { deskMemberScopes } from "@flock/protocol/scopes";
import { DeskCallbackClient } from "./callback-client";

export const dynamic = "force-dynamic";

export default function DeskOAuthCallbackPage() {
  const config = getDeskConfig();
  return (
    <DeskCallbackClient
      config={{
        appUrl: config.appUrl.origin,
        plcUrl: config.plcDirectoryUrl.origin,
        scope: deskMemberScopes().join(" "),
      }}
    />
  );
}
