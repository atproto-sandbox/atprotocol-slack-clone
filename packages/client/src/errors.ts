/** A channel the directory marks as transitioning or archived: no new reads or writes until it is public or private again. */
export class ChannelUnavailableError extends Error {
  constructor(message: string, readonly visibility: "transitioning" | "archived") {
    super(message);
    this.name = "ChannelUnavailableError";
  }
}
