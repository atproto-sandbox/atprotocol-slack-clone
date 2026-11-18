@phase2
Feature: Apps
  An app is an account a workspace installs: it reads the workspace and the channels it is granted, and writes where the grant
  says. People see its messages marked as an app's.

  Rule: An admin installs an app, people see it answer, and removing it takes its messages out of view

    Scenario: An admin installs an app that answers in a channel, and removes it
      Given a workspace with a member, and an echo bot that declared itself an app
      When the admin installs the echo bot with read and write in #general
      And the member writes "hello bot" in #general
      Then the member sees the echo bot answer "echo: hello bot", marked as an app's
      When the admin removes the echo bot, warned that its earlier messages leave the view
      Then the member no longer sees the echo bot's answer
