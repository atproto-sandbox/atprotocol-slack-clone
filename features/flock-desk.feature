@desk
Feature: Flock Desk independent browser client
  Flock Desk talks directly to personal PDSes and OpenSocial Group Hosts with zero Operator server.

  Rule: Direct browser authentication without an Operator

    Scenario: Reject server URL input and sign in with least-privilege scopes
      Given Flock Desk is running without an Operator server
      When an unauthenticated visitor submits a raw server URL on the Desk sign-in form
      Then Desk rejects the URL locally without leaving its origin
      When that person signs in to Desk with their ATProto identity
      Then Desk receives only least-privilege member scopes and never contacts the Operator

  Rule: Direct workspace onboarding and invitations

    Scenario: Join a workspace via an invite link across sign-in
      Given Flock Desk is running without an Operator server
      And a workspace with a private channel exists on Flock Web
      When an invited member opens the Desk invite link while signed out and completes sign-in
      Then the invitation survives sign-in and joins the workspace directly on the Group Host
      And Desk displays the workspace summary, member roster, and private channel roster

    Scenario: Receive and accept an expiring cross-PDS invitation in the Desk inbox
      Given Flock Desk is running without an Operator server
      And a workspace admin with a connected group governance session exists on Flock Web
      When a signed-in Desk user receives an expiring cross-PDS invitation and accepts it from the Desk inbox
      Then the user joins the workspace directly without contacting the Operator

  Rule: Cross-client channel messaging and fresh-credential enforcement

    Scenario: Post, reply, edit, and delete channel messages across Flock Desk and Flock Web
      Given Flock Desk is running without an Operator server
      And a workspace member is signed in to both Flock Web and Flock Desk
      When the member posts, edits, replies to a Web message, and deletes their reply in Flock Desk
      Then Flock Web observes the edited message, the reply, and the deletion directly from the writer PDS

    Scenario: Reject channel writes immediately after a member is removed
      Given Flock Desk is running without an Operator server
      And a workspace member has a channel open in Flock Desk
      When an admin removes that member in Flock Web and the removed member tries to post in Flock Desk
      Then Desk displays a write rejection error and nothing is written to the removed member's PDS

  Rule: Direct group moderation and content safety

    Scenario: Report messages with group rules and enforce moderation labels in Desk
      Given Flock Desk is running without an Operator server
      And a workspace has a published group rule and messages in general
      When a Desk member submits a rule-violation report and a spam report directly to the Group Host
      And a moderator applies hide and takedown labels to those messages in Flock Web
      Then Desk withholds the taken-down message and veils the hidden message until explicitly revealed

  Rule: Membership lifecycle and local privacy

    Scenario: Leave a workspace and erase local lifecycle data on sign-out
      Given Flock Desk is running without an Operator server
      And a workspace member is signed in to Flock Desk with an active workspace
      When the member leaves the workspace and signs out of Flock Desk
      Then Desk holds zero sync caches and erases the account lifecycle database on sign-out
