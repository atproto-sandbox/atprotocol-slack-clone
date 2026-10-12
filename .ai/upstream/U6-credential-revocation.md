# Space credentials: expire exactly at `exp`

Status against `5b95b2f2`: revocation, a shorter default and a lifetime ceiling now exist upstream. Only item 1 below remains.

## Summary
In the pinned implementation a space credential is still accepted for about five seconds after `exp`, because the verifier applies the general clock-skew allowance to every token type. Our requirement that access ends at expiry forces a local patch.

## Resolved upstream (for the record)
- Default lifetime is now 600 seconds with a 3600 second ceiling (was 7200 seconds), so the window in which a removed member keeps reading is at most an hour and ten minutes by default.
- `com.atproto.space.notifyCredentialRevoked` lets the space authority tell a repo host that specific credentials (by `jti`) are revoked, so a removed member's credentials can be cut off before `exp`.
- Credentials are bound to a key with an HTTP message signature instead of DPoP.

## Problem
- `verifySpaceToken` rejects a token only when `now - CLOCK_SKEW_SEC >= exp`, with `CLOCK_SKEW_SEC = 5`, for credentials as well as delegation tokens and client attestations.
- A credential is the read-access lease for third-party repos. With revocation available the five-second tail is small, but it is still not stated as a normative choice, and an application that relies on `exp` as a hard cutoff (we do, in tests and docs) cannot get it from an unmodified host.

## Proposed change
State that a credential MUST be rejected at or after `exp`, with skew tolerance applying to delegation tokens and client attestations only. Our overlay is a three-line change in `packages/space/src/credential.ts`.

## Alternatives considered
- Leave the skew and document it. Acceptable, but then lifetime arithmetic in clients must add five seconds of slack and tests cannot assert an exact cutoff.

## Compatibility
Tightens behavior for credentials only.

## Internal references (remove before filing)
`protocol-tests/atproto/strict-credential-expiry.patch`, `docs/protocol/atproto-spaces-pin.md`, `SPEC.md` (credential expiry invariant).
