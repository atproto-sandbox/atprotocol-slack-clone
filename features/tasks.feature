@r11
Feature: Tasks extension collaboration and causal conflict recovery
  Workspace admins can enable the isolated Tasks extension space, members manage projects, tasks, board transitions,
  and comments end to end, and concurrent edits preserve non-destructive conflict history with cold reader parity.

  Rule: An admin enables Tasks and members collaborate across projects, Kanban board, and comments

    Scenario: Admin enables Tasks, members create a project and task, transition it on the board, and comment
      Given a workspace with an admin and a joined member
      When the admin enables the Tasks extension and creates project "Roadmap" with task "Ship R11"
      And the member transitions "Ship R11" to "In progress" on the Kanban board and posts comment "Verified on board"
      Then the admin sees the task comment "Verified on board"
      And the independent cold Tasks reader matches the project, task status, and comment

  Rule: Concurrent task edits preserve conflict versions and browser-sovereign Activity recovery

    Scenario: Concurrent title edits surface Concurrent versions, restore the overwritten version, and persist Activity state
      Given two workspace members open the same task "Release checklist" in separate browsers
      When the first member saves title "Release v1" and the second member concurrently saves title "Release v2"
      Then syncing shows a Concurrent versions disclosure on the task and an unseen badge on Activity
      When the first member marks the Activity conflict seen, dismisses it across reloads, and restores the overwritten version
      Then the task displays the restored title with no remaining conflict versions and matches the independent cold reader
