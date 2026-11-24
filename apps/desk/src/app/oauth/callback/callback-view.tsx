"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Banner, Card, Text, VStack } from "@astryxdesign/core";
import { signedInDeskDid, type DeskSessionConfig } from "@flock/shell";

export type DeskCallbackViewProps = {
  config: DeskSessionConfig;
};

export function DeskCallbackView({ config }: DeskCallbackViewProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    signedInDeskDid(config)
      .then((did) => {
        if (cancelled) return;
        if (did) {
          router.replace("/");
        } else {
          setError("Sign-in did not complete. Return to Flock Desk and try again.");
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "Could not finish signing in.");
      });
    return () => {
      cancelled = true;
    };
  }, [config, router]);

  return (
    <main className="desk-signin-stage" data-testid="desk-oauth-callback">
      <Card maxWidth={440} width="100%" padding={6}>
        <VStack gap={3}>
          {error ? (
            <>
              <Banner status="error" title={error} role="alert" />
              <Link href="/">Back to Flock Desk →</Link>
            </>
          ) : (
            <Text role="status">Completing ATProto sign-in…</Text>
          )}
        </VStack>
      </Card>
    </main>
  );
}
