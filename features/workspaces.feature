@phase2
Feature: Workspace membership and discovery
  Teams share a workspace governed centrally by an Atmosphere Group's org.atgrp.members/self role and membership
  records and per-space org.atgrp.policy role grants on the Group Host.

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
      Then the DID has read access to the workspace and read and write access to group members
      And the DID has write-only access to the admin inbox
      And the DID has read and write access to each public channel
      And the invite is reported complete only after Group Host membership and invite delivery succeed

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

    Scenario: A forwarded workspace URI does not grant access
      Given a DID has no Group Host workspace membership
      When that DID opens a forwarded invite link and tries to join
      Then the app says the account has not been added to the workspace
      And the workspace does not appear in that account's dashboard
      And the DID still has no Group Host workspace membership and left no acceptance marker

    Scenario: Accept an invitation and discover it in a second app
      Given an invitee has been added to Group Host workspace membership
      When the invitee joins the workspace from its invite link
      Then the workspace appears in that account's spaces index
      And a second app reads the same directory and workspace roster

  Rule: Workspace administration follows current authority state

    Scenario: A workspace owned by a dedicated group account outlives every admin signing out
      Given a person is signed in to create a workspace
      When the person creates a workspace approved through the group host
      Then the workspace belongs to a dedicated group DID, and the person is its first admin while the group DID is not a member
      When the person makes a second member an admin
      And both admins sign out
      Then an admin who signs in again still administers the workspace
      And the group DID never signed in to the app

    Scenario: The creator becomes the first active admin of the group
      Given a signed-in person creates a workspace
      When the workspace is created
      Then a group-authored membership record grants the creator the admin role
      And the group authority holds the workspace profile while having no membership record of its own

    Scenario: A member's admin role record does not authorize unauthenticated group writes
      Given a user holds the group-authored admin role
      When that user calls a group space mutation with only their personal PDS token
      Then the group host rejects the operation

    Scenario: The final admin cannot leave or be demoted
      Given a workspace has one active admin
      When that admin leaves, is removed, or is demoted
      Then the operation is rejected

    Scenario: Promote and demote an admin
      Given a current workspace member is not an admin
      When an admin promotes that member
      Then the member receives inbox read access and the admin role
      When the member is demoted
      Then inbox read access is removed with the admin role
