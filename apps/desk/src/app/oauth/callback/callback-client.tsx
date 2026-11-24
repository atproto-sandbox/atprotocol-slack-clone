"use client";

import dynamic from "next/dynamic";
import type { DeskCallbackViewProps } from "./callback-view";

const DeskCallbackView = dynamic(
  () => import("./callback-view").then((mod) => mod.DeskCallbackView),
  { ssr: false },
);

export function DeskCallbackClient(props: DeskCallbackViewProps) {
  return <DeskCallbackView {...props} />;
}
