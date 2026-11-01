import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestNetworkNoAppView } from '@atproto/dev-env'
import { calculateJwkThumbprint, decodeJwt } from 'jose'
import { JoseKey } from '@atproto/oauth-provider/provider'
import { Client } from '../../../oauth/oauth-provider/src/client/client.js'
import { generateCode } from '../../../oauth/oauth-provider/src/request/code.js'
import type { NsidString } from '@atproto/syntax'
import { SpaceClient } from '../_space.js'

const previousTmpdir = process.env.TMPDIR
const fixtureTmpdir = mkdtempSync(join(tmpdir(), 'slack-authority-conformance-'))
process.env.TMPDIR = fixtureTmpdir

afterAll(() => {
  try {
    rmSync(fixtureTmpdir, { recursive: true, force: true })
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
})

describe('atproto Slack authority OAuth protocol conformance', () => {
  it('uses a signed authority session with exact management and record scopes', async () => {
    const network = await TestNetworkNoAppView.create({ extraPdses: 1, lexiconAuthority: true })
    try {
      const lexiconAgent = network.pds.getAgent()
      const lexiconSession = await lexiconAgent.com.atproto.server.createSession({
        identifier: 'lex-authority.test',
        password: 'hunter2',
      })
      await lexiconAgent.com.atproto.repo.createRecord({
        repo: network.lexiconAuthority!.did,
        collection: 'com.atproto.lexicon.schema',
        rkey: 'org.slack.workspace',
        record: {
          lexicon: 1,
          id: 'org.slack.workspace',
          defs: {
            main: {
              type: 'space',
              key: 'any',
              name: 'Slack workspace',
              collections: ['org.slack.admin'],
            },
          },
        }},
        { headers: { authorization: `Bearer ${lexiconSession.data.accessJwt}` } },
      )
      const spaces = new SpaceClient(network)
      const authority = await spaces.createActor('alice', network.pds)
      const member = await spaces.createActor('bob', network.extraPdses[0], 'test2')
      const space = await spaces.createSpace(authority, {
        spaceType: 'org.slack.workspace' as NsidString,
        skey: 'workspace',
      })

      const oauth = network.pds.ctx.oauthProvider!
      const key = await JoseKey.generate(['ES256'], 'authority-dpop')
      const clientId = 'https://slack.example/client-metadata.json'
      const metadata = {
        client_id: clientId,
        client_name: 'Slack authority conformance client',
        redirect_uris: ['https://slack.example/callback'],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        scope: 'atproto',
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
      }
      const client = new Client(
        clientId as never,
        metadata as never,
        undefined,
        { isFirstParty: false, isTrusted: false },
      )
      const account = (await oauth.accountManager.getAccount(authority.did)).account
      const scope = [
        'atproto',
        'space:org.slack.workspace?skey=workspace&action=read_self&manage=update',
        'space:org.slack.workspace?skey=workspace&collection=org.slack.admin&action=create&action=update&action=delete',
        ...['execute', 'getOperation', 'listInboxWriters'].map((method) =>
          `rpc:org.slack.operator.${method}?aud=${network.pds.ctx.cfg.service.did}%23atproto_slack_admin`,
        ),
      ].join(' ')
      const token = await oauth.tokenManager.createToken(
        client,
        { method: 'none' },
        { ipAddress: '127.0.0.1', port: 443 },
        account,
        null,
        {
          client_id: clientId,
          redirect_uri: 'https://slack.example/callback',
          response_type: 'code',
          scope,
          dpop_jkt: await calculateJwkThumbprint(key.bareJwk!, 'sha256'),
        },
        await generateCode(),
      )

      let nonce: string | undefined
      const callAsOAuth = async (
        accessToken: string,
        nsid: string,
        body?: unknown,
        params?: Record<string, string>,
      ) => {
        const method = params ? 'GET' : 'POST'
        const url = new URL(`/xrpc/${nsid}`, network.pds.url)
        for (const [name, value] of Object.entries(params ?? {})) {
          url.searchParams.set(name, value)
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const proof = await key.createJwt(
            { alg: 'ES256', typ: 'dpop+jwt', jwk: key.bareJwk },
            {
              jti: randomUUID(),
              htm: method,
              htu: `${url.origin}${url.pathname}`,
              ath: createHash('sha256').update(accessToken).digest('base64url'),
              iat: Math.floor(Date.now() / 1000),
              ...(nonce ? { nonce } : {}),
            },
          )
          const response = await fetch(url, {
            method,
            headers: {
              authorization: `DPoP ${accessToken}`,
              dpop: proof,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          })
          nonce = response.headers.get('DPoP-Nonce') ?? nonce
          if (response.status === 401 && nonce && attempt === 0) continue
          if (!response.ok) {
            throw new Error(`${nsid} failed (${response.status}): ${await response.text()}`)
          }
          const text = await response.text()
          return text ? JSON.parse(text) as unknown : undefined
        }
        throw new Error(`${nsid} exhausted DPoP nonce retry`)
      }

      const operatorAudience = `${network.pds.ctx.cfg.service.did}#atproto_slack_admin`
      const serviceAuth = await callAsOAuth(
        token.access_token,
        'com.atproto.server.getServiceAuth',
        undefined,
        { aud: operatorAudience, lxm: 'org.slack.operator.execute' },
      ) as { token: string }
      expect(decodeJwt(serviceAuth.token)).toMatchObject({
        iss: authority.did,
        aud: operatorAudience,
        lxm: 'org.slack.operator.execute',
      })

      await callAsOAuth(
        token.access_token,
        'com.atproto.memberspace.putMember',
        { space, did: member.did, read: true, write: true },
      )

      const writeNsid = 'com.atproto.space.createRecord'
      await callAsOAuth(
        token.access_token,
        writeNsid,
        {
          space,
          repo: authority.did,
          collection: 'org.slack.admin' as NsidString,
          rkey: 'd-authority-admin',
          record: {
            $type: 'org.slack.admin',
            subject: authority.did,
            active: true,
            updatedAt: new Date().toISOString(),
          },
        },
      )

      // A correctly signed token for the authority but without manage=update
      // cannot mutate the PDS member list.
      const readOnlyToken = await oauth.tokenManager.createToken(
        client,
        { method: 'none' },
        { ipAddress: '127.0.0.1', port: 443 },
        account,
        null,
        {
          client_id: clientId,
          redirect_uri: 'https://slack.example/callback',
          response_type: 'code',
          scope: 'atproto space:org.slack.workspace?skey=workspace&action=read',
          dpop_jkt: await calculateJwkThumbprint(key.bareJwk!, 'sha256'),
        },
        await generateCode(),
      )
      await expect(
        callAsOAuth(readOnlyToken.access_token, 'com.atproto.memberspace.putMember', {
          space,
          did: member.did,
          read: false,
          write: true,
        }),
      ).rejects.toThrow(/space:/)
    } finally {
      await network.close()
    }
  })
})
