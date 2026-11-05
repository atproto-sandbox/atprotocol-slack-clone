import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestNetworkNoAppView } from '@atproto/dev-env'
import { createSpaceToken, parseSpaceToken, SPACE_CREDENTIAL_MAX_AGE_SEC } from '@atproto/space'
import type { DidString, NsidString } from '@atproto/syntax'
import { com } from '../../src/lexicons/index.js'
import { SpaceClient, SpaceCredential } from '../_space.js'

const previousTmpdir = process.env.TMPDIR
const fixtureTmpdir = mkdtempSync(join(tmpdir(), 'slack-inbox-conformance-'))
process.env.TMPDIR = fixtureTmpdir

afterAll(() => {
  try {
    rmSync(fixtureTmpdir, { recursive: true, force: true })
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
})

const REQUEST_COLLECTION = 'org.slack.joinRequest' as NsidString
const WORKSPACE_TYPE = 'org.slack.workspace' as NsidString
const INBOX_TYPE = 'org.slack.inbox' as NsidString
const CHANNEL_TYPE = 'org.slack.channel' as NsidString

describe('atproto Slack inbox protocol conformance', () => {
  it('separates request writing from inbox reading across PDS hosts', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1 })
    try {
      const spaces = new SpaceClient(network)
      const authority = await spaces.createActor('alice', network.pds)
      const admin = await spaces.createActor('bob', network.pds)
      const requester = await spaces.createActor(
        'carol',
        network.extraPdses[0],
        'test2',
      )
      const ordinary = await spaces.createActor(
        'dan',
        network.extraPdses[0],
        'test2',
      )

      const workspace = await spaces.createSpace(authority, {
        spaceType: WORKSPACE_TYPE,
        skey: 'workspace',
        members: [admin, requester, ordinary],
      })
      await spaces.write(authority, workspace, {
        collection: 'org.slack.directory' as NsidString,
        rkey: 'secret',
        record: {
          $type: 'org.slack.directory',
          skey: 'secret',
          name: 'secret',
          visibility: 'private',
        },
      })
      await spaces.write(requester, workspace, {
        collection: 'org.slack.acceptance' as NsidString,
        rkey: 'a-discovery',
        record: {
          $type: 'org.slack.acceptance',
          workspace,
          createdAt: new Date().toISOString(),
        },
      })

      // A second reader needs only the published lexicons, account OAuth, and
      // a space credential. It discovers this workspace through the invitee's
      // own PDS after the acceptance record is written.
      const discovered = await requester.client.call(
        com.atproto.space.listSpaces,
        { spaceType: WORKSPACE_TYPE, did: authority.did },
        { headers: requester.headers },
      )
      expect(discovered.spaces.map((space) => space.uri)).toContain(workspace)
      const workspaceCredential = await spaces.credentialFor(
        requester,
        workspace,
      )
      const secondAppDirectory = await workspaceCredential
        .clientFor(authority.pds)
        .call(com.atproto.space.listRecords, {
          space: workspace,
          repo: authority.did,
          collection: 'org.slack.directory' as NsidString,
        })
      expect(secondAppDirectory.records[0].value).toMatchObject({
        skey: 'secret',
        visibility: 'private',
      })

      const privateChannel = await spaces.createSpace(authority, {
        spaceType: CHANNEL_TYPE,
        skey: 'secret',
        members: [admin, requester],
      })
      await spaces.write(requester, privateChannel, {
        collection: 'org.slack.channel.message' as NsidString,
        rkey: 'message',
        record: {
          $type: 'org.slack.channel.message',
          text: 'only joined members can fetch this repo',
          createdAt: new Date().toISOString(),
        },
      })
      await expect(
        spaces.credentialFor(ordinary, privateChannel),
      ).rejects.toMatchObject({ error: 'SpaceNotFound' })

      const inbox = await spaces.createSpace(authority, {
        spaceType: INBOX_TYPE,
        skey: 'inbox',
        members: [admin],
      })
      await spaces.putMember(authority, inbox, requester, {
        read: false,
        write: true,
      })
      await spaces.putMember(authority, inbox, ordinary, {
        read: false,
        write: true,
      })

      const memberList = await authority.client.call(
        com.atproto.memberspace.listMembers,
        { space: inbox },
        { headers: authority.headers },
      )
      expect(memberList.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ did: admin.did, read: true, write: true }),
          expect.objectContaining({
            did: requester.did,
            read: false,
            write: true,
          }),
          expect.objectContaining({
            did: ordinary.did,
            read: false,
            write: true,
          }),
        ]),
      )

      const request = {
        $type: REQUEST_COLLECTION,
        channelSkey: 'private',
        requestId: '3jzfcijpj2z2a',
        createdAt: new Date().toISOString(),
      }
      await spaces.write(requester, inbox, {
        collection: REQUEST_COLLECTION,
        record: request,
      })

      const adminCredential = await spaces.credentialFor(admin, inbox)
      const adminReader = adminCredential.clientFor(authority.pds)
      const writers = await spaces.awaitNotify(
        () => adminReader.call(com.atproto.space.listRepos, { space: inbox }),
        (result) => result.repos.some((repo) => repo.did === requester.did),
      )
      expect(writers.repos.map((repo) => repo.did)).toContain(requester.did)

      const adminRead = await adminCredential
        .clientFor(requester.pds)
        .call(com.atproto.space.listRecords, {
          space: inbox,
          repo: requester.did,
          collection: REQUEST_COLLECTION,
        })
      expect(adminRead.records.map((record) => record.value)).toContainEqual(
        request,
      )

      // A request author can read their own repo, but cannot turn the write
      // membership bit into a whole-space credential. The refusal is SpaceNotFound,
      // the same answer a missing space gets, so it does not confirm the inbox exists.
      const requesterOwnRead = await requester.client.call(
        com.atproto.space.listRecords,
        { space: inbox, repo: requester.did, collection: REQUEST_COLLECTION },
        { headers: requester.headers },
      )
      expect(requesterOwnRead.records).toHaveLength(1)
      await expect(spaces.credentialFor(requester, inbox)).rejects.toMatchObject(
        { error: 'SpaceNotFound' },
      )
      await expect(spaces.credentialFor(ordinary, inbox)).rejects.toMatchObject(
        { error: 'SpaceNotFound' },
      )

      // The member's own OAuth/PDS identity cannot fetch another writer's repo.
      await expect(
        ordinary.client.call(
          com.atproto.space.listRecords,
          { space: inbox, repo: requester.did, collection: REQUEST_COLLECTION },
          { headers: ordinary.headers },
        ),
      ).rejects.toMatchObject({ error: 'RepoNotFound' })

      // The authority has access even without being listed as a member.
      const authorityCredential = await spaces.credentialFor(authority, inbox)
      await expect(
        authorityCredential
          .clientFor(requester.pds)
          .call(com.atproto.space.listRecords, {
            space: inbox,
            repo: requester.did,
            collection: REQUEST_COLLECTION,
          }),
      ).resolves.toMatchObject({ records: expect.any(Array) })

      // A user-level admin record cannot grant PDS management authority: only
      // the workspace DID session owns this space and can mutate its members.
      await spaces.write(authority, inbox, {
        collection: 'org.slack.admin' as NsidString,
        record: {
          $type: 'org.slack.admin',
          subject: admin.did,
          active: true,
          updatedAt: new Date().toISOString(),
        },
      })
      await expect(
        admin.client.call(
          com.atproto.memberspace.putMember,
          { space: inbox, did: ordinary.did, read: true, write: true },
          { headers: admin.headers },
        ),
      ).rejects.toMatchObject({ error: 'NotSpaceOwner' })

    } finally {
      await network.close()
    }
  })

  it('can recover a write whose PDS-to-authority writer notification was dropped', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1 })
    try {
      const spaces = new SpaceClient(network)
      const authority = await spaces.createActor('alice', network.pds)
      const admin = await spaces.createActor('bob', network.pds)
      const requester = await spaces.createActor('carol', network.extraPdses[0], 'test2')
      const inbox = await spaces.createSpace(authority, {
        spaceType: INBOX_TYPE,
        skey: 'inbox',
        members: [admin],
      })
      await spaces.putMember(authority, inbox, requester, { read: false, write: true })

      const didResolver = requester.pds.ctx.idResolver.did
      const resolve = didResolver.resolve.bind(didResolver)
      didResolver.resolve = async (did: string, ...args: unknown[]) => {
        if (did === authority.did) return null
        return resolve(did as never, ...(args as never[]))
      }
      try {
        await spaces.write(requester, inbox, {
          collection: REQUEST_COLLECTION,
          rkey: 'r-dropped-notification',
          record: {
            $type: REQUEST_COLLECTION,
            channelSkey: 'private',
            requestId: '3jzfcijpj2z2b',
            createdAt: new Date().toISOString(),
          },
        })
      } finally {
        didResolver.resolve = resolve
      }

      const credential = await spaces.credentialFor(admin, inbox)
      const adminReader = credential.clientFor(authority.pds)
      const repos = await adminReader.call(com.atproto.space.listRepos, { space: inbox })
      expect(repos.repos.map((repo) => repo.did)).not.toContain(requester.did)

      // The authority owner can enumerate write members. The admin's valid
      // read credential can fetch the request directly even though listRepos
      // does not list its writer.
      const members = await authority.client.call(
        com.atproto.memberspace.listMembers,
        { space: inbox },
        { headers: authority.headers },
      )
      expect(members.members).toContainEqual(
        expect.objectContaining({ did: requester.did, read: false, write: true }),
      )
      const recovered = await credential
        .clientFor(requester.pds)
        .call(com.atproto.space.listRecords, {
          space: inbox,
          repo: requester.did,
          collection: REQUEST_COLLECTION,
        })
      expect(recovered.records).toHaveLength(1)
      expect(recovered.records[0].value).toMatchObject({ channelSkey: 'private' })
    } finally {
      await network.close()
    }
  })

  it('issues ten minute credentials capped at one hour and rejects new credentials after removal', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1 })
    try {
      const spaces = new SpaceClient(network)
      const authority = await spaces.createActor('alice', network.pds)
      const member = await spaces.createActor('bob', network.extraPdses[0], 'test2')
      const inbox = await spaces.createSpace(authority, {
        spaceType: INBOX_TYPE,
        skey: 'inbox',
        members: [member],
      })
      await spaces.write(authority, inbox, { collection: 'org.slack.admin' as NsidString })
      await spaces.write(member, inbox, {
        collection: REQUEST_COLLECTION,
        rkey: 'r-short-lived-credential',
        record: {
          $type: REQUEST_COLLECTION,
          channelSkey: 'private',
          requestId: '3jzfcijpj2z2c',
          createdAt: new Date().toISOString(),
        },
      })

      const issued = await spaces.credentialFor(member, inbox)
      const payload = parseSpaceToken('credential', issued.credential).payload
      expect(payload.exp - payload.iat).toBe(600)
      expect(SPACE_CREDENTIAL_MAX_AGE_SEC).toBe(3600)

      await spaces.removeMember(authority, inbox, member)
      await expect(spaces.credentialFor(member, inbox)).rejects.toMatchObject({
        error: 'SpaceNotFound',
      })
      await expect(
        issued.clientFor(authority.pds).call(com.atproto.space.getLatestCommit, {
          space: inbox,
          repo: authority.did,
        }),
      ).resolves.toBeDefined()

      const shortKey = issued.key
      const shortCredential = await createSpaceToken(
        'credential',
        {
          iss: authority.did,
          sub: inbox,
          keyId: shortKey.did() as DidString,
          expiresInSec: 10,
        },
        await authority.pds.ctx.actorStore.keypair(authority.did),
      )
      await expect(createSpaceToken(
        'credential',
        { iss: authority.did, sub: inbox, keyId: shortKey.did() as DidString, expiresInSec: SPACE_CREDENTIAL_MAX_AGE_SEC + 1 },
        await authority.pds.ctx.actorStore.keypair(authority.did),
      )).rejects.toThrow(/lifetime/)
      const shortPayload = parseSpaceToken('credential', shortCredential).payload
      const shortLived = new SpaceCredential(shortCredential, shortKey, spaces.idResolver)
      for (const [pds, repo, collection] of [
        [authority.pds, authority.did, 'org.slack.admin' as NsidString],
        [member.pds, member.did, REQUEST_COLLECTION],
      ] as const) {
        await expect(shortLived.clientFor(pds).call(com.atproto.space.listRecords, {
          space: inbox,
          repo,
          collection,
        })).resolves.toMatchObject({ records: expect.any(Array) })
      }
      const waitUntil = async (target: number) => {
        const delay = target - Date.now()
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      }
      await waitUntil(shortPayload.exp * 1000 + 2_000)
      for (const [pds, repo, collection] of [
        [authority.pds, authority.did, 'org.slack.admin' as NsidString],
        [member.pds, member.did, REQUEST_COLLECTION],
      ] as const) {
        await expect(shortLived.clientFor(pds).call(com.atproto.space.listRecords, {
          space: inbox,
          repo,
          collection,
        })).rejects.toThrow(/expired/i)
      }
      await waitUntil(shortPayload.exp * 1000 + 6_000)
      for (const [pds, repo, collection] of [
        [authority.pds, authority.did, 'org.slack.admin' as NsidString],
        [member.pds, member.did, REQUEST_COLLECTION],
      ] as const) {
        await expect(shortLived.clientFor(pds).call(com.atproto.space.listRecords, {
          space: inbox,
          repo,
          collection,
        })).rejects.toThrow(/expired/i)
      }
    } finally {
      await network.close()
    }
  })
})
