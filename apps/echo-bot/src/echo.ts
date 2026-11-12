import { runApp, type AppMessage } from "@flock/client/app-runtime";
import type { Engine } from "@flock/client/engine";
import type { OperatorClient } from "@flock/client/operator-client";

// The echo bot: the smallest app. It answers each message a person writes in a channel it may write with the message's text,
// in that message's thread.

const MAX_TEXT_GRAPHEMES = 10_000;

/** The echo bot's answer to a message: its text after `echo: `, in its thread; none for a message with no text, or where it reads only. */
export function echoReply({ canWrite, message }: AppMessage): { text: string; parent: string } | null {
  const text = typeof message.value.text === "string" ? message.value.text.trim() : "";
  if (!canWrite || text.length === 0) return null;
  const parent = typeof message.value.parent === "string" ? message.value.parent : message.uri;
  return { text: Array.from(new Intl.Segmenter().segment(`echo: ${text}`), (part) => part.segment).slice(0, MAX_TEXT_GRAPHEMES).join(""), parent };
}

/** Runs the echo bot over the workspaces it was installed in until `signal` aborts. */
export function startEchoBot(input: {
  engine: Pick<Engine, "channels" | "workspaces" | "credentials"> & { operator: Pick<OperatorClient, "getChanges"> };
  did: string;
  workspaces: readonly string[];
  signal: AbortSignal;
  onError(error: unknown): void;
}): Promise<void> {
  return runApp({
    ...input,
    onMessage: async (message) => {
      const reply = echoReply(message);
      if (reply) await input.engine.channels.send(message.channel, reply.text, reply.parent);
    },
  });
}
