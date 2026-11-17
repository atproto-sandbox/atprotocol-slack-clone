import { extSpaceSkey, extSpaceUri } from "./keys";
import { COLLECTION, SPACE_TYPE, type Collection, type SpaceType } from "./nsids";

export type ExtensionId = "tasks";

export type ExtensionManifest = {
  readonly id: ExtensionId;
  readonly name: string;
  readonly description: string;
  readonly spaceType: SpaceType;
  readonly collections: readonly Collection[];
  readonly defaultRoute: string;
};

export const EXTENSIONS: { readonly [K in ExtensionId]: ExtensionManifest } = {
  tasks: {
    id: "tasks",
    name: "Tasks",
    description: "Projects, tasks, causal edits, and comments.",
    spaceType: SPACE_TYPE.tasks,
    collections: [
      COLLECTION.taskProject,
      COLLECTION.taskProjectEdit,
      COLLECTION.task,
      COLLECTION.taskEdit,
      COLLECTION.taskComment,
    ],
    defaultRoute: "ext/tasks",
  },
} as const;

export const EXTENSION_IDS: readonly ExtensionId[] = Object.keys(EXTENSIONS) as ExtensionId[];

export function isExtensionId(value: unknown): value is ExtensionId {
  return typeof value === "string" && Object.hasOwn(EXTENSIONS, value);
}

export function getExtension(id: ExtensionId): ExtensionManifest;
export function getExtension(id: string): ExtensionManifest | undefined;
export function getExtension(id: string): ExtensionManifest | undefined {
  return isExtensionId(id) ? EXTENSIONS[id] : undefined;
}

export function extSpaceSkeyFor(workspaceSkey: string, id: ExtensionId): string {
  return extSpaceSkey(workspaceSkey, id);
}

export function extSpaceUriFor(authorityDid: string, workspaceSkey: string, id: ExtensionId): string {
  const manifest = getExtension(id);
  if (!manifest) {
    throw new Error(`Unknown extension: ${String(id)}`);
  }
  return extSpaceUri(authorityDid, workspaceSkey, manifest.id, manifest.spaceType);
}
