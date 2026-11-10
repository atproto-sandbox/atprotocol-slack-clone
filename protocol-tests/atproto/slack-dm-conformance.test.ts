import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatDidKey, type Keypair, P256Keypair } from '@atproto/crypto'
import { TestNetworkNoAppView, type TestPds } from '@atproto/dev-env'
import { createSpaceSigHeaders } from '@atproto/space'
import { calculateJwkThumbprint } from 'jose'
import type { NsidString } from '@atproto/syntax'
import { Client } from '../../../oauth/oauth-provider/src/client/client.js'
import { generateCode } from '../../../oauth/oauth-provider/src/request/code.js'
import { com } from '../../src/lexicons/index.js'
import { type Actor, SpaceClient, SpaceCredential } from '../_space.js'

// Direct-message protocol gate (M0 in .ai/plans/direct-messages.md). Every
// assumption the DM design makes about the pinned PDS is exercised here before
// any app code depends on it.

const previousTmpdir = process.env.TMPDIR
const fixtureTmpdir = mkdtempSync(join(tmpdir(), 'slack-dm-conformance-'))
process.env.TMPDIR = fixtureTmpdir

afterAll(() => {
  try {
    rmSync(fixtureTmpdir, { recursive: true, force: true })
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
})

const INBOX_TYPE = 'new.flock.dm.inbox' as NsidString
const CONVERSATION_TYPE = 'new.flock.dm.conversation' as NsidString
const REQUEST = 'new.flock.dm.request' as NsidString
const HEADER = 'new.flock.dm.header' as NsidString
const MESSAGE = 'new.flock.dm.message' as NsidString
const REACTION = 'new.flock.dm.reaction' as NsidString
const { memberspace } = com.atproto
// DM half and inbox reads: member list. Inbox writes: anyone. updateSpace replaces
// the whole policy, so each call below passes the full policy it wants.
const MEMBER_LIST_POLICY = memberspace.policy.$build({})
const PUBLIC_WRITE_POLICY = memberspace.policy.$build({ publicWrite: true })
const READ_ONLY = { read: true, write: false }
const WRITE_ONLY = { read: false, write: true }

type Outcome = { ok: true } | { ok: false; error: unknown; status: unknown; message: string }

const outcome = async (promise: Promise<unknown>): Promise<Outcome> => {
  try {
    await promise
    return { ok: true }
  } catch (err) {
    const e = err as { error?: unknown; status?: unknown; message?: string }
    return { ok: false, error: e.error, status: e.status, message: e.message ?? String(err) }
  }
}

/** Mint a space credential at the space owner's host, which need not be pds1. */
const credentialAt = async (
  spaces: SpaceClient,
  actor: Actor,
  space: `at://${string}`,
  ownerPds: TestPds,
): Promise<SpaceCredential> => {
  const key = await P256Keypair.create()
  const token = await spaces.delegationTokenFor(actor, space as never)
  const res = await ownerPds.getClient().call(com.atproto.space.getSpaceCredential, {
    space: space as never,
    credentialKid: key.did(),
    delegationToken: token,
  })
  return new SpaceCredential(res.credential, key, spaces.idResolver)
}

/** A browser-style space signing key: the private half never leaves WebCrypto. */
const webCryptoSpaceKey = async (): Promise<Keypair> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  expect(pair.privateKey.extractable).toBe(false)
  const did = formatDidKey('ES256', new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  return {
    jwtAlg: 'ES256',
    did: () => did,
    sign: async (msg) => new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg)),
  }
}

const writerDids = async (credential: SpaceCredential, ownerPds: TestPds, space: string) => {
  const res = await credential
    .clientFor(ownerPds)
    .call(com.atproto.space.listRepos, { space: space as never })
  return res.repos.map((repo) => repo.did)
}

/** Poll long enough that a best-effort notification would have landed, then report. */
const settledWriters = async (
  spaces: SpaceClient,
  credential: SpaceCredential,
  ownerPds: TestPds,
  space: string,
  until: (dids: string[]) => boolean = () => false,
) => spaces.awaitNotify(() => writerDids(credential, ownerPds, space), until, { attempts: 30, delayMs: 50 })

const conversationRecord = (convKey: string, participants: Actor[]) => ({
  $type: HEADER,
  convKey,
  participants: participants.map((actor) => actor.did).sort(),
  createdAt: new Date().toISOString(),
})

