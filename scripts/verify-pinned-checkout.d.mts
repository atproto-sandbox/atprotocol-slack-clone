export const EXPECTED_PIN: {
  readonly commit: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly porcelainStatus: string;
  readonly headObjects: Readonly<Record<string, string>>;
  readonly workingTreeFiles: Readonly<Record<string, string>>;
  readonly distFileCount: number;
  readonly distManifestSha256: string;
};

export function sha256Hex(input: string | Uint8Array): string;

export function computeDistManifest(pinRoot: string): {
  readonly fileCount: number;
  readonly manifestSha256: string;
  readonly files: string[];
};

export function verifyPinnedCheckout(
  pinCheckoutPath: string | undefined,
  options?: {
    repoRoot?: string;
    expected?: Partial<typeof EXPECTED_PIN>;
    force?: boolean;
  },
): string;
