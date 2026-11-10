import type { OperationContext } from "../journal";
import type { OperatorActor } from "../actor";

export type OperatorRequest = Record<string, unknown> & { kind: string };

/**
 * One kind of journaled operator operation. A persisted kind is replayed from its journal row by name and request hash, so
 * its name, its request fields and its step names never change once released; a new shape is a new kind.
 */
export type OperationKind = {
  kind: string;
  /** The fields its request carries besides `kind` (and the lexicon `$type`). */
  required: readonly string[];
  optional?: readonly string[];
  /** Who may start it: the workspace's authority only; any active admin; or, besides any admin, an active member it concerns. */
  actor: "authority" | "admin" | "member";
  /** Where it is submitted: the operator's execute method, or workspace creation. */
  submittedThrough: "execute" | "createWorkspace";
  /** The step names it may record; `{…}` stands for a value (a DID, a channel key). */
  steps: readonly string[];
  /** Checks of request values that the shared field rules cannot make. */
  validate?(request: OperatorRequest): void;
  /** For a member-started kind: checks against current PDS state that this member may run it. */
  authorizeMember?(actor: OperatorActor, request: OperatorRequest): Promise<void>;
  /**
   * Whether running this request takes away the role that let `actorDid` start it. Only such a request may be sent again by
   * a submitter the workspace's current state refuses, since a retry of it has to get past that refusal.
   */
  endsOwnRole?(request: OperatorRequest, actorDid: string): boolean;
  run(actor: OperatorActor, context: OperationContext, request: OperatorRequest): Promise<void>;
};
