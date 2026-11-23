import {
  runApp,
  type AppAction,
  type AppCommand,
  type AppMessage,
  type AppRuntimeEngine,
  type DeclaredCommand,
} from "@flock/client/app-runtime";
import { actionsBlock, button, sectionBlock, type MessageBlock } from "@flock/client/blocks";

// The echo bot: answers each channel message in its thread, and answers `/echo <text>` (and clicks on its `Again` button)
// with blocks carrying an `Again` button.

const MAX_TEXT_GRAPHEMES = 10_000;
const MAX_TEXT_BYTES = 40_000;
const MAX_SECTION_GRAPHEMES = 3_000;
const MAX_SECTION_BYTES = 12_000;
const MAX_BUTTON_VALUE_BYTES = 2_000;

export const ECHO_BOT_COMMANDS: readonly DeclaredCommand[] = [
  { name: "echo", description: "Repeats text in the channel.", usage: "<text>" },
];

function boundText(value: string, maxGraphemes: number, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let graphemes = 0;
  let bytes = 0;
  for (const { segment } of new Intl.Segmenter().segment(value)) {
    const segmentBytes = encoder.encode(segment).length;
    if (graphemes + 1 > maxGraphemes || bytes + segmentBytes > maxBytes) break;
    result += segment;
    graphemes += 1;
    bytes += segmentBytes;
  }
  return result;
}

/** The echo bot's answer to a message: its text after `echo: `, in its thread; none for a hidden message, a message with no text, or where it reads only. */
export function echoReply({ canWrite, message }: AppMessage): { text: string; parent: string } | null {
  if (message.hidden === true) return null;
  const text = typeof message.value.text === "string" ? message.value.text.trim() : "";
  if (!canWrite || text.length === 0) return null;
  const parent = typeof message.value.parent === "string" ? message.value.parent : message.uri;
  return { text: boundText(`echo: ${text}`, MAX_TEXT_GRAPHEMES, MAX_TEXT_BYTES), parent };
}

function buildEchoBlockAnswer(raw: string, parent?: string): { text: string; parent?: string; blocks: MessageBlock[] } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = boundText(trimmed, MAX_SECTION_GRAPHEMES, MAX_BUTTON_VALUE_BYTES);
  if (value.length === 0) return null;
  const prefixed = `echo: ${trimmed}`;
  return {
    text: boundText(prefixed, MAX_TEXT_GRAPHEMES, MAX_TEXT_BYTES),
    ...(parent === undefined ? {} : { parent }),
    blocks: [
      sectionBlock(boundText(prefixed, MAX_SECTION_GRAPHEMES, MAX_SECTION_BYTES)),
      actionsBlock([button({ actionId: "again", label: "Again", value })]),
    ],
  };
}

/** The echo bot's answer to `/echo <text>`: a block message with an `Again` button, where it may write. */
export function echoCommandReply(
  command: Pick<AppCommand, "canWrite" | "command" | "text" | "parent">,
): { text: string; parent?: string; blocks: MessageBlock[] } | null {
  if (!command.canWrite || command.command !== "echo") return null;
  return buildEchoBlockAnswer(command.text, command.parent);
}

/** The echo bot's answer to clicking `Again`: repeats the button's value with a fresh `Again` button. */
export function echoActionReply(
  action: Pick<AppAction, "canWrite" | "actionId" | "value" | "message">,
): { text: string; parent?: string; blocks: MessageBlock[] } | null {
  if (!action.canWrite || action.actionId !== "again" || typeof action.value !== "string") return null;
  const parent = typeof action.message.value.parent === "string" ? action.message.value.parent : undefined;
  return buildEchoBlockAnswer(action.value, parent);
}

/** Runs the echo bot over the workspaces it was installed in until `signal` aborts. */
export function startEchoBot(input: {
  engine: AppRuntimeEngine;
  did: string;
  workspaces: readonly string[];
  signal: AbortSignal;
  onError(error: unknown): void;
}): Promise<void> {
  return runApp({
    ...input,
    commands: ECHO_BOT_COMMANDS,
    onMessage: async (message) => {
      const reply = echoReply(message);
      if (reply) await input.engine.channels.send(message.channel, reply.text, reply.parent);
    },
    onCommand: async (command) => {
      const reply = echoCommandReply(command);
      if (reply) await input.engine.channels.send(command.channel, reply.text, reply.parent, reply.blocks);
    },
    onAction: async (action) => {
      const reply = echoActionReply(action);
      if (reply) await input.engine.channels.send(action.channel, reply.text, reply.parent, reply.blocks);
    },
  });
}
