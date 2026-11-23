"use client";

import dynamic from "next/dynamic";
import type { GroupOAuthCallbackViewProps } from "../../ui/group-oauth-callback-view";

const GroupOAuthCallbackView = dynamic(
  () => import("../../ui/group-oauth-callback-view").then((mod) => mod.GroupOAuthCallbackView),
  { ssr: false },
);

export function GroupOAuthCallbackClient(props: GroupOAuthCallbackViewProps) {
  return <GroupOAuthCallbackView {...props} />;
}
