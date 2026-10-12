# Let a space owner delegate space management to other accounts

## Summary
Only the space owner can call `putMember`, `removeMember` and `updateSpace`. A team space owned by a dedicated account can therefore be administered only by whoever holds that account's OAuth session. There is no way to give another account the authority to manage members without giving it the owner's session.

## Problem
- For a shared space, the natural authority is a dedicated account (a workspace identity), with several human admins. Today the application must hold the owner's OAuth session (refresh token included) on a server to act for the admins. In our app that session is encrypted at rest and every admin action goes through a service that checks the caller and then acts as the owner. It works, but it is custody of a full account session and a single point of failure.
- The proposal's `managing-app` policy is not a fit. It lets the authority ask an application whether a user may read or write (`checkUserAccess`), which puts the application in the read path. We want the PDS member list to be the only read gate, and delegation of who may *edit* that list to be separate from who may read.

## Proposed change
Let the owner nominate managers, and let managers act with their own identity:

```
com.atproto.simplespace.putManager / removeManager     (owner only)
  input: { space, did }

com.atproto.simplespace.getManagementToken             (served by the manager's PDS)
  params: { space }
  auth:   OAuth with a covering `manage` scope for authority=<owner did>
  output: a short-lived, single-use token addressed to the authority (typ
          `atproto-space-management+jwt`), shaped like the delegation token

putMember / removeMember (optionally updateSpace)
  also accept that token from a listed manager
```

The authority records the acting manager's DID in its audit trail. Managers cannot remove the owner or edit the manager list.

## Alternatives considered
- Sharing the owner's credentials or session (status quo).
- Modeling each admin as a member flag (`manage: true`) in `putMember`. Similar in effect, but the token exchange is what avoids custody of the owner's session, so the two ideas combine well.

## Compatibility
Additive. Owner-only behavior remains the default.

## Open questions
- Granularity: membership changes only, or policy changes too?
- Whether managers can add other managers.

## Internal references (remove before filing)
`src/operator/**` (service that holds the authority session), `docs/protocol/operator-contract.md`.
