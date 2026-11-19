import { isDid, isTid, parseSpaceUri } from "@flock/protocol/keys";
import { NOTICE_METHOD } from "@flock/protocol/nsids";

export type WriteNotification = { space: string; repo: string; repoRev: string };

export type ConfirmRegistrationInput = {
  space: string;
  token: string;
  challenge: string;
};

export type SpaceUpdatePayload =
  | { kind: "repoWrite"; repo: string; repoRev: string; spaceRev: string; prevSpaceRev?: string }
  | { kind: "repoRemoved"; repo: string; spaceRev: string; prevSpaceRev?: string }
  | { kind: "registrationExpired"; spaceRev: string }
  | { kind: "spaceDeleted" };

export type SpaceUpdateNotification = {
  space: string;
  token: string;
  update: SpaceUpdatePayload;
};

const MAX_TOKEN_LENGTH = 512;
const MAX_CHALLENGE_LENGTH = 512;
/** The commit digest's size bounds: a sha256 is 32 bytes, and nothing much smaller or larger is one. */
const MIN_DATA_BYTES = 16;
const MAX_DATA_BYTES = 64;

const CONFIRM_KEYS = new Set(["space", "token", "challenge"]);
const UPDATE_ENVELOPE_KEYS = new Set(["space", "token", "update"]);

export const UPDATE_TYPE = {
  repoWrite: "com.atproto.space.defs#repoWrite",
  repoRemoved: "com.atproto.space.defs#repoRemoved",
  registrationExpired: `${NOTICE_METHOD.notifySpaceUpdate}#registrationExpired`,
  spaceDeleted: `${NOTICE_METHOD.notifySpaceUpdate}#spaceDeleted`,
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates `com.atproto.space.confirmRegistration` input (`{ space, token, challenge }`).
 */
export function parseConfirmRegistration(body: unknown): ConfirmRegistrationInput | null {
  if (!isPlainObject(body)) return null;
  if (Object.keys(body).some((key) => !CONFIRM_KEYS.has(key))) return null;
  const { space, token, challenge } = body;
  if (typeof space !== "string" || !parseSpaceUri(space)) return null;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > MAX_CHALLENGE_LENGTH) return null;
  return { space, token, challenge };
}

/**
 * Validates `com.atproto.space.notifySpaceUpdate` (`{ space, token, update }`), checking the outer envelope first
 * (`token` is never inside `update`) and dispatching strictly on `update.$type`.
 */
export function parseSpaceUpdateNotification(body: unknown): SpaceUpdateNotification | null {
  if (!isPlainObject(body)) return null;
  if (Object.keys(body).some((key) => !UPDATE_ENVELOPE_KEYS.has(key))) return null;
  const { space, token, update } = body;
  if (typeof space !== "string" || !parseSpaceUri(space)) return null;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (!isPlainObject(update) || typeof update.$type !== "string") return null;
  if ("token" in update || "space" in update) return null;

  switch (update.$type) {
    case UPDATE_TYPE.repoWrite: {
      const { repo, repoRev, spaceRev, prevSpaceRev, data } = update;
      if (!isDid(repo) || !isTid(repoRev) || !isTid(spaceRev)) return null;
      if (prevSpaceRev !== undefined && !isTid(prevSpaceRev)) return null;
      if (!(data instanceof Uint8Array) || data.byteLength < MIN_DATA_BYTES || data.byteLength > MAX_DATA_BYTES) return null;
      return {
        space,
        token,
        update: {
          kind: "repoWrite",
          repo,
          repoRev,
          spaceRev,
          ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}),
        },
      };
    }
    case UPDATE_TYPE.repoRemoved: {
      const { repo, spaceRev, prevSpaceRev } = update;
      if (!isDid(repo) || !isTid(spaceRev)) return null;
      if (prevSpaceRev !== undefined && !isTid(prevSpaceRev)) return null;
      return {
        space,
        token,
        update: {
          kind: "repoRemoved",
          repo,
          spaceRev,
          ...(prevSpaceRev !== undefined ? { prevSpaceRev } : {}),
        },
      };
    }
    case UPDATE_TYPE.registrationExpired: {
      const { spaceRev } = update;
      if (!isTid(spaceRev)) return null;
      return {
        space,
        token,
        update: {
          kind: "registrationExpired",
          spaceRev,
        },
      };
    }
    case UPDATE_TYPE.spaceDeleted:
      return {
        space,
        token,
        update: { kind: "spaceDeleted" },
      };
    default:
      return null;
  }
}
