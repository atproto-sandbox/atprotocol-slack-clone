import { isTransientOAuthInfrastructureError } from "@/auth/oauth-request-lock";
import { isScopeMissingError, XrpcError } from "@/atproto/xrpc";
import { UpstreamResponseTooLargeError } from "@/lib/bounded-json";
import { TokenRefreshError } from "@atproto/oauth-client-node";
import { AuthorityReauthorizationRequiredError } from "./authority-grant";
import { isTransientOperationError } from "./journal";

export class OperatorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorAuthError";
  }
}

export class OperatorInfrastructureError extends Error {
  constructor(message = "A temporary identity or PDS failure prevented this request.") {
    super(message);
    this.name = "OperatorInfrastructureError";
  }
}

export function isTransientOperatorInfrastructureError(error: unknown): boolean {
  return error instanceof OperatorInfrastructureError ||
    isTransientOperationError(error) ||
    isTransientOAuthInfrastructureError(error);
}

/** What an operator method answers when the authority's grant lacks a scope an operation needs: the app asks the authority to approve again. */
export const AUTHORITY_APPROVAL_REQUIRED = {
  status: 502,
  name: "AuthoritySessionUnavailable",
  message: "The workspace authority must approve its permission again before this operation can run.",
} as const;

export function operatorInfrastructureHttpStatus(error: unknown): 502 | 503 | null {
  return operatorHttpFailure(error)?.status ?? null;
}

export function operatorHttpFailure(error: unknown): { status: 502 | 503; name: string; message: string } | null {
  if (error instanceof UpstreamResponseTooLargeError) {
    return {
      status: 502,
      name: "InvalidUpstreamResponse",
      message: "An upstream service returned a response larger than the configured limit.",
    };
  }
  if (isTransientOperatorInfrastructureError(error)) {
    return {
      status: 503,
      name: "UpstreamUnavailable",
      message: "A temporary identity, PDS, or session-store failure prevented this request.",
    };
  }
  if (isScopeMissingError(error)) return AUTHORITY_APPROVAL_REQUIRED;
  if (error instanceof AuthorityReauthorizationRequiredError || error instanceof TokenRefreshError) {
    return {
      status: 502,
      name: "AuthoritySessionUnavailable",
      message: "The workspace authority session was rejected and must be reauthorized.",
    };
  }
  // A valid service-auth request can still fail because the workspace authority's
  // saved OAuth session was rejected upstream. This is a server-side dependency
  // failure, not malformed input from the calling app.
  if (error instanceof XrpcError && (error.status === 401 || error.status === 403)) {
    return {
      status: 502,
      name: "AuthorityAccessRejected",
      message: "The workspace authority PDS rejected the saved session or required permissions.",
    };
  }
  return null;
}