describe('atproto Slack direct-message protocol conformance', () => {
  it('keeps each participant sovereign over their own conversation half across hosts', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1 })
    try {
      const spaces = new SpaceClient(network)
      const pds1 = network.pds
      const pds2 = network.extraPdses[0]
      const alice = await spaces.createActor('alice', pds1)
      const bob = await spaces.createActor('bob', pds2, 'test2')
      const eve = await spaces.createActor('eve', pds2, 'test2')
      const convKey = '3kdmconvkey22'
      const participants = [alice, bob]

      const aliceHalf = await spaces.createSpace(alice, { spaceType: CONVERSATION_TYPE, skey: convKey })
      await spaces.putMember(alice, aliceHalf, bob, READ_ONLY)
      const bobHalf = `at://${bob.did}/space/${CONVERSATION_TYPE}/${convKey}` as const
      await bob.client.call(
        com.atproto.space.createSpace,
        {
          spaceType: CONVERSATION_TYPE,
          skey: convKey,
          policy: MEMBER_LIST_POLICY,
        },
        { headers: bob.headers },
      )
      await bob.client.call(
        com.atproto.memberspace.putMember,
        { space: bobHalf as never, did: alice.did, ...READ_ONLY },
        { headers: bob.headers },
      )

      await spaces.put(alice, aliceHalf, { collection: HEADER, rkey: 'self', record: conversationRecord(convKey, participants) })
      await spaces.write(alice, aliceHalf, { collection: MESSAGE, record: { $type: MESSAGE, text: 'hi bob', createdAt: new Date().toISOString() } })
      await spaces.put(bob, bobHalf as never, { collection: HEADER, rkey: 'self', record: conversationRecord(convKey, participants) })
      await spaces.write(bob, bobHalf as never, { collection: MESSAGE, record: { $type: MESSAGE, text: 'hi alice', createdAt: new Date().toISOString() } })

      // Each side reads the other's half with a credential minted at the other's host.
      const bobReadsAlice = await credentialAt(spaces, bob, aliceHalf, pds1)
      const aliceWriters = await settledWriters(spaces, bobReadsAlice, pds1, aliceHalf, (dids) => dids.includes(alice.did))
      expect(aliceWriters).toEqual([alice.did])
      const aliceMessages = await bobReadsAlice.clientFor(pds1).call(com.atproto.space.listRecords, {
        space: aliceHalf, repo: alice.did, collection: MESSAGE,
      })
      expect(aliceMessages.records.map((record) => record.value)).toEqual([expect.objectContaining({ text: 'hi bob' })])

      const aliceReadsBob = await credentialAt(spaces, alice, bobHalf, pds2)
      const bobMessages = await aliceReadsBob.clientFor(pds2).call(com.atproto.space.listRecords, {
        space: bobHalf as never, repo: bob.did, collection: MESSAGE,
      })
      expect(bobMessages.records.map((record) => record.value)).toEqual([expect.objectContaining({ text: 'hi alice' })])

      // A read-only member cannot become a tracked writer in someone else's half.
      const intrusion = await outcome(spaces.write(bob, aliceHalf, {
        collection: MESSAGE, record: { $type: MESSAGE, text: 'forged into alice half', createdAt: new Date().toISOString() },
      }))
      const afterIntrusion = await settledWriters(spaces, bobReadsAlice, pds1, aliceHalf)
      console.log('DM-M0 read-only member write into foreign half:', JSON.stringify(intrusion), 'writers after:', afterIntrusion)
      // The PDS stores the record in bob's own repo, but the authority never tracks
      // it, so readers must also reject any half record whose repo is not the owner.
      expect(intrusion.ok).toBe(true)
      expect(afterIntrusion).toEqual([alice.did])

      // Outsiders are refused, and the refusal does not tell an existing space from a missing one.
      const existing = await outcome(credentialAt(spaces, eve, aliceHalf, pds1))
      const missing = await outcome(credentialAt(spaces, eve, `at://${alice.did}/space/${CONVERSATION_TYPE}/3kdmmissing22`, pds1))
      console.log('DM-M0 existence oracle — existing:', JSON.stringify(existing), 'missing:', JSON.stringify(missing))
      // No existence oracle on the pinned PDS: a non-member is told SpaceNotFound for both,
      // with the same status and message, so the answer discloses nothing about the half.
      // (SpaceDeleted, below, is the only refusal that still names a space.)
      expect(existing).toMatchObject({ ok: false, error: 'SpaceNotFound' })
      expect(missing).toMatchObject({ ok: false, error: 'SpaceNotFound' })
      expect(existing).toEqual(missing)

      // Cross-app recovery: a user's own PDS lists the halves they wrote to.
      const ownHalves = await alice.client.call(
        com.atproto.space.listSpaces,
        { spaceType: CONVERSATION_TYPE },
        { headers: alice.headers },
      )
      expect(ownHalves.spaces.map((space) => space.uri)).toEqual([aliceHalf])
      const ownMembers = await alice.client.call(
        com.atproto.memberspace.listMembers,
        { space: aliceHalf },
        { headers: alice.headers },
      )
      expect(ownMembers.members).toEqual([expect.objectContaining({ did: bob.did, read: true, write: false })])

      // Revocation is unilateral and scoped to the revoker's own half.
      await spaces.removeMember(alice, aliceHalf, bob)
      await expect(credentialAt(spaces, bob, aliceHalf, pds1)).rejects.toMatchObject({ error: 'SpaceNotFound' })
      await expect(credentialAt(spaces, alice, bobHalf, pds2)).resolves.toBeInstanceOf(SpaceCredential)

      // Deleting a half removes read access to it for everyone else. SpaceDeleted is
      // checked before the policy, so even a user the policy never admitted learns the
      // half is gone (and can tell it from a half that never existed).
      await bob.client.call(com.atproto.space.deleteSpace, { space: bobHalf as never }, { headers: bob.headers })
      const afterDelete = await outcome(credentialAt(spaces, alice, bobHalf, pds2))
      const afterDeleteStranger = await outcome(credentialAt(spaces, eve, bobHalf, pds2))
      console.log('DM-M0 credential after deleteSpace — member:', JSON.stringify(afterDelete), 'non-member:', JSON.stringify(afterDeleteStranger))
      expect(afterDelete).toMatchObject({ ok: false, error: 'SpaceDeleted' })
      expect(afterDeleteStranger).toMatchObject({ ok: false, error: 'SpaceDeleted' })
    } finally {
      await network.close()
    }
  })

  it('supports every configurable inbox request policy through updateSpace', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1 })
    try {
      const spaces = new SpaceClient(network)
      const pds1 = network.pds
      const bob = await spaces.createActor('bob', pds1)
      const carol = await spaces.createActor('carol', network.extraPdses[0], 'test2')
      const dave = await spaces.createActor('dave', network.extraPdses[0], 'test2')
      const frank = await spaces.createActor('frank', network.extraPdses[0], 'test2')
      const request = (convKey: string) => ({
        $type: REQUEST, convKey, participants: [bob.did, carol.did].sort(), createdAt: new Date().toISOString(),
      })

      // "Everyone": owner-only reads, public writes.
      const inbox = await spaces.createSpace(bob, {
        spaceType: INBOX_TYPE, skey: 'self', policy: PUBLIC_WRITE_POLICY,
      })
      await spaces.put(carol, inbox, { collection: REQUEST, rkey: '3kdmcarol2222', record: request('3kdmcarol2222') })
      const bobInbox = await spaces.credentialFor(bob, inbox)
      expect(await settledWriters(spaces, bobInbox, pds1, inbox, (dids) => dids.includes(carol.did))).toContain(carol.did)
      const carolRequest = await bobInbox.clientFor(carol.pds).call(com.atproto.space.listRecords, {
        space: inbox, repo: carol.did, collection: REQUEST,
      })
      expect(carolRequest.records).toHaveLength(1)
      await expect(spaces.credentialFor(carol, inbox)).rejects.toMatchObject({ error: 'SpaceNotFound' })

      // "Only people I allow": switch policy; untracked strangers stay out.
      await bob.client.call(
        com.atproto.space.updateSpace,
        { space: inbox, policy: MEMBER_LIST_POLICY },
        { headers: bob.headers },
      )
      const carolAfterSwitch = await writerDids(await spaces.credentialFor(bob, inbox), pds1, inbox)
      console.log('DM-M0 writer tracked under public policy still listed after switch to memberList:', carolAfterSwitch.includes(carol.did))
      // Tightening the policy via updateSpace alone does not evict already-tracked
      // writers (it does not re-evaluate the writer set); clients must filter requests
      // by the current allowlist themselves.
      expect(carolAfterSwitch).toContain(carol.did)

      await spaces.put(dave, inbox, { collection: REQUEST, rkey: '3kdmdave22222', record: request('3kdmdave22222') })
      expect(await settledWriters(spaces, await spaces.credentialFor(bob, inbox), pds1, inbox)).not.toContain(dave.did)

      await spaces.putMember(bob, inbox, frank, WRITE_ONLY)
      await spaces.put(frank, inbox, { collection: REQUEST, rkey: '3kdmfrank2222', record: request('3kdmfrank2222') })
      expect(await settledWriters(spaces, await spaces.credentialFor(bob, inbox), pds1, inbox, (dids) => dids.includes(frank.did))).toContain(frank.did)
      await expect(spaces.credentialFor(frank, inbox)).rejects.toMatchObject({ error: 'SpaceNotFound' })

      // "Nobody": memberList with the allowlist emptied. Removing the member also drops it
      // from the writer set, so listRepos stops advertising its repo straight away.
      await spaces.removeMember(bob, inbox, frank)
      expect(await writerDids(await spaces.credentialFor(bob, inbox), pds1, inbox)).not.toContain(frank.did)
      const frankRevRemoved = await outcome(spaces.put(frank, inbox, { collection: REQUEST, rkey: '3kdmfrank2223', record: request('3kdmfrank2223') }))
      const frankRequestsAfterRemoval = await (await spaces.credentialFor(bob, inbox)).clientFor(frank.pds).call(com.atproto.space.listRecords, {
        space: inbox, repo: frank.did, collection: REQUEST,
      })
      console.log('DM-M0 removed writer put outcome:', JSON.stringify(frankRevRemoved), 'records still readable by owner:', frankRequestsAfterRemoval.records.length)
      // The removed account can still write into its own repo and the owner can still read it
      // with a space credential, but the authority refuses to track the new write, so the
      // writer stays out of listRepos: clients must also filter by the current allowlist.
      expect(frankRevRemoved.ok).toBe(true)
      expect(frankRequestsAfterRemoval.records).toHaveLength(2)
      expect(await settledWriters(spaces, await spaces.credentialFor(bob, inbox), pds1, inbox)).not.toContain(frank.did)

      // Switching back to "Everyone" lets a previously ignored or evicted writer through on
      // their next write: a removed account is tracked again only if it writes again while
      // authorized.
      await bob.client.call(
        com.atproto.space.updateSpace,
        { space: inbox, policy: PUBLIC_WRITE_POLICY },
        { headers: bob.headers },
      )
      await spaces.put(dave, inbox, { collection: REQUEST, rkey: '3kdmdave22222', record: request('3kdmdave22222') })
      await spaces.put(frank, inbox, { collection: REQUEST, rkey: '3kdmfrank2224', record: request('3kdmfrank2224') })
      const everyoneWriters = await settledWriters(spaces, await spaces.credentialFor(bob, inbox), pds1, inbox, (dids) => dids.includes(dave.did) && dids.includes(frank.did))
      expect(everyoneWriters).toContain(dave.did)
      expect(everyoneWriters).toContain(frank.did)
    } finally {
      await network.close()
    }
  })

  it('lets a browser-style public OAuth client with non-extractable WebCrypto keys run the DM flow', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true })
    try {
      const lexiconAgent = network.pds.getAgent()
      const lexiconSession = await lexiconAgent.com.atproto.server.createSession({ identifier: 'lex-authority.test', password: 'hunter2' })
      for (const [id, collections] of [[INBOX_TYPE, [REQUEST]], [CONVERSATION_TYPE, [HEADER, MESSAGE]]] as const) {
        await lexiconAgent.com.atproto.repo.createRecord(
          {
            repo: network.lexiconAuthority!.did,
            collection: 'com.atproto.lexicon.schema',
            rkey: id,
            record: { lexicon: 1, id, defs: { main: { type: 'space', key: 'any', name: id, collections } } },
          },
          { headers: { authorization: `Bearer ${lexiconSession.data.accessJwt}` } },
        )
      }

      const spaces = new SpaceClient(network)
      const pds1 = network.pds
      const pds2 = network.extraPdses[0]
      const alice = await spaces.createActor('alice', pds1)
      const bob = await spaces.createActor('bob', pds2, 'test2')
      const convKey = '3kdmoauthconv'

      const bobInbox = `at://${bob.did}/space/${INBOX_TYPE}/self`
      const bobHalf = `at://${bob.did}/space/${CONVERSATION_TYPE}/${convKey}`
      for (const [type, skey, policy] of [[INBOX_TYPE, 'self', PUBLIC_WRITE_POLICY], [CONVERSATION_TYPE, convKey, MEMBER_LIST_POLICY]] as const) {
        await bob.client.call(com.atproto.space.createSpace, {
          spaceType: type, skey, policy,
        }, { headers: bob.headers })
      }
      await bob.client.call(com.atproto.memberspace.putMember, { space: bobHalf as never, did: alice.did, ...READ_ONLY }, { headers: bob.headers })
      await spaces.write(bob, bobHalf as never, { collection: MESSAGE, record: { $type: MESSAGE, text: 'from bob', createdAt: new Date().toISOString() } })

      // Browser key: private half never leaves WebCrypto.
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      const spaceKey = await webCryptoSpaceKey()
      expect(pair.privateKey.extractable).toBe(false)
      const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey)
      const jwk = { kty: kty!, crv: crv!, x: x!, y: y! }
      const b64u = (bytes: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof bytes === 'string' ? bytes : new Uint8Array(bytes)).toString('base64url')
      const proof = async (htm: string, url: string, token?: string, nonce?: string) => {
        const target = new URL(url)
        const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk }))
        const payload = b64u(JSON.stringify({
          jti: randomUUID(),
          htm,
          htu: `${target.origin}${target.pathname}`,
          iat: Math.floor(Date.now() / 1000),
          ...(token ? { ath: b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))) } : {}),
          ...(nonce ? { nonce } : {}),
        }))
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
        return `${header}.${payload}.${b64u(signature)}`
      }

      const oauth = pds1.ctx.oauthProvider!
      const clientId = 'https://slack.example/dm-client-metadata.json'
      const metadata = {
        client_id: clientId,
        client_name: 'Slack DM browser conformance client',
        redirect_uris: ['https://slack.example/dm-callback'],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        scope: 'atproto',
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
      }
      const client = new Client(clientId as never, metadata as never, undefined, { isFirstParty: false, isTrusted: false })
      const account = (await oauth.accountManager.getAccount(alice.did)).account
      const issue = async (scope: string) => oauth.tokenManager.createToken(
        client,
        { method: 'none' },
        { ipAddress: '127.0.0.1', port: 443 },
        account,
        null,
        {
          client_id: clientId,
          redirect_uri: 'https://slack.example/dm-callback',
          response_type: 'code',
          scope,
          dpop_jkt: await calculateJwkThumbprint(jwk, 'sha256'),
        },
        await generateCode(),
      )
      const dmScope = [
        'atproto',
        `space:${INBOX_TYPE}?authority=*&collection=${REQUEST}&action=create&action=update`,
        `space:${CONVERSATION_TYPE}?authority=*&action=read`,
        `space:${CONVERSATION_TYPE}?authority=${alice.did}&action=read_self&action=create&action=update&action=delete&manage=create&manage=update`,
      ].join(' ')
      const dmToken = await issue(dmScope)

      let nonce: string | undefined
      const callAsOAuth = async (accessToken: string, nsid: string, body?: unknown, params?: Record<string, string>) => {
        const method = params ? 'GET' : 'POST'
        const url = new URL(`/xrpc/${nsid}`, pds1.url)
        for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value)
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch(url, {
            method,
            headers: {
              authorization: `DPoP ${accessToken}`,
              dpop: await proof(method, url.toString(), accessToken, nonce),
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
          nonce = response.headers.get('DPoP-Nonce') ?? nonce
          if (response.status === 401 && nonce && attempt === 0) continue
          if (!response.ok) throw new Error(`${nsid} failed (${response.status}): ${await response.text()}`)
          const text = await response.text()
          return text ? (JSON.parse(text) as Record<string, unknown>) : undefined
        }
        throw new Error(`${nsid} exhausted DPoP nonce retry`)
      }

      // (c) Wildcard-authority request write, restricted to the request collection.
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.putRecord', {
        space: bobInbox, repo: alice.did, collection: REQUEST, rkey: convKey,
        record: { $type: REQUEST, convKey, participants: [alice.did, bob.did].sort(), createdAt: new Date().toISOString() },
      })
      await expect(callAsOAuth(dmToken.access_token, 'com.atproto.space.putRecord', {
        space: bobInbox, repo: alice.did, collection: MESSAGE, rkey: convKey,
        record: { $type: MESSAGE, text: 'wrong collection', createdAt: new Date().toISOString() },
      })).rejects.toThrow(/space:|scope|Insufficient/i)
      const bobReadsInbox = await credentialAt(spaces, bob, bobInbox as never, pds2)
      expect(await settledWriters(spaces, bobReadsInbox, pds2, bobInbox, (dids) => dids.includes(alice.did))).toContain(alice.did)

      // Own half: manage=create / manage=update from the browser session.
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.createSpace', {
        spaceType: CONVERSATION_TYPE, skey: convKey,
        policy: MEMBER_LIST_POLICY,
      })
      const aliceHalf = `at://${alice.did}/space/${CONVERSATION_TYPE}/${convKey}`
      await callAsOAuth(dmToken.access_token, 'com.atproto.memberspace.putMember', { space: aliceHalf, did: bob.did, ...READ_ONLY })
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.createRecord', {
        space: aliceHalf, repo: alice.did, collection: MESSAGE,
        record: { $type: MESSAGE, text: 'from alice browser', createdAt: new Date().toISOString() },
      })

      // (e) Delegation token from the browser session, exchanged at bob's host with a WebCrypto message signature.
      const delegation = await callAsOAuth(dmToken.access_token, 'com.atproto.space.getDelegationToken', undefined, { space: bobHalf })
      const exchangeUrl = new URL('/xrpc/com.atproto.space.getSpaceCredential', pds2.url).toString()
      const exchange = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ space: bobHalf, credentialKid: spaceKey.did(), delegationToken: delegation!.token as string }),
      })
      expect(exchange.status).toBe(200)
      const { credential } = (await exchange.json()) as { credential: string }
      const readUrl = new URL('/xrpc/com.atproto.space.listRecords', pds2.url)
      readUrl.searchParams.set('space', bobHalf)
      readUrl.searchParams.set('repo', bob.did)
      readUrl.searchParams.set('collection', MESSAGE)
      const read = await fetch(readUrl, {
        headers: await createSpaceSigHeaders(spaceKey, { authorization: `Atproto-Space-Credential ${credential}`, audience: bob.did }),
      })
      expect(read.status).toBe(200)
      expect(((await read.json()) as { records: Array<{ value: { text: string } }> }).records.map((record) => record.value.text)).toEqual(['from bob'])

      // A session without DM scopes can do none of this.
      const plainToken = await issue('atproto')
      await expect(callAsOAuth(plainToken.access_token, 'com.atproto.space.getDelegationToken', undefined, { space: bobHalf })).rejects.toThrow()
      await expect(callAsOAuth(plainToken.access_token, 'com.atproto.space.putRecord', {
        space: bobInbox, repo: alice.did, collection: REQUEST, rkey: '3kdmnoscope22',
        record: { $type: REQUEST, convKey: '3kdmnoscope22', participants: [alice.did, bob.did].sort(), createdAt: new Date().toISOString() },
      })).rejects.toThrow()
    } finally {
      await network.close()
    }
  })

  it('handles a 100-participant conversation: 100 halves, 100 members each, 100 credential mints', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1 })
    try {
      const spaces = new SpaceClient(network)
      const hosts = [network.pds, network.extraPdses[0]]
      const participants: Actor[] = []
      for (let index = 0; index < 100; index++) {
        participants.push(await spaces.createActor(`dm${index}`, hosts[index % 2], index % 2 ? 'test2' : 'test'))
      }
      const convKey = '3kdmhundred22'
      const setupStarted = performance.now()
      const halves = await Promise.all(participants.map(async (owner) => {
        const half = `at://${owner.did}/space/${CONVERSATION_TYPE}/${convKey}` as const
        await owner.client.call(com.atproto.space.createSpace, {
          spaceType: CONVERSATION_TYPE, skey: convKey,
          policy: MEMBER_LIST_POLICY,
        }, { headers: owner.headers })
        for (const member of participants) {
          if (member.did === owner.did) continue
          await owner.client.call(com.atproto.memberspace.putMember, { space: half as never, did: member.did, ...READ_ONLY }, { headers: owner.headers })
        }
        await spaces.write(owner, half as never, { collection: MESSAGE, record: { $type: MESSAGE, text: `from ${owner.name}`, createdAt: new Date().toISOString() } })
        return { owner, half }
      }))
      const setupMs = performance.now() - setupStarted

      const firstMembers = await participants[0].client.call(
        com.atproto.memberspace.listMembers,
        { space: halves[0].half as never, limit: 1000 },
        { headers: participants[0].headers },
      )
      expect(firstMembers.members).toHaveLength(99)

      const reader = participants[1]
      const readStarted = performance.now()
      const texts: string[] = []
      let next = 0
      await Promise.all(Array.from({ length: 8 }, async () => {
        for (;;) {
          const index = next++
          if (index >= halves.length) return
          const { owner, half } = halves[index]
          const credential = await credentialAt(spaces, reader, half, owner.pds)
          const page = await credential.clientFor(owner.pds).call(com.atproto.space.listRecords, {
            space: half as never, repo: owner.did, collection: MESSAGE,
          })
          texts.push(...page.records.map((record) => (record.value as { text: string }).text))
        }
      }))
      const readMs = performance.now() - readStarted
      console.log(`DM-M0 100-participant setup ${Math.round(setupMs)} ms (100 createSpace, 9,900 putMember, 100 writes); reader minted 100 credentials and read 100 halves in ${Math.round(readMs)} ms at concurrency 8`)
      expect(texts).toHaveLength(100)
    } finally {
      await network.close()
    }
  }, 15 * 60 * 1000)

  it('grants and withholds exactly what DM_BROWSER_SCOPES (src/auth/permission-sets.ts, M3) says it does', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true })
    try {
      const lexiconAgent = network.pds.getAgent()
      const lexiconSession = await lexiconAgent.com.atproto.server.createSession({ identifier: 'lex-authority.test', password: 'hunter2' })
      for (const [id, collections] of [[INBOX_TYPE, [REQUEST]], [CONVERSATION_TYPE, [HEADER, MESSAGE, REACTION]]] as const) {
        await lexiconAgent.com.atproto.repo.createRecord(
          {
            repo: network.lexiconAuthority!.did,
            collection: 'com.atproto.lexicon.schema',
            rkey: id,
            record: { lexicon: 1, id, defs: { main: { type: 'space', key: 'any', name: id, collections } } },
          },
          { headers: { authorization: `Bearer ${lexiconSession.data.accessJwt}` } },
        )
      }

      const spaces = new SpaceClient(network)
      const pds1 = network.pds
      const pds2 = network.extraPdses[0]
      const alice = await spaces.createActor('alice', pds1)
      const bob = await spaces.createActor('bob', pds2, 'test2')
      const convKey = '3kdmscopetst1'

      const bobInbox = `at://${bob.did}/space/${INBOX_TYPE}/self`
      const bobHalf = `at://${bob.did}/space/${CONVERSATION_TYPE}/${convKey}`
      for (const [type, skey, policy] of [[INBOX_TYPE, 'self', PUBLIC_WRITE_POLICY], [CONVERSATION_TYPE, convKey, MEMBER_LIST_POLICY]] as const) {
        await bob.client.call(com.atproto.space.createSpace, {
          spaceType: type, skey, policy,
        }, { headers: bob.headers })
      }
      await bob.client.call(com.atproto.memberspace.putMember, { space: bobHalf as never, did: alice.did, ...READ_ONLY }, { headers: bob.headers })
      await spaces.write(bob, bobHalf as never, { collection: MESSAGE, record: { $type: MESSAGE, text: 'from bob', createdAt: new Date().toISOString() } })

      // Browser key: private half never leaves WebCrypto (same shape as the OAuth-client test above).
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
      const spaceKey = await webCryptoSpaceKey()
      const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey)
      const jwk = { kty: kty!, crv: crv!, x: x!, y: y! }
      const b64u = (bytes: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof bytes === 'string' ? bytes : new Uint8Array(bytes)).toString('base64url')
      const proof = async (htm: string, url: string, token?: string, nonce?: string) => {
        const target = new URL(url)
        const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk }))
        const payload = b64u(JSON.stringify({
          jti: randomUUID(),
          htm,
          htu: `${target.origin}${target.pathname}`,
          iat: Math.floor(Date.now() / 1000),
          ...(token ? { ath: b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))) } : {}),
          ...(nonce ? { nonce } : {}),
        }))
        const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
        return `${header}.${payload}.${b64u(signature)}`
      }

      const oauth = pds1.ctx.oauthProvider!
      const clientId = 'https://slack.example/dm-client-metadata.json'
      const metadata = {
        client_id: clientId,
        client_name: 'Slack DM browser scope conformance client',
        redirect_uris: ['https://slack.example/dm/callback'],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        scope: 'atproto',
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
      }
      const client = new Client(clientId as never, metadata as never, undefined, { isFirstParty: false, isTrusted: false })
      const account = (await oauth.accountManager.getAccount(alice.did)).account
      const issue = async (scope: string) => oauth.tokenManager.createToken(
        client,
        { method: 'none' },
        { ipAddress: '127.0.0.1', port: 443 },
        account,
        null,
        {
          client_id: clientId,
          redirect_uri: 'https://slack.example/dm/callback',
          response_type: 'code',
          scope,
          dpop_jkt: await calculateJwkThumbprint(jwk, 'sha256'),
        },
        await generateCode(),
      )

      // Copied verbatim from DM_BROWSER_SCOPES in src/auth/permission-sets.ts (M3).
      // That file cannot be imported here (this test runs inside the pinned PDS
      // checkout), so the strings are transcribed and must be kept in sync by hand.
      const DM_BROWSER_SCOPES = [
        'atproto',
        `space:${INBOX_TYPE}?authority=*&collection=${REQUEST}&action=create&action=update&action=delete`,
        `space:${INBOX_TYPE}?authority=self&action=read&manage=create&manage=update`,
        'repo:new.flock.dm.declaration?action=create&action=update',
        `space:${CONVERSATION_TYPE}?authority=self&collection=${HEADER}&collection=${MESSAGE}&collection=${REACTION}&action=create&action=update&action=delete&manage=create&manage=update&manage=delete`,
        `space:${CONVERSATION_TYPE}?authority=*&action=read`,
      ]
      const dmToken = await issue(DM_BROWSER_SCOPES.join(' '))

      let nonce: string | undefined
      const callAsOAuth = async (accessToken: string, nsid: string, body?: unknown, params?: Record<string, string>) => {
        const method = params ? 'GET' : 'POST'
        const url = new URL(`/xrpc/${nsid}`, pds1.url)
        for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, value)
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch(url, {
            method,
            headers: {
              authorization: `DPoP ${accessToken}`,
              dpop: await proof(method, url.toString(), accessToken, nonce),
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
          nonce = response.headers.get('DPoP-Nonce') ?? nonce
          if (response.status === 401 && nonce && attempt === 0) continue
          if (!response.ok) throw new Error(`${nsid} failed (${response.status}): ${await response.text()}`)
          const text = await response.text()
          return text ? (JSON.parse(text) as Record<string, unknown>) : undefined
        }
        throw new Error(`${nsid} exhausted DPoP nonce retry`)
      }

      // --- capabilities DM_BROWSER_SCOPES grants ---

      // create its own inbox
      const aliceInbox = `at://${alice.did}/space/${INBOX_TYPE}/self`
      const createdInbox = await callAsOAuth(dmToken.access_token, 'com.atproto.space.createSpace', {
        spaceType: INBOX_TYPE, skey: 'self', policy: MEMBER_LIST_POLICY,
      })
      expect(createdInbox!.uri).toBe(aliceInbox)

      // updateSpace its inbox policy
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.updateSpace', { space: aliceInbox, policy: PUBLIC_WRITE_POLICY })

      // putMember / removeMember on its own inbox
      await callAsOAuth(dmToken.access_token, 'com.atproto.memberspace.putMember', { space: aliceInbox, did: bob.did, ...WRITE_ONLY })
      await callAsOAuth(dmToken.access_token, 'com.atproto.memberspace.removeMember', { space: aliceInbox, did: bob.did })

      // create its own half
      const aliceHalf = `at://${alice.did}/space/${CONVERSATION_TYPE}/${convKey}`
      const createdHalf = await callAsOAuth(dmToken.access_token, 'com.atproto.space.createSpace', {
        spaceType: CONVERSATION_TYPE, skey: convKey, policy: MEMBER_LIST_POLICY,
      })
      expect(createdHalf!.uri).toBe(aliceHalf)

      // putMember / removeMember on its own half
      await callAsOAuth(dmToken.access_token, 'com.atproto.memberspace.putMember', { space: aliceHalf, did: bob.did, ...READ_ONLY })
      await callAsOAuth(dmToken.access_token, 'com.atproto.memberspace.removeMember', { space: aliceHalf, did: bob.did })

      // write header, message and reaction records in its own half
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.createRecord', {
        space: aliceHalf, repo: alice.did, collection: HEADER, rkey: 'self',
        record: { $type: HEADER, convKey, participants: [alice.did, bob.did].sort(), createdAt: new Date().toISOString() },
      })
      const messageWrite = await callAsOAuth(dmToken.access_token, 'com.atproto.space.createRecord', {
        space: aliceHalf, repo: alice.did, collection: MESSAGE,
        record: { $type: MESSAGE, text: 'hello from the browser scope conformance test', createdAt: new Date().toISOString() },
      })
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.createRecord', {
        space: aliceHalf, repo: alice.did, collection: REACTION,
        record: { $type: REACTION, subject: messageWrite!.uri, emoji: '👍', createdAt: new Date().toISOString() },
      })

      // deleteSpace its own half
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.deleteSpace', { space: aliceHalf })

      // publish the public inbox declaration in its own repo (the one repo grant)
      const DECLARATION = 'new.flock.dm.declaration'
      await callAsOAuth(dmToken.access_token, 'com.atproto.repo.putRecord', {
        repo: alice.did, collection: DECLARATION, rkey: 'self', record: { $type: DECLARATION, createdAt: new Date().toISOString() },
      })

      // write a request into another user's inbox (collection-restricted, wildcard authority)
      await callAsOAuth(dmToken.access_token, 'com.atproto.space.putRecord', {
        space: bobInbox, repo: alice.did, collection: REQUEST, rkey: convKey,
        record: { $type: REQUEST, convKey, participants: [alice.did, bob.did].sort(), createdAt: new Date().toISOString() },
      })
      const bobReadsInbox = await credentialAt(spaces, bob, bobInbox as never, pds2)
      expect(await settledWriters(spaces, bobReadsInbox, pds2, bobInbox, (dids) => dids.includes(alice.did))).toContain(alice.did)

      // get a delegation token for another user's half, and read through it end to end
      const delegation = await callAsOAuth(dmToken.access_token, 'com.atproto.space.getDelegationToken', undefined, { space: bobHalf })
      const exchangeUrl = new URL('/xrpc/com.atproto.space.getSpaceCredential', pds2.url).toString()
      const exchange = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ space: bobHalf, credentialKid: spaceKey.did(), delegationToken: delegation!.token as string }),
      })
      expect(exchange.status).toBe(200)
      const { credential } = (await exchange.json()) as { credential: string }
      const readUrl = new URL('/xrpc/com.atproto.space.listRecords', pds2.url)
      readUrl.searchParams.set('space', bobHalf)
      readUrl.searchParams.set('repo', bob.did)
      readUrl.searchParams.set('collection', MESSAGE)
      const read = await fetch(readUrl, {
        headers: await createSpaceSigHeaders(spaceKey, { authorization: `Atproto-Space-Credential ${credential}`, audience: bob.did }),
      })
      expect(read.status).toBe(200)
      expect(((await read.json()) as { records: Array<{ value: { text: string } }> }).records.map((record) => record.value.text)).toEqual(['from bob'])

      // --- capabilities DM_BROWSER_SCOPES withholds ---

      // cannot putMember on another user's half
      await expect(callAsOAuth(dmToken.access_token, 'com.atproto.memberspace.putMember', { space: bobHalf, did: alice.did, ...WRITE_ONLY }))
        .rejects.toThrow()

      // cannot write a message record into another user's inbox (only the request collection is granted there)
      await expect(callAsOAuth(dmToken.access_token, 'com.atproto.space.createRecord', {
        space: bobInbox, repo: alice.did, collection: MESSAGE, record: { $type: MESSAGE, text: 'not a request', createdAt: new Date().toISOString() },
      })).rejects.toThrow()

      // cannot write any other collection into its own public repo (only the declaration is granted)
      await expect(callAsOAuth(dmToken.access_token, 'com.atproto.repo.putRecord', {
        repo: alice.did, collection: 'app.bsky.feed.post', rkey: 'self', record: { $type: 'app.bsky.feed.post', text: 'nope', createdAt: new Date().toISOString() },
      })).rejects.toThrow()

      // cannot get a delegation token for another user's inbox (the inbox read grant is gone: senders read the declaration instead)
      await expect(callAsOAuth(dmToken.access_token, 'com.atproto.space.getDelegationToken', undefined, { space: bobInbox })).rejects.toThrow()

      // cannot create a space of a non-DM type
      await expect(callAsOAuth(dmToken.access_token, 'com.atproto.space.createSpace', {
        spaceType: 'new.flock.channel', skey: 'general', policy: MEMBER_LIST_POLICY,
      })).rejects.toThrow()
    } finally {
      await network.close()
    }
  })
})
