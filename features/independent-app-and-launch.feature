@phase6
Feature: Independent app conformance and launch limits
  Published records, lexicons, and credentials define the shared workspace.

  Rule: Independent apps agree on canonical state

    Scenario: Render one workspace from two independent apps
      Given two apps use published lexicons, OAuth, and space credentials
      When each app syncs the same workspace
      Then both show the same directory, roster, messages, and private roster
      And neither app reads the other's database or private cache

    Scenario: Ignore spoofed authority records
      Given a member writes an admin, decision, or roster record in their own repo
      When an app syncs the workspace
      Then the app ignores the record because the workspace DID did not author it

    Scenario: Do not infer membership from the writer set
      Given a workspace member has not written to a channel
      When an app reads listRepos
      Then it does not treat absence from that writer set as absence from membership

  Rule: The supported envelope is measured before launch

    @slow
    Scenario: Meet the workspace size envelope
      Given a workspace has 200 members, 100 channels, and 20000 messages per channel
      When an admin inbox and a channel are synchronized
      Then writer reconciliation completes within 60 seconds
      And opening the channel loads the latest 100 messages first

    Scenario: Alert on stalled admin work
      Given a journaled operation has made no progress for five minutes
      When the operator checks its pending operations
      Then it raises an operator alert with the operation status

    Scenario: Stop new work with the operator pause switch
      Given the owner has paused admin mutations
      When an admin submits a mutation
      Then the operator rejects or queues it as paused
      And committed PDS records and member lists remain unchanged
