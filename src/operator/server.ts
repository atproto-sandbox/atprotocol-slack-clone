import type { ServerResponse } from "node:http";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createServer, XRPCError } from "@atproto/xrpc-server";
import { schemas } from "@/lexicons/api/lexicons";
import { describeRepoFailure } from "@/atproto/repo-failure";
import { getConfig, isLoopback } from "@/lib/config";
import { OPERATOR_SECURITY_HEADERS } from "@/lib/security-headers";
import { oauthFlowCookieName } from "@/auth/oauth-flow";
import { AUTHORITY_FLOW_PATHS, authorityClientMetadata, authorityPublicJwks, beginAuthorityFlow, completeAuthorityFlow } from "./authority-grant";
import { describeFailure, OPERATOR_METHODS, type OperatorMethodDefinition } from "./methods";

// The operator as its own service (R7): its XRPC methods on `@atproto/xrpc-server`, checked against the app's lexicons, and on
// the same Express app the paths a browser navigates to (the authority flow) and the `did:web` document that names it.

/** How long a browser may keep a CORS preflight answer. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * The operator's HTTP app, serving `methods` (the operator's own; a test may serve others). The web origin (`APP_URL`) may
 * call them from a browser; nothing else may.
 */
export function createOperatorApp(methods: Readonly<Record<string, OperatorMethodDefinition>> = OPERATOR_METHODS): Express {
  const { appUrl, operatorUrl, operatorServiceRef } = getConfig();
  const app = express();
  app.disable("x-powered-by");
  // Express's own error page shows no stack, whatever NODE_ENV says: the operator is never a development server for Express.
  app.set("env", "production");
  app.use((_req, res, next) => {
    for (const { key, value } of OPERATOR_SECURITY_HEADERS) res.set(key, value);
    next();
  });
  app.use("/xrpc", allowWebOrigin(appUrl.origin));

  app.get("/.well-known/did.json", (_req, res) => {
    const hash = operatorServiceRef.indexOf("#");
    const id = operatorServiceRef.slice(0, hash);
    res.set("cache-control", "public, max-age=300").json({
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
      id,
      service: [{ id: `${id}#${operatorServiceRef.slice(hash + 1)}`, type: "AtprotoFlockOperator", serviceEndpoint: operatorUrl.origin }],
    });
  });
  app.get(AUTHORITY_FLOW_PATHS.clientMetadata, (_req, res) => {
    res.set("cache-control", "public, max-age=300").json(authorityClientMetadata());
  });
  app.get(AUTHORITY_FLOW_PATHS.jwks, (_req, res) => {
    res.set("cache-control", "public, max-age=300").json(authorityPublicJwks());
  });
  // Only a real navigation may consume a ticket; a HEAD (a link preview, a prefetch) would otherwise be answered by GET.
  app.head(AUTHORITY_FLOW_PATHS.start, (_req, res) => {
    res.set("allow", "GET").status(405).end();
  });
  // A top-level navigation carrying a ticket: binds this browser to one authority flow and sends it to the PDS.
  app.get(AUTHORITY_FLOW_PATHS.start, (req, res, next) => {
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
    beginAuthorityFlow(ticket).then((flow) => {
      res.cookie(flow.cookieName, flow.cookieValue, flowCookie(15 * 60 * 1000)).redirect(flow.url.toString());
    }, () => res.redirect(new URL("/?authority=failed", appUrl).toString())).catch(next);
  });
  // The PDS returns here. Only a result code goes back to the web app; the grant stays with the operator.
  app.get(AUTHORITY_FLOW_PATHS.callback, (req, res, next) => {
    const params = new URLSearchParams(Object.entries(req.query).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const cookieName = oauthFlowCookieName(params.get("state") ?? "");
    completeAuthorityFlow(params, cookieOf(req, cookieName)).then(
      () => new URL("/", appUrl),
      () => new URL("/?authority=failed", appUrl),
    ).then((target) => res.cookie(cookieName, "", flowCookie(0)).redirect(target.toString())).catch(next);
  });

  // Answers are checked against the lexicons in loopback development, as the PDS checks them in dev mode. A deployed operator
  // does not: there a nonconforming answer to a write that already committed would become an error the caller retries.
  const xrpc = createServer(schemas, { validateResponse: isLoopback(operatorUrl.hostname) });
  xrpc.router.disable("x-powered-by");
  for (const [nsid, method] of Object.entries(methods)) {
    xrpc.method(nsid, {
      opts: method.jsonLimit ? { jsonLimit: method.jsonLimit } : undefined,
      handler: async ({ req, res, params, input }) => {
        try {
          const body = await method.serve({ authorization: req.headers.authorization, params, body: input?.body, signal: callerLeaves(res) });
          // A method whose lexicon declares no output answers with no body.
          return body === undefined ? undefined : { encoding: "application/json", body, headers: { "cache-control": "no-store" } };
        } catch (error) {
          const failure = describeFailure(error, method.unexpected);
          if (failure.unnamed) console.error(unexpectedFailureLine(nsid, error));
          throw new XRPCError(failure.status, failure.message, failure.error);
        }
      },
    });
  }
  app.use(xrpc.router);
  return app;
}

/**
 * A failure no method names, for the log: its class, status and code (`describeRepoFailure`) and where it was thrown, never
 * its message or its other fields, which a host may have written (an upstream answer, an OAuth error's response).
 */
function unexpectedFailureLine(nsid: string, cause: unknown): string {
  return [`operator method ${nsid} failed: ${describeRepoFailure(cause)}`, ...thrownAt(cause)].join("\n");
}

/**
 * The stack frames below an error's header (`Name: message`, as many lines as the message has). An error whose stack does not
 * begin with its own message (its name or message changed after the stack was taken, or a stack set by hand) gives none,
 * since its lines past the header might be the message.
 */
function thrownAt(cause: unknown): string[] {
  if (!(cause instanceof Error) || typeof cause.stack !== "string" || typeof cause.message !== "string") return [];
  const lines = cause.stack.split("\n");
  const headerLines = cause.message.split("\n").length;
  if (!lines.slice(0, headerLines).join("\n").endsWith(cause.message)) return [];
  return lines.slice(headerLines).filter((line) => /^\s+at /.test(line)).slice(0, 10).map((line) => line.slice(0, 200));
}

/**
 * Aborts when the caller goes away before its answer is sent. xrpc-server aborts its own signal only for queries, since a
 * procedure may write; the change feed is a procedure (it takes the spaces to follow as input) that only waits.
 */
function callerLeaves(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const leave = () => {
    if (!res.writableFinished) controller.abort();
  };
  if (res.destroyed) leave();
  else res.once("close", leave);
  return controller.signal;
}

/** The authority flow's cookie: host-only on the operator's origin, sent back only to its callback, top-level navigations included. */
function flowCookie(maxAge: number) {
  return { httpOnly: true, secure: getConfig().operatorUrl.protocol === "https:", sameSite: "lax" as const, path: AUTHORITY_FLOW_PATHS.callback, maxAge };
}

/** A cookie's value; one that is not valid percent-encoding is no flow cookie, so the flow fails as it would without one. */
function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** CORS for the one web origin: its browsers call the methods with a bearer service token, so the preflight admits that header. */
function allowWebOrigin(origin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.vary("origin");
    if (req.headers.origin === origin) {
      res.set("access-control-allow-origin", origin);
      if (req.method === "OPTIONS") {
        res.set({
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": String(PREFLIGHT_MAX_AGE_SECONDS),
        }).status(204).end();
        return;
      }
    }
    next();
  };
}
