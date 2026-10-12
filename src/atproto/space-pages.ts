import type * as ListSpaces from "@/lexicons/api/types/com/atproto/space/listSpaces";
import type { AtprotoClient } from "./xrpc";

const MAX_SCAN_PAGES = 128;

export async function listBoundedSpaces(
  client: AtprotoClient,
  input: { spaceType: string; maxSpaces: number },
): Promise<string[]> {
  if (!Number.isSafeInteger(input.maxSpaces) || input.maxSpaces < 1) throw new RangeError("Workspace scan limit must be a positive safe integer.");
  const spaces: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const previousCursor = cursor;
    const limit = Math.min(100, input.maxSpaces - spaces.length);
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS workspace pagination exceeded the bounded page limit.");
    const page = await client.query<ListSpaces.OutputSchema>("com.atproto.space.listSpaces", { spaceType: input.spaceType, limit, cursor });
    if (!Array.isArray(page.spaces) || page.spaces.length > limit) throw new Error("PDS workspace page exceeded the requested limit.");
    spaces.push(...page.spaces.map(({ uri }) => uri));
    cursor = page.cursor;
    if (page.spaces.length === 0 && cursor && cursor === previousCursor) throw new Error("PDS workspace pagination did not advance.");
  } while (cursor && spaces.length < input.maxSpaces);

  if (cursor) {
    if (++pages > MAX_SCAN_PAGES) throw new Error("PDS workspace pagination exceeded the bounded page limit.");
    const lookahead = await client.query<ListSpaces.OutputSchema>("com.atproto.space.listSpaces", { spaceType: input.spaceType, limit: 1, cursor });
    if (!Array.isArray(lookahead.spaces) || lookahead.spaces.length > 1) throw new Error("PDS workspace page exceeded the requested limit.");
    if (lookahead.spaces.length === 0 && lookahead.cursor) throw new Error("PDS workspace pagination did not terminate at the scan boundary.");
    if (lookahead.spaces.length > 0) throw new Error(`Account workspace list exceeds the ${input.maxSpaces}-space discovery limit.`);
  }
  return spaces;
}
