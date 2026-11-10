export class AdminMutationsPausedError extends Error {
  readonly status = 423;

  constructor() {
    super("Workspace admin mutations are paused.");
    this.name = "AdminMutationsPausedError";
  }
}

export function assertAdminMutationsEnabled(): void {
  if (process.env.FLOCK_ADMIN_MUTATIONS_PAUSED === "true") throw new AdminMutationsPausedError();
}
