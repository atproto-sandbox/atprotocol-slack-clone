import { httpStatus, messageOf } from "@/app/ui/client-api";
import { createEngine, type Engine } from "@/client/engine";
import type { ChannelRef } from "@/client/channel-client";
import type { OperatorClient } from "@/client/operator-client";
import { actorTransport } from "../../protocol-tests/support/pds-network";
import type { Actor, AppWorld } from "./world";

// The app's engine run in node as one account, over a memory store: the reads that account's browser makes, for probes a page
// cannot time, such as reads racing an operation.

export function engineAs(world: AppWorld, actor: Actor): Engine {
  return createEngine(actorTransport({ plcUrl: world.fixture.plcUrl }, { did: actor.did, accessJwt: actor.accessJwt, pds: { url: actor.pdsUrl } }), {
    operator: { serviceRef: world.operatorServiceRef, endpoint: world.operatorOrigin },
  });
}

/** The app's operator as `actor`'s browser calls it: each method with a service token from the actor's own host. */
export function operatorAs(world: AppWorld, actor: Actor): OperatorClient {
  const { operator } = engineAs(world, actor);
  if (!operator) throw new Error("The engine was built without the operator.");
  return operator;
}

export type ReadProbe = { status: number; error?: string };

/** How reading the channel's newest page ends now: 200, or the status the app gives the refusal. */
export async function probeChannelRead(engine: Engine, ref: ChannelRef): Promise<ReadProbe> {
  try {
    await engine.channels.readPage(ref);
    return { status: 200 };
  } catch (error) {
    const status = httpStatus(error);
    if (status === undefined) throw error;
    return { status, error: messageOf(error) };
  }
}
