# Let a space owner delegate space management to other accounts

Status against `6747610566` + `opensocial.group` `8df0cc82` (R13, 2026-11-21): **Solved for groups/workspaces by `opensocial.group` (`apps/group-host`); orthogonal for plain `com.atproto.memberspace` on personal PDSes.** In R13, Flock adopted `opensocial.group`: `apps/group-host` runs a two-sided ATProto OAuth 2.1 Authorization Server where admins and moderators sign in via their own personal PDS and receive per-user (`GroupBrowserOAuthClient`) or shared (`apps/operator`) Group-DID sessions dynamically narrowed on every request by `effectiveMemberPermissions` (`role.scopes` ∪ space-clamped `policy.grants[].scopes`) and `assignable`, with zero shared personal-account password custody and audited `operationAdminTakeover` if an admin is demoted. Plain `com.atproto.memberspace` on personal PDSes remains owner-only (used in Flock only for single-owner DM conversation halves and personal `invites/self`).

Status against `5d88b414` (2026-10-30): Not affected. `com.atproto.simplespace` is gone, and its member methods are now `com.atproto.memberspace.putMember`, `removeMember` and `listMembers`, with `updateSpace` under `com.atproto.space`; all still require OAuth as the space owner, and the new `managedspace` policy still puts an application in the access decision rather than delegating who edits the member list.

Status against `5b95b2f2`: Not affected. `simplespace` management still requires auth as the space owner (`NotSpaceOwner`).

## Summary
Only the space owner can call `putMember`, `removeMember` and `updateSpace`. A team space owned by a dedicated account can therefore be administered only by whoever holds that account's OAuth session. There is no way to give another account the authority to manage members without giving it the owner's session.

## Problem
- For a shared space, the natural authority is a dedicated account (a workspace identity), with several human admins. Today the application must hold the owner's OAuth session (refresh token included) on a server to act for the admins. In our app that session is encrypted at rest and every admin action goes through a service that checks the caller and then acts as the owner. It works, but it is custody of a full account session and a single point of failure.
- The proposal's `managing-app` policy is not a fit. It lets the authority ask an application whether a user may read or write (`checkUserAccess`), which puts the application in the read path. We want the PDS member list to be the only read gate, and delegation of who may *edit* that list to be separate from who may read.

## Proposed change
Let the owner nominate managers, and let managers act with their own identity:

```
com.atproto.memberspace.putManager / removeManager     (owner only)
  input: { space, did }

com.atproto.space.getManagementToken                   (served by the manager's PDS)
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

## Related work: opensocial.group
Adopted in Flock R13 (`apps/group-host`, `packages/protocol/src/scopes.ts`, `apps/web/src/browser/group-session.ts`, `apps/operator`): `opensocial.group` solves multi-admin and moderator delegation for Group DIDs via a two-sided OAuth 2.1 Authorization Server backed by `group.opensocial.role`, `group.opensocial.policy` (`grants[].scopes` clamped per space), and `assignable` anti-escalation. This draft remains relevant only if upstream wishes to add lightweight manager delegation to plain `com.atproto.memberspace` spaces hosted on ordinary personal PDSes without a Group Host.

## Internal references (remove before filing)
`apps/group-host/src/{oauth,rbac}.ts`, `apps/operator/src/operator/**`, `docs/protocol/operator-contract.md`.
