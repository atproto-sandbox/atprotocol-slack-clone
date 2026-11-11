import { listStalledOperations, type StalledOperations } from "./journal";
import { registrationProblems, type RegistrationProblem } from "./registrations";

export type StalledWork = StalledOperations & { registrations: RegistrationProblem[] };

/** What a workspace's admins should look at: operations that have not moved for five minutes, and spaces whose change-notice registration failed or ran out. */
export function listStalledWork(workspaceDid: string, workspaceUri: string): StalledWork {
  return { ...listStalledOperations(workspaceDid, workspaceUri), registrations: registrationProblems(workspaceUri) };
}
