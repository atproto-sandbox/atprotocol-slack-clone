export type NormalizedLexiconSchema = {
  lexicon: number;
  id: string;
  revision?: number;
  description?: string;
  defs: Record<string, unknown>;
};

export type VendoredLexiconEntry = {
  id: string;
  authority: string;
  dnsHostname: string;
  schema: NormalizedLexiconSchema;
  filePath: string;
};

export function nsidAuthorityDomain(nsid: string): string;
export function lexiconDnsHostname(nsid: string): string;
export function parseLexiconDnsTxt(chunkedRecords: string[][]): string | null;
export function normalizeLexiconSchemaDocument(doc: Record<string, unknown>): NormalizedLexiconSchema;
export function loadVendoredPublicLexicons(repoRoot?: string): VendoredLexiconEntry[];

export function verifyPublicLexicons(options?: {
  repoRoot?: string;
  resolveTxt?: (hostname: string) => Promise<string[][]>;
  dnsServers?: string[];
  dnsTimeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  plcUrl?: string;
  allowHttp?: boolean;
  allowLoopback?: boolean;
}): Promise<{
  totalLexicons: number;
  verifiedCount: number;
  authorities: Record<string, string>;
}>;
