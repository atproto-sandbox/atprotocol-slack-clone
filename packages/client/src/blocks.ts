import { channelUri } from "@flock/protocol/keys";
import { BLOCK_TYPE, COLLECTION, type BlockType } from "@flock/protocol/nsids";
import { validateSpaceRecord, type RecordValidation } from "@flock/protocol/registry";

export { BLOCK_TYPE, type BlockType, type RecordValidation };

export type ButtonStyle = "primary" | "danger";

export type ButtonElement = {
  $type?: typeof BLOCK_TYPE.button;
  actionId: string;
  label: string;
  value?: string;
  style?: ButtonStyle;
};

export type SectionBlock = {
  $type: typeof BLOCK_TYPE.section;
  text: string;
};

export type ContextBlock = {
  $type: typeof BLOCK_TYPE.context;
  elements: string[];
};

export type DividerBlock = {
  $type: typeof BLOCK_TYPE.divider;
};

export type ActionsBlock = {
  $type: typeof BLOCK_TYPE.actions;
  elements: ButtonElement[];
};

export type MessageBlock = SectionBlock | ContextBlock | DividerBlock | ActionsBlock;

export function sectionBlock(text: string): SectionBlock {
  return { $type: BLOCK_TYPE.section, text };
}

export function contextBlock(elements: readonly string[]): ContextBlock {
  return { $type: BLOCK_TYPE.context, elements: [...elements] };
}

export function dividerBlock(): DividerBlock {
  return { $type: BLOCK_TYPE.divider };
}

export function button(input: { actionId: string; label: string; value?: string; style?: ButtonStyle }): ButtonElement {
  return {
    $type: BLOCK_TYPE.button,
    actionId: input.actionId,
    label: input.label,
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.style === undefined ? {} : { style: input.style }),
  };
}

export function actionsBlock(elements: readonly ButtonElement[]): ActionsBlock {
  return { $type: BLOCK_TYPE.actions, elements: [...elements] };
}

/** Finds a button with `actionId` in a message's `blocks`, accepting `#button` elements with or without an explicit `$type`. */
export function findActionButton(blocks: unknown, actionId: string): ButtonElement | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (!isPlainObject(block) || block.$type !== BLOCK_TYPE.actions || !Array.isArray(block.elements)) continue;
    for (const element of block.elements) {
      if (!isPlainObject(element)) continue;
      if (element.$type !== undefined && element.$type !== BLOCK_TYPE.button) continue;
      if (element.actionId === actionId && typeof element.label === "string") {
        return {
          ...(element.$type === BLOCK_TYPE.button ? { $type: BLOCK_TYPE.button } : {}),
          actionId,
          label: element.label,
          ...(typeof element.value === "string" ? { value: element.value } : {}),
          ...(element.style === "primary" || element.style === "danger" ? { style: element.style } : {}),
        };
      }
    }
  }
  return null;
}

const VALIDATION_AUTHORITY = "did:plc:validate";
const VALIDATION_CHANNEL = channelUri(VALIDATION_AUTHORITY, "general");
const VALIDATION_RKEY = "2222222222222";
const VALIDATION_CREATED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Synchronously validates `{ text, blocks? }` (and no other fields) against the channel message lexicon, semantic block rules
 * and `MAX_RECORD_BYTES` bound, before any network request is made.
 */
export function validateMessageInput(input: unknown): RecordValidation {
  if (!isPlainObject(input)) return { valid: false, reason: "message input must be a JSON object" };
  for (const key of Object.keys(input)) {
    if (key !== "text" && key !== "blocks") return { valid: false, reason: `unexpected field: ${key}` };
  }
  const record: Record<string, unknown> = {
    $type: COLLECTION.message,
    text: input.text,
    ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
    createdAt: VALIDATION_CREATED_AT,
  };
  return validateSpaceRecord(COLLECTION.message, record, {
    authorityDid: VALIDATION_AUTHORITY,
    spaceUri: VALIDATION_CHANNEL,
    repoDid: VALIDATION_AUTHORITY,
    rkey: VALIDATION_RKEY,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
