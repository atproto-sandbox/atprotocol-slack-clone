@r11
Feature: App Router URL routing and session return lifecycle
  Every workspace, channel, message permalink, Tasks view, and direct message has a shareable URL that survives hard
  reloads, preserves browser navigation history inside a live shell, and returns signed-out visitors to their deep link.

  Rule: Shareable workspace, channel, permalink, and DM routes survive direct opens and hard reloads

    Scenario: Navigate to and reload workspace, channel, message permalink, and DM routes
      Given a workspace with a channel message and a direct message conversation
      When the member opens the message permalink directly and reloads the page
      Then the browser stays on the message permalink route and highlights that message
      When the member opens the DM conversation route directly and reloads the page
      Then the browser stays on the DM conversation route and shows the DM message

    Scenario: Unauthenticated deep-link sign-in returns to the exact requested route
      Given a workspace member has a shareable message permalink
      When that member signs in after opening the message permalink while signed out
      Then the browser returns to that exact message permalink and highlights the message

  Rule: Browser Back and Forward navigation keeps the persistent shell session alive

    Scenario: Back and Forward navigation moves across routes without remounting the shell
      Given a signed-in member viewing a channel message permalink in the live shell
      When the member navigates to Direct messages and moves Back and Forward in browser history
      Then each route renders its content while the shell stays continuously mounted
