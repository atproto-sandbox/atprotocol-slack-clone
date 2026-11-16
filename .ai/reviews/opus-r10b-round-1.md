# R10b Independent Review — Round 1

- **Reviewer:** Swarm worker `opus-r10b` (`claude-opus-5-5-high`)
- **Commit Reviewed:** `78f4a34` (`5d1a8cf..78f4a34`)
- **Verdict:** **READY** (`0 blocking`, `9 non-blocking`)

## Summary of Verified Requirements

- **Key window (`packages/client/src/key-window.ts`):** Shared by channel messages and both inbox streams (`app.command` and `app.action`).
- **Optional handlers & inbox lifecycle (`packages/client/src/app-runtime.ts`):** `onMessage`, `onCommand`, and `onAction` are each optional; no inbox is followed without a command/action handler, no channels are followed without `onMessage`, and `applySummary` / `forget` unfollow inboxes on uninstall or workspace loss.
- **Fresh state & checks (`packages/client/src/app-runtime.ts`):** Fresh workspace summary and per-poll private-channel roster; workspace authority admitted to private channels it owns; cross-workspace, transitioning, archived, and ungranted channels rejected; command `parent` verified as a top-level message; action target verified as this app's message in the channel via MAC-verified `getMessage` (working at any message age), `#button` presence verified, and forged action `value` ignored in favor of the button's own `value`.
- **Throttle & own writes:** Per-author throttle (`maxRecordsPerAuthor`) reported once per minute per author; `applyOwnWrites` disabled for app runtimes.
- **Client & OAuth (`blocks.ts`, `channel-client.ts`, `app-inbox-client.ts`, `workspace-client.ts`, `space-credential-core.ts`, `node/oauth.ts`):** Synchronous `validateMessageInput` (`{ text, blocks? }` only + `MAX_RECORD_BYTES`), `send`/`edit` block preservation/replacement/clearing, `AppInboxClient` member writes without credentials or store writes and `SyncCore` reads, `commands` in declarations, `isAccessLost` excluding `ScopeMissingError`, and `isSessionLost` including it.
- **People's client & BDD (`apps/web`, `apps/echo-bot`, `features/apps.feature`):** Exact `missingScopes` reduction with `spaceCollections` and `accountDid` plus over-acceptance tests; shared declaration cache; `/` held while loading, `//` escape, picker disambiguation, composer-only status; blocks rendered as plain text only for active installs; button disabled while action write is in flight; echo-bot `/echo` + `Again`; 3/3 BDD scenarios passing.

## Non-Blocking Polish Notes & Disposition

1. **Stale-closure race in `WorkspaceDeclarationCache` snapshot:** Applied — `snapshotOf(workspaceUri)` now returns all cached entries for the workspace without overwriting newer installs from an older effect's `installDids` list.
2. **Transient declaration failure caching:** Kept per workspace session (plan line 144: *"loads and caches the declaration of every active install once per workspace ... tolerating an app whose host cannot be reached"*).
3. **Throttle counting handler retries:** Applied — `admitAuthorRecord` tracks seen record URIs within the window so `KeyWindow` retries of a failed handler do not consume extra per-author quota.
4. **Declaration `getRecord` envelope overhead (`MAX_DECLARATION_BYTES`):** Applied — raised `getRecord` HTTP envelope cap to `MAX_RECORD_BYTES + 4096` while `validateAppDeclaration` enforces `MAX_RECORD_BYTES` on `value` itself.
5. **42 KiB 4-byte-grapheme declaration test:** Applied — `workspace-client.test.ts` now uses 4-byte graphemes (`"👍".repeat(300)` and `"👍".repeat(100)`) so the 25-command fixture exercises the full ~42 KiB bound.
6. **Picker choice persisting across different command names:** Applied — changing the `/<command>` token clears a `chosenCommandApp` selected for a different command name.
7. **Private channel loading before roster arrives:** Applied — while `content === undefined` on a non-refused private channel, `/` submissions report `"held"` (still loading) rather than `"blocked"`.
8. **Cosmetic `did:` prefix in `session.ts`:** Cleaned up.
