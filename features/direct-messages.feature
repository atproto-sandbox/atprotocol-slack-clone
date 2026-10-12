@direct-messages
Feature: Direct messages
  People hold their own conversations without an app that can read, gate, or lose them.

  Rule: Each participant owns only their own words

    Scenario: Enable DMs
      Given a user has no DM inbox
      When they enable DMs
      Then a DM inbox space with the fixed self key exists on their own PDS
      And only its owner can read it
      And a user without an inbox is shown as not having enabled DMs

    Scenario: Start a one-to-one conversation
      Given an initiator chooses one other participant
      When they start the conversation
      Then the initiator writes a header and messages into their own half
      And the other participant finds a request in their own inbox
      And the request names the same conversation key and participant set

    Scenario: Reuse a conversation for the same participants
      Given the initiator already has a conversation with the same participant set
      When they start that conversation again
      Then the existing conversation key is reused locally
      And no new half or request is written

    Scenario: Start a group conversation
      Given an initiator chooses a group of participants
      When they start the conversation
      Then every participant can read every half
      And only each half's owner can write to it
      And the participant set never changes

    Scenario: Bound a conversation at 100 participants
      Given an initiator chooses 100 participants including themselves
      When they start the conversation
      Then the conversation is created
      But a request naming 101 participants is rejected

    Scenario: Edit and delete your own messages
      Given a participant authored a DM message
      When they edit or delete it
      Then every reader shows the change
      And another participant cannot edit it because the record lives in its author's repo

    Scenario: Keep one reaction per author, message, and emoji
      Given a participant reacts to a DM message with an emoji
      When they change or remove that reaction
      Then all readers show only the current reaction record
      But a reaction whose subject is a message in another conversation is ignored

    Scenario: Leave a conversation
      Given a participant wants to stop sharing their messages
      When they remove the other participants from their half
      Then new credentials for that half are refused
      And the other participants keep their own halves

    Scenario: Delete everything
      Given a participant wants to unsend every message
      When they delete their half
      Then their messages are gone from their own PDS
      But copies other participants already fetched are not recalled

  Rule: Requests live in the recipient's own inbox

    Scenario: Discover a request
      Given a sender wrote a request in their own repo scoped to the recipient's inbox
      When the recipient's client scans the writers of its own inbox
      Then the recipient reads the request from the sender's repo
      And no app server is asked for the request

    Scenario: Accept by replying
      Given a recipient found a request
      When they reply
      Then a half with the same conversation key and participants is created on their own PDS
      And the requester is added to the recipient's allowlist
      And later conversations from that requester are not blocked

    Scenario: Decline without creating a half
      Given a recipient found a request
      When they ignore or hide it
      Then no half is created
      And the sender gains no read access

  Rule: The inbox write policy is the user's setting

    Scenario: Allow everyone
      Given a user sets their inbox policy to everyone
      When a stranger writes a request
      Then the user's PDS tracks that writer
      And the local display filter sorts the request into the requests folder

    Scenario: Allow only people I allow
      Given a user sets their inbox policy to an allowlist of writers
      When a stranger writes a request
      Then the user's PDS never tracks that writer
      But an allowed writer's request is tracked and read

    Scenario: Allow nobody
      Given a user sets their inbox policy to nobody
      When anyone writes a request
      Then no new writer is tracked
      And existing conversations keep working without the inbox

    Scenario: Switch the policy
      Given writers were tracked while the inbox policy allowed everyone
      When the user switches to an allowlist or to nobody
      Then those writers stay listed by the PDS
      And the client drops requests from writers outside the current policy

  Rule: Reads merge validated halves

    Scenario: Merge a conversation from every half
      Given a conversation has halves for its participants
      When a participant opens the conversation
      Then every half's messages appear in one timeline ordered by key
      And a missing half means that participant has not replied

    Scenario: Ignore records whose repo is not the half owner
      Given another member stored a record scoped to someone else's half in their own repo
      When a participant reads the conversation
      Then that record is ignored

    Scenario: Ignore a half whose header does not match
      Given a half header names a different conversation key or participant set
      When a participant reads the conversation
      Then that half is ignored

  Rule: Conversation keys are random

    Scenario: Never derive a conversation key from its participants
      Given two conversations name the same participant set
      Then their conversation keys differ
      And no conversation key can be computed from participant DIDs
      And a party who cannot guess the key cannot confirm who talks to whom

  Rule: Correctness never depends on the app

    Scenario: Recover a dropped request notification
      Given a request was written but no reply half appeared
      When the sender's re-notify backoff elapses
      Then the same request record is re-put with a new revision
      And the recipient side treats the repeat as idempotent
      And the backoff stops after the final step

    Scenario: Rebuild every conversation from your own PDS
      Given the app server, its database, and its notification endpoint are gone
      When a participant signs in with any conforming OAuth client
      Then their conversations are rebuilt from their own spaces, halves, and inbox
      And the other halves are read with freshly minted credentials

    Scenario: The app server never holds DM scopes or DM content
      Given the app runs its own server session for workspaces
      When direct messages are exchanged
      Then that session holds no DM scope
      And no server route stores or returns DM content
