import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestNetworkNoAppView } from '@atproto/dev-env'
import { JoseKey } from '@atproto/oauth-provider/provider'
import { calculateJwkThumbprint } from 'jose'
import { generateCode } from '../../../oauth/oauth-provider/src/request/code.js'
import { SpaceClient } from '../_space.js'

// Platform spike K2: can the pinned test network serve a confidential
// (`private_key_jwt`) OAuth client, so that its two-year session lifetime can be
// asserted? Everything asserted here was observed, so protocol drift fails the test.

const previousTmpdir = process.env.TMPDIR
const fixtureTmpdir = mkdtempSync(join(tmpdir(), 'platform-spike-k2-'))
process.env.TMPDIR = fixtureTmpdir

afterAll(() => {
  try {
    rmSync(fixtureTmpdir, { recursive: true, force: true })
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
})

const MINUTE = 60e3
const DAY = 24 * 60 * MINUTE
const YEAR = 365.25 * DAY
const MONTH = YEAR / 12

const PUBLIC_CLIENT_ID = 'https://public-client.dev/client-metadata.json'
const CONFIDENTIAL_CLIENT_ID = 'https://confidential-client.dev/client-metadata.json'
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

const baseMetadata = (clientId: string) => ({
  client_id: clientId,
  client_name: 'Platform spike K2 client',
  redirect_uris: [`${new URL(clientId).origin}/callback`],
  response_types: ['code'],
  grant_types: ['authorization_code', 'refresh_token'],
  scope: 'atproto',
  application_type: 'web',
  dpop_bound_access_tokens: true,
})

describe('platform spike K2: confidential client against the pinned test network', () => {
  it('discovers a confidential client, extends its lifetimes, and enforces them on refresh', async () => {
    const network = await TestNetworkNoAppView.create({})

    // The PDS fetches client metadata through `globalThis.fetch` (pds/src/context.ts),
    // so serving the metadata documents from here is how a discoverable client
    // exists on a network with no real host behind its https client_id.
    const realFetch = globalThis.fetch
    const metadataDocuments = new Map<string, unknown>()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      const document = metadataDocuments.get(url)
      if (!document) return realFetch(input, init)
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      // given a public client and a confidential private_key_jwt client with inline jwks
      const spaces = new SpaceClient(network)
      const alice = await spaces.createActor('alice', network.pds)
      const oauth = network.pds.ctx.oauthProvider!
      const issuer = network.pds.ctx.cfg.oauth.issuer
      const account = (await oauth.accountManager.getAccount(alice.did)).account

      const clientKey = await JoseKey.generate(['ES256'], 'client-assertion-key')
      const strangerKey = await JoseKey.generate(['ES256'], 'client-assertion-key')
      metadataDocuments.set(PUBLIC_CLIENT_ID, {
        ...baseMetadata(PUBLIC_CLIENT_ID),
        token_endpoint_auth_method: 'none',
      })
      metadataDocuments.set(CONFIDENTIAL_CLIENT_ID, {
        ...baseMetadata(CONFIDENTIAL_CLIENT_ID),
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'ES256',
        jwks: { keys: [clientKey.publicJwk] },
      })

      // when each is resolved through the provider's own client manager
      const publicClient = await oauth.clientManager.getClient(PUBLIC_CLIENT_ID as never)
      const confidentialClient = await oauth.clientManager.getClient(
        CONFIDENTIAL_CLIENT_ID as never,
      )

      // then discovery works, and only the confidential client gets the extended lifetimes
      expect(publicClient.isConfidential).toBe(false)
      expect(publicClient.sessionLifetime).toBe(14 * DAY)
      expect(publicClient.refreshLifetime).toBe(14 * DAY)
      expect(confidentialClient.isConfidential).toBe(true)
      expect(confidentialClient.sessionLifetime).toBe(2 * YEAR)
      // The refresh lifetime is only three months, not two years: a confidential
      // grant must be refreshed at least that often or it lapses.
      expect(confidentialClient.refreshLifetime).toBe(3 * MONTH)

      // and an https client_id is the only way in: every other shape is refused
      const resolve = (clientId: string) =>
        oauth.clientManager.getClient(clientId as never).then(
          () => 'resolved',
          (err: Error) => `${err.name}: ${err.message}`,
        )
      expect(await resolve('http://public-client.dev/client-metadata.json')).toBe(
        'InvalidClientMetadataError: Invalid client ID "http://public-client.dev/client-metadata.json"',
      )
      expect(await resolve('https://127.0.0.1/client-metadata.json')).toBe(
        'InvalidClientMetadataError: Invalid client ID "https://127.0.0.1/client-metadata.json"',
      )
      expect(await resolve('https://localhost/client-metadata.json')).toBe(
        'InvalidClientMetadataError: Invalid client ID "https://localhost/client-metadata.json"',
      )
      expect(await resolve('https://workspace.test/client-metadata.json')).toBe(
        "InvalidClientIdError: The client_id's TLD must not be a local hostname",
      )

      // and a loopback client_id resolves but can only ever be public
      const loopbackClient = await oauth.clientManager.getClient('http://localhost' as never)
      expect(loopbackClient.isConfidential).toBe(false)
      expect(loopbackClient.sessionLifetime).toBe(14 * DAY)

      // given a way to mint a session, then refresh it over the real token endpoint
      const dpopKey = await JoseKey.generate(['ES256'], 'session-dpop')
      const assertionFor = (clientId: string, key: JoseKey) => {
        const now = Math.floor(Date.now() / 1000)
        return key.createJwt(
          { alg: 'ES256' },
          { iss: clientId, sub: clientId, aud: issuer, jti: randomUUID(), iat: now, exp: now + 60 },
        )
      }
      const mint = async (clientId: string) => {
        const client = clientId === PUBLIC_CLIENT_ID ? publicClient : confidentialClient
        const clientAuth = client.isConfidential
          ? await client.authenticate(
              {
                client_id: clientId,
                client_assertion_type: JWT_BEARER,
                client_assertion: await assertionFor(clientId, clientKey),
              } as never,
              { authorizationServerIdentifier: issuer },
            )
          : ({ method: 'none' } as const)
        const token = await oauth.tokenManager.createToken(
          client,
          clientAuth,
          { ipAddress: '127.0.0.1', port: 443 },
          account,
          null,
          {
            client_id: clientId,
            redirect_uri: `${new URL(clientId).origin}/callback`,
            response_type: 'code',
            scope: 'atproto',
            dpop_jkt: await calculateJwkThumbprint(dpopKey.bareJwk!, 'sha256'),
          } as never,
          await generateCode(),
        )
        return token.refresh_token!
      }

      let dpopNonce: string | undefined
      const tokenEndpoint = new URL('/oauth/token', issuer)
      const postToken = async (body: Record<string, string>) => {
        for (let attempt = 0; ; attempt++) {
          const proof = await dpopKey.createJwt(
            { alg: 'ES256', typ: 'dpop+jwt', jwk: dpopKey.bareJwk },
            {
              jti: randomUUID(),
              htm: 'POST',
              htu: `${tokenEndpoint.origin}${tokenEndpoint.pathname}`,
              iat: Math.floor(Date.now() / 1000),
              ...(dpopNonce ? { nonce: dpopNonce } : {}),
            },
          )
          const response = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', dpop: proof },
            body: JSON.stringify(body),
          })
          dpopNonce = response.headers.get('DPoP-Nonce') ?? dpopNonce
          const json = (await response.json()) as Record<string, unknown>
          if (json.error === 'use_dpop_nonce' && attempt === 0) continue
          return { status: response.status, json }
        }
      }

      // The stored creation and last-refresh times are what the provider measures a
      // session against (oauth-provider.ts validateRefreshGrant), so backdating them
      // is equivalent to waiting.
      const backdate = async (
        refreshToken: string,
        age: { created: number; updated: number },
      ) => {
        const info = await oauth.tokenManager.findToken(refreshToken)
        await network.pds.ctx.accountManager.db.db
          .updateTable('token')
          .set({
            createdAt: new Date(Date.now() - age.created).toISOString(),
            updatedAt: new Date(Date.now() - age.updated).toISOString(),
          } as never)
          .where('tokenId', '=', info!.id as never)
          .execute()
      }

      const refresh = async (
        clientId: string,
        age?: { created: number; updated: number },
        assertionKey: JoseKey | null = clientKey,
      ) => {
        const refreshToken = await mint(clientId)
        if (age) await backdate(refreshToken, age)
        const outcome = await postToken({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          ...(assertionKey && clientId === CONFIDENTIAL_CLIENT_ID
            ? {
                client_assertion_type: JWT_BEARER,
                client_assertion: await assertionFor(clientId, assertionKey),
              }
            : {}),
        })
        return { ...outcome, refreshToken }
      }

      // when a fresh confidential session is refreshed
      const fresh = await refresh(CONFIDENTIAL_CLIENT_ID)
      // then it rotates the refresh token and issues a one hour DPoP access token
      expect(fresh.status).toBe(200)
      expect(fresh.json).toMatchObject({ token_type: 'DPoP', sub: alice.did, scope: 'atproto' })
      expect(fresh.json.refresh_token).not.toBe(fresh.refreshToken)
      expect(fresh.json.expires_in).toBeGreaterThan(3590)
      expect(fresh.json.expires_in).toBeLessThanOrEqual(3600)

      // when a confidential session is 400 days old but was refreshed yesterday
      const old = await refresh(CONFIDENTIAL_CLIENT_ID, { created: 400 * DAY, updated: DAY })
      // then it still refreshes, well past the public session lifetime
      expect(old.status).toBe(200)

      // when a confidential session has ten minutes left of its two years
      const nearEnd = await refresh(CONFIDENTIAL_CLIENT_ID, {
        created: 2 * YEAR - 10 * MINUTE,
        updated: DAY,
      })
      // then the access token is clipped to the remaining session
      expect(nearEnd.status).toBe(200)
      expect(nearEnd.json.expires_in).toBeGreaterThan(540)
      expect(nearEnd.json.expires_in).toBeLessThanOrEqual(600)

      // when a confidential session is past two years
      const pastSession = await refresh(CONFIDENTIAL_CLIENT_ID, {
        created: 2 * YEAR + DAY,
        updated: DAY,
      })
      // then the session is expired
      expect(pastSession.status).toBe(400)
      expect(pastSession.json).toMatchObject({ error: 'invalid_grant', error_description: 'Session expired' })
      // and the failed refresh deleted it, so the refresh token is gone for good
      expect(await oauth.tokenManager.findToken(pastSession.refreshToken)).toBeNull()

      // when a confidential session went 80 days (inside three months) without a refresh
      const idle80 = await refresh(CONFIDENTIAL_CLIENT_ID, { created: 80 * DAY, updated: 80 * DAY })
      // then it refreshes
      expect(idle80.status).toBe(200)

      // when a confidential session went 100 days (past three months) without a refresh
      const idle100 = await refresh(CONFIDENTIAL_CLIENT_ID, {
        created: 100 * DAY,
        updated: 100 * DAY,
      })
      // then the refresh token has expired even though the session has 21 months left
      expect(idle100.status).toBe(400)
      expect(idle100.json).toMatchObject({
        error: 'invalid_grant',
        error_description: 'Refresh token expired',
      })

      // when a public session is 13 days old
      const public13 = await refresh(PUBLIC_CLIENT_ID, { created: 13 * DAY, updated: 13 * DAY })
      // then it refreshes
      expect(public13.status).toBe(200)

      // when a public session is 15 days old but was refreshed yesterday
      const public15 = await refresh(PUBLIC_CLIENT_ID, { created: 15 * DAY, updated: DAY })
      // then it is refused, while the confidential session of the same age (above) was not
      expect(public15.status).toBe(400)
      expect(public15.json).toMatchObject({ error: 'invalid_grant', error_description: 'Session expired' })

      // when a confidential refresh carries no assertion, or one signed by an unknown key
      const noAssertion = await refresh(CONFIDENTIAL_CLIENT_ID, undefined, null)
      const strangerAssertion = await refresh(CONFIDENTIAL_CLIENT_ID, undefined, strangerKey)
      // then a stolen refresh token alone is useless
      expect(noAssertion.status).toBe(400)
      expect(noAssertion.json).toMatchObject({
        error: 'invalid_request',
        error_description: 'client authentication method "private_key_jwt" required a "client_assertion"',
      })
      expect(strangerAssertion.status).toBe(400)
      expect(strangerAssertion.json).toMatchObject({
        error: 'invalid_client',
        error_description: 'Validation of "client_assertion" failed: signature verification failed',
      })
    } finally {
      globalThis.fetch = realFetch
      await network.close()
    }
  }, 120_000)
})
