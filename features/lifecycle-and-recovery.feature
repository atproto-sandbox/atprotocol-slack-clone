@phase5
Feature: Membership, privacy, and archive lifecycle
  Multi-space changes remain honest and recover after partial failure.

  Rule: Removal stops new credential issuance

    Scenario: Remove a workspace member from every applicable space
      Given a member has workspace, inbox, public-channel, and private-channel access
      When an admin removes that member
      Then membership is removed from each applicable space
      And the workspace and private rosters become inactive
      And the operation stays pending until every PDS member list agrees

    Scenario: An old credential expires after removal
      Given a member holds a space credential with a two hour maximum lifetime
      When the member is removed
      Then they cannot obtain a new credential
      But the old credential works only until its signed expiration

    Scenario: A member leaves a private channel
      Given a member belongs to a private channel
      When they leave that channel
      Then channel access and the private roster entry are removed
      And workspace access remains active

  Rule: Privacy transitions preserve the channel URI

    Scenario: Make a public channel private
      Given a public channel has current workspace members
      When an admin starts a private transition for selected members
      Then the directory shows transitioning while membership changes
      And compliant apps stop new syncs during the transition
      And the same channel URI and messages remain after completion
      And unselected members cannot mint new credentials after completion

    Scenario: Recover a partially completed privacy transition
      Given a privacy transition failed after any PDS mutation step
      When the operator restarts
      Then the journal resumes the desired state
      And the channel remains transitioning until all member lists agree

    Scenario: Archive a channel
      Given a channel contains messages
      When an admin archives it
      Then all channel members are removed before it is marked archived
      And no new channel credentials are issued
      And existing messages remain in their authors' repos

  Rule: Retries and operations are durable

    Scenario: Retry the same operation idempotently
      Given an operation with a workspace, actor, and operationId is journaled
      When the same request hash is submitted again
      Then the existing operation status is returned

    Scenario: Recover pending admin work before accepting a newer admin mutation
      Given an admin operation remains pending after a partial write
      When an active admin submits another mutation
      Then the operator resumes the older operation first
      And the newer mutation runs only after the older operation completes

    Scenario: Do not let member leave requests resume admin operations
      Given an admin operation remains pending
      When a workspace member requests to leave
      Then the operator returns a busy response
      And it does not execute the pending admin operation as the member

    Scenario: Reject operation id reuse with a different request
      Given an operationId is already bound to a request hash
      When another request body uses the same operationId
      Then the operator reports a conflict

    @slow
    Scenario: Recover after every injected mutation failure
      Given an admin operation can fail after each PDS write
      When a failure is injected and the operator restarts
      Then the operation remains visibly pending until state converges

    Scenario: Keep private cached data out of use after access is revoked
      Given an app cached private-channel data
      When the credential can no longer be renewed
      Then the app stops syncing and purges its cached copy
