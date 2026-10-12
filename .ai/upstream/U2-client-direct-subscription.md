# Let clients subscribe to space changes directly, without a relay service

## Summary
The only real-time mechanism, `registerNotify`, delivers `notifyWrite` to a *service endpoint*. A browser-only application therefore has to relay through a server, and that server learns which spaces each user follows.

## Problem
- `registerNotify` takes a service identifier resolved from a DID document. A client running in a browser has no such endpoint, so live updates need an application server in the middle.
- In our team-chat app, each open conversation subscribes through that server, one connection per participant's half of the conversation. The server can therefore log which halves, and so which participants, a signed-in user follows. The data is otherwise entirely between the user's browser and their PDSes.
- A 100-person group DM opens about 101 relay connections, each polling on the server side.
- The proposal's own scaling argument is that applications pull directly from repo hosts. Real-time is the one place where a browser cannot do that.

## Proposed change
A long-lived stream on the space host, and the same on a repo host for one repo:

```
com.atproto.space.subscribeSpace   (space host)
  params: { space, cursor? }
  auth:   space credential + DPoP (same as other sync methods)
  frames: { seq, repo, rev, hash }   // same payload as notifyWrite
          { seq, deleted: true }     // the space was deleted (as notifySpaceDeleted)

com.atproto.space.subscribeRepoOps (repo host)
  params: { space, repo, since? }
  frames: the same entries listRepoOps returns
```

Notes:
- A frame reveals only that a repo advanced, exactly what `notifyWrite` already reveals. Clients then pull with `listRepoOps` as today.
- Browsers cannot set an `Authorization` header on a WebSocket. Either specify streaming over HTTP (fetch with a readable body, which can carry DPoP headers) or define a first-frame authentication for WebSocket.
- `cursor` may be best-effort: if it is older than retention, the stream sends a "resync" frame and clients fall back to `listRepos` and `getLatestCommit`.

## Alternatives considered
- Keep `registerNotify` and have each application run a relay. This is what we do, and it is exactly the centralization we would like to avoid.
- Polling only. Correct, but slow or wasteful at the sizes above.

## Compatibility
Additive. `registerNotify` and `notifyWrite` stay for server-side syncers.

## Open questions
- Should the space host multiplex all repos, or should clients subscribe per repo host? (Space host is simpler for clients.)
- Per-credential limits on concurrent streams.

## Internal references (remove before filing)
`src/app/ui/dm-conversation.tsx`, `src/app/api/notifications/dm/route.ts`, `docs/operations.md`, "Direct messages: what an operator can and cannot see".
