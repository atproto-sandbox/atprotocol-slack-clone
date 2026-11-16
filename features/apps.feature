@phase2
Feature: Apps
  An app is an account a workspace installs: it reads the workspace and the channels it is granted, and writes where the grant
  says. People see its messages marked as an app's, run its slash commands privately through its inbox, and click its block
  buttons.

  Rule: An admin installs an app, people see it answer, and removing it takes its messages out of view

    Scenario: An admin installs an app that answers in a channel, and removes it
      Given a workspace with a member, and an echo bot that declared itself an app
      When the admin installs the echo bot with read and write in #general
      And the member writes "hello bot" in #general
      Then the member sees the echo bot answer "echo: hello bot", marked as an app's
      When the admin removes the echo bot, warned that its earlier messages leave the view
      Then the member no longer sees the echo bot's answer

  Rule: Slash commands and block actions go only to the app, while people's messages never render blocks

    Scenario: A member runs /echo and clicks Again, a second member sees only the answers, and a person's blocks show text only
      Given a workspace with two members, and an echo bot that declared itself an app
      When the admin installs the echo bot with read and write in #general
      And the first member runs "/echo hello" in #general
      Then the first member sees the echo bot answer "echo: hello" with an "Again" button, and "/echo hello" never appears in #general
      And the second member sees the echo bot answer "echo: hello" in #general, and never "/echo hello"
      When the first member clicks "Again" on the echo bot's answer
      Then two echo bot answers "echo: hello" appear in #general for both members
      When the first member writes a message in #general carrying spoofed blocks and fallback text "plain member text"
      Then the second member sees "plain member text" in #general with no rendered blocks or buttons

    Scenario: A browser session from before R10 is sent through consent and then runs a command
      Given a workspace with a member whose browser session predates R10, and an echo bot installed in #general
      When the member reconnects their browser through consent
      And the member runs "/echo upgraded" in #general
      Then the member sees the echo bot answer "echo: upgraded", marked as an app's
