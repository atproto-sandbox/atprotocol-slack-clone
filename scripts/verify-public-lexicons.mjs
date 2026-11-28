import * as dnsPromises from "node:dns/promises";
import { readdirSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const {
  boundedSafeFetch,
  isLoopbackHost,
  UpstreamContentTypeError,
  UpstreamResponseTooLargeError,
} = await tsImport("../packages/net/src/safe-fetch.ts", import.meta.url);

const DNS_SUBDOMAIN = "_lexicon";
const DNS_PREFIX = "did=";
const LEXICON_SCHEMA_COLLECTION = "com.atproto.lexicon.schema";
const DNS_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const EXPECTED_MIME_TYPES = ["application/json", "application/did+ld+json", "application/did+json"];
const EXPECTED_MIME_SET = new Set(EXPECTED_MIME_TYPES);

const DID_RE = /^did:(?:plc:[a-z2-7]{24}|web:[a-zA-Z0-9._:%-]+)$/;
const NSID_RE = /^[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(\.[a-zA-Z]([a-zA-Z0-9]{0,62})?)$/;

const NON_PUBLIC_IP_BLOCKLIST = (() => {
  const blocked = new BlockList();
  for (const [address, prefix, family] of [
    ["0.0.0.0", 8, "ipv4"],
    ["10.0.0.0", 8, "ipv4"],
    ["100.64.0.0", 10, "ipv4"],
    ["127.0.0.0", 8, "ipv4"],
    ["169.254.0.0", 16, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.0.0.0", 24, "ipv4"],
    ["192.0.2.0", 24, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["198.18.0.0", 15, "ipv4"],
    ["198.51.100.0", 24, "ipv4"],
    ["203.0.113.0", 24, "ipv4"],
    ["224.0.0.0", 4, "ipv4"],
    ["240.0.0.0", 4, "ipv4"],
    ["192.88.99.0", 24, "ipv4"],
    ["::", 96, "ipv6"],
    ["::ffff:0:0", 96, "ipv6"],
    ["64:ff9b::", 96, "ipv6"],
    ["64:ff9b:1::", 48, "ipv6"],
    ["100::", 64, "ipv6"],
    ["2001::", 32, "ipv6"],
    ["2001:2::", 48, "ipv6"],
    ["2001:db8::", 32, "ipv6"],
    ["2002::", 16, "ipv6"],
    ["fc00::", 7, "ipv6"],
    ["fe80::", 10, "ipv6"],
    ["ff00::", 8, "ipv6"],
  ]) {
    blocked.addSubnet(address, prefix, family);
  }
  return blocked;
})();

function normalizeMimeType(headerValue) {
  if (!headerValue) return "";
  return (headerValue.split(";")[0] ?? "").trim().toLowerCase();
}

function assertSafeTargetUrl(rawUrl, allowLoopback, label) {
  let parsed;
  try {
    parsed = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(String(rawUrl));
  } catch {
    throw new Error(`Invalid ${label} URL: ${String(rawUrl)}`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`Unsafe ${label} URL (credentials or fragment forbidden): ${parsed.toString()}`);
  }
  const loopback = isLoopbackHost(hostname);
  if (parsed.protocol !== "https:" && !(allowLoopback && loopback && parsed.protocol === "http:")) {
    throw new Error(`${label} URL must use HTTPS (got ${parsed.protocol} for ${parsed.origin}).`);
  }
  if (!allowLoopback && (loopback || hostname.endsWith(".local"))) {
    throw new Error(`${label} URL points to a non-public loopback/local host: ${parsed.origin}`);
  }
  const ipFamily = isIP(hostname);
  if (ipFamily !== 0) {
    const isBlocked = NON_PUBLIC_IP_BLOCKLIST.check(hostname, ipFamily === 4 ? "ipv4" : "ipv6");
    if (isBlocked && !(allowLoopback && loopback)) {
      throw new Error(`${label} URL resolves to a non-public IP address: ${hostname}`);
    }
  }
  return parsed;
}

function createInjectedBoundedFetch(fetchImpl, allowLoopback) {
  return async (input, init = {}) => {
    const reqUrl = assertSafeTargetUrl(
      typeof input === "string" || input instanceof URL ? input : input.url,
      allowLoopback,
      "upstream request",
    );
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetchImpl(reqUrl.toString(), {
      ...init,
      redirect: "error",
      signal,
    });

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Upstream HTTP redirect (${response.status}) is forbidden for ${reqUrl.toString()}.`);
    }

    const contentLengthRaw = response.headers.get("content-length");
    if (contentLengthRaw !== null && contentLengthRaw.trim() !== "") {
      const contentLength = Number(contentLengthRaw);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new UpstreamResponseTooLargeError(
          `Upstream response Content-Length (${contentLength}) exceeds maxBytes (${MAX_RESPONSE_BYTES}).`,
        );
      }
    }

    const mime = normalizeMimeType(response.headers.get("content-type"));
    if (response.ok && !EXPECTED_MIME_SET.has(mime)) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamContentTypeError(
        `Upstream response Content-Type ${JSON.stringify(mime)} is not in allowed types [${EXPECTED_MIME_TYPES.join(", ")}].`,
      );
    }

    if (!response.body) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          const err = new UpstreamResponseTooLargeError(
            `Upstream response body exceeded maxBytes (${MAX_RESPONSE_BYTES}).`,
          );
          await reader.cancel(err).catch(() => {});
          throw err;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(combined, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function nsidAuthorityDomain(nsid) {
  if (typeof nsid !== "string" || !NSID_RE.test(nsid)) {
    throw new Error(`Invalid NSID: ${String(nsid)}`);
  }
  const segments = nsid.split(".");
  if (segments.length < 3) {
    throw new Error(`NSID must have at least 3 segments: ${nsid}`);
  }
  return segments.slice(0, -1).reverse().join(".").toLowerCase();
}

export function lexiconDnsHostname(nsid) {
  return `${DNS_SUBDOMAIN}.${nsidAuthorityDomain(nsid)}`;
}

export function parseLexiconDnsTxt(chunkedRecords) {
  if (!Array.isArray(chunkedRecords)) return null;
  const joined = chunkedRecords.map((chunks) => (Array.isArray(chunks) ? chunks.join("") : String(chunks)));
  const matches = joined.filter((txt) => txt.startsWith(DNS_PREFIX));
  if (matches.length !== 1) return null;
  const did = matches[0].slice(DNS_PREFIX.length).trim();
  if (!DID_RE.test(did)) return null;
  return did;
}

function canonicalizeValue(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeValue(v)}`).join(",")}}`;
}

export function normalizeLexiconSchemaDocument(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Lexicon schema document must be an object.");
  }
  return {
    lexicon: doc.lexicon,
    id: doc.id,
    ...(doc.revision !== undefined ? { revision: doc.revision } : {}),
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    defs: doc.defs,
  };
}

function walkJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(fullPath);
    }
  }
  return out;
}

export function loadVendoredPublicLexicons(repoRoot) {
  const root = resolve(repoRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const roots = [
    join(root, "packages/protocol/lexicons/new/flock"),
    join(root, "packages/protocol/lexicons/org/atgrp"),
  ];
  const byId = new Map();
  for (const lexDir of roots) {
    for (const filePath of walkJsonFiles(lexDir)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (typeof parsed.id !== "string" || parsed.lexicon !== 1) {
        throw new Error(`Invalid local lexicon file ${filePath}`);
      }
      if (byId.has(parsed.id)) {
        throw new Error(`Duplicate local lexicon id ${parsed.id}`);
      }
      byId.set(parsed.id, {
        id: parsed.id,
        authority: nsidAuthorityDomain(parsed.id),
        dnsHostname: lexiconDnsHostname(parsed.id),
        schema: normalizeLexiconSchemaDocument(parsed),
        filePath,
      });
    }
  }
  const sorted = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const hostnames = new Set(sorted.map((entry) => entry.dnsHostname));
  for (const requiredHost of [
    "_lexicon.flock.new",
    "_lexicon.group.flock.new",
    "_lexicon.atgrp.org",
    "_lexicon.mod.atgrp.org",
  ]) {
    if (!hostnames.has(requiredHost)) {
      throw new Error(
        `Vendored lexicon manifest must include ${requiredHost} authority.`,
      );
    }
  }
  return sorted;
}

async function resolveDidPdsEndpoint(authorityDid, { plcUrl, safeFetchJson, allowLoopback }) {
  let docUrl;
  if (authorityDid.startsWith("did:plc:")) {
    const parsedPlc = assertSafeTargetUrl(plcUrl, allowLoopback, "PLC directory");
    if (parsedPlc.search) {
      throw new Error(`PLC directory URL must not contain query parameters: ${plcUrl}`);
    }
    docUrl = `${plcUrl.replace(/\/$/, "")}/${encodeURIComponent(authorityDid)}`;
  } else if (authorityDid.startsWith("did:web:")) {
    const rawHost = authorityDid.slice("did:web:".length);
    if (rawHost.includes(":")) {
      throw new Error(`Invalid unencoded colon in did:web identifier: ${authorityDid}`);
    }
    const hostPort = decodeURIComponent(rawHost);
    const probeHost = hostPort.replace(/:\d+$/, "");
    const scheme = allowLoopback && isLoopbackHost(probeHost) ? "http" : "https";
    const candidate = assertSafeTargetUrl(`${scheme}://${hostPort}/.well-known/did.json`, allowLoopback, "did:web document");
    if (candidate.pathname !== "/.well-known/did.json" || candidate.search) {
      throw new Error(`Invalid did:web host in identifier: ${authorityDid}`);
    }
    docUrl = candidate.toString();
  } else {
    throw new Error(`Unsupported DID method for lexicon authority: ${authorityDid}`);
  }

  const response = await safeFetchJson(docUrl, {
    headers: { accept: "application/did+ld+json, application/did+json, application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to resolve DID document for ${authorityDid} (${response.status} from ${docUrl}).`);
  }
  const doc = await response.json();
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`DID document for ${authorityDid} must be a JSON object.`);
  }
  if (doc.id !== authorityDid) {
    throw new Error(
      `DID document identity mismatch for ${authorityDid}: document id is ${JSON.stringify(doc.id)}.`,
    );
  }

  const services = Array.isArray(doc.service) ? doc.service : [];
  const pdsService = services.find(
    (svc) => svc && typeof svc === "object" && (svc.id === "#atproto_pds" || svc.id === `${authorityDid}#atproto_pds`),
  );
  if (!pdsService) {
    throw new Error(`DID document for ${authorityDid} has no #atproto_pds service.`);
  }
  if (pdsService.type !== "AtprotoPersonalDataServer") {
    throw new Error(
      `DID document for ${authorityDid} #atproto_pds service must have type "AtprotoPersonalDataServer" (got ${JSON.stringify(pdsService.type)}).`,
    );
  }
  const endpoint = pdsService.serviceEndpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error(`DID document for ${authorityDid} has no #atproto_pds serviceEndpoint.`);
  }
  const parsedEndpoint = assertSafeTargetUrl(endpoint, allowLoopback, `PDS serviceEndpoint for ${authorityDid}`);
  if (parsedEndpoint.pathname !== "/" || parsedEndpoint.search) {
    throw new Error(
      `Lexicon authority PDS serviceEndpoint for ${authorityDid} must be a bare origin URL: ${endpoint}`,
    );
  }
  return parsedEndpoint.origin;
}

