# R8 progress: a dedicated workspace account

Plan: `.ai/plans/platform-refactor.md`, "### R8" and "What a completed flow allows" in the target design.

Status: done. Outcome, departures, gate and reviews: the plan's "### R8" section.

## Design (2026-11-11)

- **The authority flow takes an intended authority other than the initiator.** `startAuthorityFlow` takes an optional
  `authority` (a DID; the caller's own when absent), for creating a workspace and for reauthorizing. The ticket already
  records the initiator and the intended authority apart; R1's rule that they be equal goes. The callback still accepts
  only a sign-in as the intended authority.
- **A creation authorization** (`creation_authorization`, `apps/operator/src/operator/creation-authorization.ts`): written
  when a `createWorkspace` flow whose initiator is not the authority completes, bound to the initiator, the authority and
  the workspace name, for 15 minutes; one row per (authority, initiator, name), a new flow replacing it. It is consumed in
  the transaction that inserts the creation's journal row (a hook of `runJournaledOperation` that runs only on insert), so
  a retry of the same operation finds its row and needs none. When that row is discarded because the first step was
  refused for a missing scope, the authorization is restored in the discarding transaction, for 15 more minutes and for
  that operation id only. A caller that is the authority needs only the grant, as before.
- **A new persisted kind, `createWorkspace`** (`kinds/create-workspace.ts`), whose request carries the creator: the three
  spaces and the profile as before; then the creator in the workspace, inbox (read and write, as an admin) and #general
  member lists (skipped when the creator is the authority, which owns them); the creator's roster and admin records;
  #general's directory entry. The journal row's actor is the creator and its workspace the authority. The method
  `createWorkspace` issues only this kind; `bootstrapWorkspace` keeps its handler, for rows that exist, and its function
  that started new rows goes (tests that set up workspaces through it move to the new one).
- **Who resumes a `createWorkspace` row:** its creator (a retry of the same operation), and the operator's own recovery
  (the reconcile job), which resumes pending creations of both kinds for the authority; once the row's `creator-admin`
  step is done, any active admin, like every other kind. The kind's actor is a new value, `creator`.
- **Lexicons:** `createWorkspace` and `startAuthorityFlow` take an optional `authority`. The method answers a missing
  creation authorization like a missing grant (`AuthorizationRequired`), so the web app's one path (approve, return,
  retry the same operation once) serves both.
- **Web app:** the creation form takes an optional workspace account (a DID; empty is the person's own account); the
  creation waiting on the approval keeps it across the round trip, and the operation id is keyed by name and account.
- **Tests:** unit tests for the authorization (grant, consume, single use, name and initiator binding, expiry, restore
  bound to one operation), the journal hooks, the kind (steps, the creator's records, the self-owned shape) and who may
  resume; an acceptance test on the real PDS for a creation under a dedicated account and its refusals; the gate as a
  BDD scenario: a workspace whose authority never signs in to the web app is created, administered by two admins, and
  survives every admin signing out.
