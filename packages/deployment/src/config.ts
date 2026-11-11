import { isIP } from "node:net";

/**
 * What the web app and the operator both read from the environment, with the same rules: the web origin, the operator's own
 * URL, the PLC and the operator's DID. What only the operator reads is in `@flock/operator/config`.
 */
export type AppConfig = {
  appUrl: URL;
  /** Where the operator serves its methods, its authority flow and its `did:web` document. */
  operatorUrl: URL;
  plcDirectoryUrl: URL;
  operatorServiceRef: string;
};

/** The variables `getConfig` reads: everything the web app takes from its environment. */
export const SHARED_ENVIRONMENT = ["APP_URL", "OPERATOR_URL", "PLC_URL", "OPERATOR_SERVICE_REF"] as const;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const operatorServiceRef = process.env.OPERATOR_SERVICE_REF ?? "";
  if (!/^did:[a-z0-9]+:[^#]+#[a-zA-Z0-9_-]+$/.test(operatorServiceRef)) {
    throw new Error("OPERATOR_SERVICE_REF must be a DID service reference with a fragment.");
  }

  const appUrl = serviceUrl("APP_URL", process.env.APP_URL ?? "http://127.0.0.1:3000");
  // The operator's default is loopback development's; a deployed web app names its operator.
  const operatorInput = process.env.OPERATOR_URL ?? (isLoopback(appUrl.hostname) ? "http://127.0.0.1:3001" : undefined);
  if (operatorInput === undefined) throw new Error("OPERATOR_URL is required outside loopback development.");
  const operatorUrl = serviceUrl("OPERATOR_URL", operatorInput);
  cached = {
    appUrl,
    operatorUrl,
    plcDirectoryUrl: absoluteUrl("PLC_URL", process.env.PLC_URL ?? "https://plc.directory"),
    operatorServiceRef,
  };
  return cached;
}

/**
 * A URL a browser reaches: HTTPS, except for loopback development. There the OAuth loopback redirect URI must be an IP
 * literal, so `localhost` becomes 127.0.0.1 and the browser stays on the origin its host-only OAuth flow cookies are for;
 * an IP literal (127.0.0.1, or [::1] for a second site) is kept.
 */
function serviceUrl(name: string, input: string): URL {
  const url = absoluteUrl(name, input);
  const local = isLoopback(url.hostname);
  if (!local && url.protocol !== "https:") throw new Error(`${name} must use HTTPS outside loopback development.`);
  if (local && url.protocol === "http:" && url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url;
}

function absoluteUrl(name: string, input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS.`);
  }
  return url;
}

/** Whether a URL's hostname is this machine: loopback development. */
export function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}