function resolveTxtWithTimeout(hostname, timeoutMs, customResolveTxt, dnsServers) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let resolver = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        resolver?.cancel();
      } catch {
        // Best-effort cancellation of active c-ares query.
      }
      const timeoutErr = new Error(`DNS TXT lookup for ${hostname} timed out after ${timeoutMs}ms`);
      timeoutErr.code = "ETIMEOUT";
      rejectPromise(timeoutErr);
    }, timeoutMs);

    let queryPromise;
    try {
      if (customResolveTxt) {
        queryPromise = Promise.resolve().then(() => customResolveTxt(hostname));
      } else {
        resolver = new dnsPromises.Resolver();
        if (Array.isArray(dnsServers) && dnsServers.length > 0) {
          resolver.setServers(dnsServers);
        }
        queryPromise = resolver.resolveTxt(hostname);
      }
    } catch (err) {
      clearTimeout(timer);
      settled = true;
      rejectPromise(err);
      return;
    }

    queryPromise.then(
      (records) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolvePromise(records);
      },
      (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        rejectPromise(err);
      },
    );
  });
}

export async function verifyPublicLexicons(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const dnsTimeoutMs =
    typeof options.dnsTimeoutMs === "number" && Number.isFinite(options.dnsTimeoutMs) && options.dnsTimeoutMs > 0
      ? options.dnsTimeoutMs
      : DNS_TIMEOUT_MS;
  const resolveTxt = (hostname) =>
    resolveTxtWithTimeout(hostname, dnsTimeoutMs, options.resolveTxt, options.dnsServers);
  const plcUrl = options.plcUrl ?? process.env.PLC_URL ?? "https://plc.directory";
  const allowLoopback = options.allowLoopback === true || options.allowHttp === true;

  const safeFetchJson = options.fetchImpl
    ? createInjectedBoundedFetch(options.fetchImpl, allowLoopback)
    : boundedSafeFetch(() => allowLoopback, {
        deadlineMs: FETCH_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        allowedContentTypes: EXPECTED_MIME_TYPES,
      });

  const lexicons = loadVendoredPublicLexicons(repoRoot);
  const errors = [];
  const authorityDidByHostname = new Map();
  const pdsOriginByDid = new Map();

  const uniqueHostnames = [...new Set(lexicons.map((l) => l.dnsHostname))].sort();
  for (const hostname of uniqueHostnames) {
    try {
      const txtRecords = await resolveTxt(hostname);
      const did = parseLexiconDnsTxt(txtRecords);
      if (!did) {
        errors.push(
          `${hostname}: expected exactly one valid TXT record of the form "did=did:plc:..." or "did=did:web:..."`,
        );
        continue;
      }
      authorityDidByHostname.set(hostname, did);
      if (!pdsOriginByDid.has(did)) {
        const pdsOrigin = await resolveDidPdsEndpoint(did, {
          plcUrl,
          safeFetchJson,
          allowLoopback,
        });
        pdsOriginByDid.set(did, pdsOrigin);
      }
    } catch (err) {
      errors.push(`${hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let verifiedCount = 0;
  for (const entry of lexicons) {
    const authorityDid = authorityDidByHostname.get(entry.dnsHostname);
    if (!authorityDid) continue;
    const pdsOrigin = pdsOriginByDid.get(authorityDid);
    if (!pdsOrigin) continue;

    const recordUrl = new URL("/xrpc/com.atproto.repo.getRecord", pdsOrigin);
    recordUrl.searchParams.set("repo", authorityDid);
    recordUrl.searchParams.set("collection", LEXICON_SCHEMA_COLLECTION);
    recordUrl.searchParams.set("rkey", entry.id);

    try {
      const response = await safeFetchJson(recordUrl.toString(), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        errors.push(
          `${entry.id}: XRPC getRecord from ${pdsOrigin} (${authorityDid}) failed with HTTP ${response.status}`,
        );
        continue;
      }
      const payload = await response.json();
      if (
        payload?.uri !== undefined &&
        payload.uri !== `at://${authorityDid}/${LEXICON_SCHEMA_COLLECTION}/${entry.id}`
      ) {
        errors.push(
          `${entry.id}: unexpected record URI ${String(payload.uri)} from ${authorityDid}`,
        );
        continue;
      }
      const recordValue = payload?.value;
      if (!recordValue || typeof recordValue !== "object") {
        errors.push(`${entry.id}: missing record.value in getRecord response`);
        continue;
      }
      if (recordValue.$type !== undefined && recordValue.$type !== LEXICON_SCHEMA_COLLECTION) {
        errors.push(`${entry.id}: unexpected $type ${String(recordValue.$type)}`);
        continue;
      }
      const remoteNormalized = normalizeLexiconSchemaDocument(recordValue);
      if (remoteNormalized.id !== entry.id) {
        errors.push(`${entry.id}: remote schema id (${String(remoteNormalized.id)}) does not match NSID`);
        continue;
      }
      const expectedCanonical = canonicalizeValue(entry.schema);
      const actualCanonical = canonicalizeValue(remoteNormalized);
      if (expectedCanonical !== actualCanonical) {
        errors.push(`${entry.id}: published schema at ${authorityDid} differs from local vendored lexicon`);
        continue;
      }
      verifiedCount += 1;
    } catch (err) {
      errors.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    const summary = [
      `Public lexicon verification failed (${errors.length} error(s) across ${lexicons.length} schemas):`,
      ...errors.map((line) => `  - ${line}`),
    ].join("\n");
    const failure = new Error(summary);
    failure.errors = errors;
    throw failure;
  }

  return {
    totalLexicons: lexicons.length,
    verifiedCount,
    authorities: Object.fromEntries(authorityDidByHostname),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyPublicLexicons()
    .then((result) => {
      process.stdout.write(
        `Verified ${result.verifiedCount}/${result.totalLexicons} public lexicons across ${Object.keys(result.authorities).length} DNS authorities.\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
