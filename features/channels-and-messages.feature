@phase3
Feature: Channel conversations
  Members collaborate through per-channel permissioned records.

  Rule: Public channel membership follows workspace membership

    Scenario: Create a public channel
      Given a workspace has current members
      When an admin creates a public channel
      Then each current workspace member has channel read and write access
      And the directory shows the channel as public only after membership is applied

    Scenario: Keep private messages behind PDS read authorization
      Given a member is absent from a private channel member list
      When that member opens the channel URI
      Then the PDS refuses a channel read credential

  Rule: Messages and reactions remain owned by their authors

    Scenario: Two clients synchronize the same channel messages
      Given two independent apps have authorized channel credentials
      When a member creates a message
      Then both apps show the same message

    Scenario: A member edits or deletes their own message
      Given a member authored a channel message
      And another app added a field this app does not know to that message
      When they edit or delete it
      Then the change is visible to every authorized app
      And the field the other app added is still on the edited message

    Scenario: A member cannot edit or delete another person's message
      Given another member authored a channel message
      When a member attempts to edit or delete it
      Then the app refuses the action

    Scenario: Accept one-level replies only within their channel
      Given a top-level message exists in a channel
      When a member replies to that message
      Then the reply is shown under the parent
      But a cross-channel parent or a reply to another reply is ignored

    Scenario: Keep one reaction per author, message, and emoji
      Given a member reacts to a message with an emoji
      When the member changes or removes that reaction
      Then all apps show only the current reaction record

    Scenario: Reject an overlong message
      Given a message contains more than 10000 graphemes
      When the member submits it
      Then the message is rejected

  Rule: Channel history is bounded and paged

    Scenario: Open a channel at the latest 100 messages
      Given a channel contains more than 100 messages
      When a member opens that channel
      Then the initial view contains the latest 100 messages
      And older messages load by page
      And no other channel history is fetched
