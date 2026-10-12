@phase2
Feature: Workspace membership and discovery
  Teams share a workspace while every PDS member list remains the read gate.

  Rule: Creating the first workspace needs one permission approval, requested in the same step

    Scenario: First-time creation asks for permission and then finishes on its own
      Given a signed-in account has not yet approved workspace-authority permission
      When the account submits a workspace name
      Then the app reports that permission is required, not a raw scope error
      And the app sends the account to approve that permission
      And after approval the same operation ID is retried and the workspace is created
      And no separate manual authorization step exists

    Scenario: A permission that was not granted does not loop
      Given the account returns from the permission screen without the required permission
      When the app resumes the setup once
      Then it shows a clear error instead of redirecting again

  Rule: Invitations establish access before they are reported complete

    Scenario: Invite a member to a workspace with public channels
      Given a workspace has one active owner and two public channels
      When an admin invites a DID that is not a workspace member
      Then the DID has read and write access to the workspace
      And the DID has write-only access to the admin inbox
      And the DID has read and write access to each public channel
      And the invite is reported complete only after every member list matches

  Rule: An invited member can find, join, and see the workspace

    Scenario: The owner is told to send the invitee a link
      Given a workspace owner has created a workspace and approved admin controls
      When the owner invites a member by DID
      Then the owner is told to send the invite link
      And the owner can copy an invite link that names the workspace

    Scenario: An invited member opens the link and sees the workspace
      Given a member has been invited to a workspace and given its invite link
      When the member opens the invite link and signs in
      Then the member is offered to join that workspace
      When the member joins the workspace
      Then the workspace appears in the member's dashboard with 2 active members

    Scenario: Declining the join permission explains itself and keeps the invitation
      Given a member has been invited to a workspace and given its invite link
      When the member opens the invite link and signs in
      And the member declines the permission screen when joining
      Then the app says the permission was not granted
      And the invitation is still offered
      When the member joins the workspace
      Then the workspace appears in the member's dashboard with 2 active members

    Scenario: A forwarded workspace URI does not grant access
      Given a DID is absent from a workspace member list
      When that DID opens a forwarded invite link and tries to join
      Then the app says the account has not been added to the workspace
      And the workspace does not appear in that account's dashboard
      And the DID is still absent from the member list and left no acceptance marker

    Scenario: Accept an invitation and discover it in a second app
      Given an invitee has been added to the workspace member list
      When the invitee joins the workspace from its invite link
      Then the workspace appears in that account's spaces index
      And a second app reads the same directory and workspace roster

  Rule: Workspace administration follows current authority state

    Scenario: The authority remains the first active admin
      Given a workspace authority DID owns the workspace
      When the workspace is created
      Then an authority-authored active admin record exists for that DID
      And the authority can read the workspace without a member-list entry

    Scenario: A user-level admin record does not authorize PDS management
      Given a user has an active authority-authored admin record
      When that user calls a member-management operation without the authority session
      Then the PDS rejects the operation

    # Covered by protocol-tests/app-acceptance.test.ts, which drives the operator directly. The UI offers no
    # way to remove or demote the final admin, so there is no user journey to bind here.
    @unbound
    Scenario: The final admin cannot leave or be demoted
      Given a workspace has one active admin
      When that admin leaves, is removed, or is demoted
      Then the operation is rejected

    Scenario: Promote and demote an admin
      Given a current workspace member is not an admin
      When an admin promotes that member
      Then the member receives inbox read access and an active admin record
      When the member is demoted
      Then inbox read access is removed before the admin record becomes inactive
