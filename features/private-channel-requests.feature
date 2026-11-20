@phase4
Feature: Private channel requests
  Requesters can ask for access without gaining read access to the admin inbox.

  Rule: Inbox write membership does not grant inbox read access

    Scenario: A member submits a private-channel request
      Given a workspace member has inbox write access and no inbox read access
      When they submit a request to their own PDS repo
      Then they can read their own request
      And an admin can read it using an inbox credential
      But the requester cannot obtain an inbox read credential
      And an ordinary member cannot read the request repo

    Scenario: A missed app notification is found by listWriters
      Given a request write reached the authority PDS writer set
      And the app notification was dropped
      When the admin inbox performs its next 60 second reconciliation
      Then it finds the request writer through listWriters

    Scenario: A dropped PDS-to-authority notification is recovered
      Given a request write reached the requester's PDS
      And the PDS-to-authority notifyRepoUpdate was dropped
      When the admin inbox performs its next 60 second reconciliation
      Then the operator returns the current inbox write-member DID
      And the admin reads that repo with their inbox credential
      And the operator never returns the request body

  Rule: Decisions apply only to the current request generation

    Scenario: Approve the current request generation
      Given an admin has read the current request and requestId
      When the admin approves it
      Then the requester receives channel read and write access
      And the active private roster includes the requester
      And an authority-authored decision matches the same requestId
      And the request is shown as approved only after all three writes complete

    Scenario: Deny a request without granting channel access
      Given an admin has read the current request
      When the admin denies it
      Then an authority-authored denial is recorded
      And the requester receives no channel membership

    Scenario: Ignore a decision for an older request generation
      Given a requester withdrew and resubmitted a request with a fresh requestId
      When an older approval decision arrives
      Then the new request remains pending

    Scenario: Show the full private roster after approval
      Given a member has an authorized private-channel credential
      When they open the channel roster
      Then it includes every active member, including members who have never posted
