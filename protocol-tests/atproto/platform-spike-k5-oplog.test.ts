import { get as httpGet } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestNetworkNoAppView } from '@atproto/dev-env'
import { Client } from '@atproto/lex'
import { parseCid } from '@atproto/lex-data'
import { RepoCommit, createSpaceSigHeaders } from '@atproto/space'
import type { SpaceRefString } from '@atproto/syntax'
import { com } from '../../src/lexicons/index.js'
import { type Actor, SpaceClient, TEST_COLLECTION } from '../_space.js'

// Platform spike K5: what the oplog does across a reset (importRepo, clearRecords),
// and what listing 10,000 records of one writer costs. Everything asserted here was
// observed, so protocol drift fails the test. Timings are printed, never asserted.

const previousTmpdir = process.env.TMPDIR
const fixtureTmpdir = mkdtempSync(join(tmpdir(), 'platform-spike-k5-'))
process.env.TMPDIR = fixtureTmpdir

afterAll(() => {
  try {
    rmSync(fixtureTmpdir, { recursive: true, force: true })
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
})

type OpEntry = com.atproto.space.listRepoOps.$OutputBody['ops'][number]
type RecordsListing = {
  records: com.atproto.space.listRecords.$OutputBody['records']
  pages: number
}
type MeteredRun<T> = {
  result: T
  ms: number
  requests: number
  decodedBytes: number
  urls: string[]
}

const applyOps = (local: RepoCommit, ops: OpEntry[]): RepoCommit =>
  local.applyOps(
    ops.map((op) => ({
      collection: op.collection,
      rkey: op.rkey,
      cid: op.cid ? parseCid(op.cid) : null,
      prev: op.prev ? parseCid(op.prev) : null,
    })),
  )

/** Page the oplog to its head, as a syncer would, with `since` as its checkpoint. */
const listAllOps = async (
  asSyncer: Client,
  space: SpaceRefString,
  repo: string,
  opts: { since?: string; excludeValues?: boolean } = {},
) => {
  const ops: OpEntry[] = []
  let cursor: string | undefined
  let commit: com.atproto.space.listRepoOps.$OutputBody['commit']
  let pages = 0
  do {
    const page = await asSyncer.call(com.atproto.space.listRepoOps, {
      space,
      repo: repo as never,
      since: opts.since as never,
      excludeValues: opts.excludeValues,
      cursor,
      limit: 1000,
    })
    pages++
    ops.push(...page.ops)
    cursor = page.cursor
    commit = page.commit
  } while (cursor)
  return { ops, commit: commit!, pages }
}

describe('platform spike K5: oplog resets and listing cost', () => {
  it('drops the whole oplog on a reset and tells a syncer holding an older since nothing', async () => {
    const network = await TestNetworkNoAppView.create({})
    try {
      const sc = new SpaceClient(network)
      const alice = await sc.createActor('alice', network.pds)
      const dan = await sc.createActor('dan', network.pds)

      const star = async (actor: Actor, space: SpaceRefString) =>
        (
          await actor.client.xrpc(com.atproto.space.getRepo, {
            params: { space, repo: actor.did },
            headers: actor.headers,
          })
        ).body

      // --- clearRecords ---------------------------------------------------------
      // given a writer synced through three records, holding a checkpoint
      const clearedSpace = await sc.createSpace(alice, { members: [dan], skey: 'cleared' })
      for (const rkey of ['a', 'b', 'c']) await sc.write(dan, clearedSpace, { rkey })
      const clearedCred = await sc.credentialFor(dan, clearedSpace)
      const asSyncer = clearedCred.clientFor(dan.pds)
      const baseline = await listAllOps(asSyncer, clearedSpace, dan.did)
      expect(baseline.ops.map((op) => op.rkey)).toEqual(['a', 'b', 'c'])
      const checkpoint = baseline.commit.rev
      expect(applyOps(new RepoCommit(), baseline.ops).matches(baseline.commit)).toBe(true)

      // when the writer clears its repo
      await sc.clear(dan, clearedSpace)

      // then the earlier ops are gone, and the commit is the empty repo's at a newer rev
      const afterClear = await listAllOps(asSyncer, clearedSpace, dan.did)
      expect(afterClear.ops).toEqual([])
      expect(afterClear.commit.rev > checkpoint).toBe(true)
      expect(new RepoCommit().matches(afterClear.commit)).toBe(true)

      // and a since from before the reset is not an error and not a partial list: it is empty
      const sinceCheckpoint = await listAllOps(asSyncer, clearedSpace, dan.did, { since: checkpoint })
      expect(sinceCheckpoint.ops).toEqual([])
      expect(sinceCheckpoint.pages).toBe(1)
      expect(sinceCheckpoint.commit.rev).toBe(afterClear.commit.rev)
      const sinceFirstOp = await listAllOps(asSyncer, clearedSpace, dan.did, {
        since: baseline.ops[0].rev,
      })
      expect(sinceFirstOp.ops).toEqual([])

      // and the only signal is the commit: its rev moved past the checkpoint with no
      // op carrying it, and the stale syncer's set hash no longer matches
      expect(sinceCheckpoint.commit.rev).not.toBe(checkpoint)
      expect(
        applyOps(new RepoCommit(), baseline.ops).matches(sinceCheckpoint.commit),
      ).toBe(false)

      // when the writer writes again after the reset
      await sc.write(dan, clearedSpace, { rkey: 'd' })

      // then since=checkpoint returns a silently partial list: only the new op
      const partial = await listAllOps(asSyncer, clearedSpace, dan.did, { since: checkpoint })
      expect(partial.ops.map((op) => [op.rkey, op.prev])).toEqual([['d', null]])
      // and a rev check cannot catch it, because the last op's rev is the commit's rev;
      // only the set hash can, and the stale syncer's hash does not match
      expect(partial.ops.at(-1)!.rev).toBe(partial.commit.rev)
      const stalePlusPartial = applyOps(applyOps(new RepoCommit(), baseline.ops), partial.ops)
      expect(stalePlusPartial.matches(partial.commit)).toBe(false)
      // while a syncer starting from scratch on the retained window is consistent here
      const fromScratch = await listAllOps(asSyncer, clearedSpace, dan.did)
      expect(fromScratch.ops.map((op) => op.rkey)).toEqual(['d'])
      expect(applyOps(new RepoCommit(), fromScratch.ops).matches(fromScratch.commit)).toBe(true)

      // --- importRepo -----------------------------------------------------------
      // given another writer synced through three records, holding a checkpoint
      const importedSpace = await sc.createSpace(alice, { members: [dan], skey: 'imported' })
      for (const rkey of ['a', 'b', 'c']) await sc.write(dan, importedSpace, { rkey })
      const importedCred = await sc.credentialFor(dan, importedSpace)
      const asImportSyncer = importedCred.clientFor(dan.pds)
      const importBaseline = await listAllOps(asImportSyncer, importedSpace, dan.did)
      const importCheckpoint = importBaseline.commit.rev
      expect(importBaseline.ops).toHaveLength(3)

      // when the repo is exported and imported back onto the same host
      await dan.client.xrpc(com.atproto.space.importRepo, {
        body: await star(dan, importedSpace),
        headers: dan.headers,
      })

      // then the records survive but no op does: the import writes none of its own
      const records = await asImportSyncer.call(com.atproto.space.listRecords, {
        space: importedSpace,
        repo: dan.did,
        limit: 1000,
        excludeValues: true,
      })
      expect(records.records.map((r) => r.rkey).sort()).toEqual(['a', 'b', 'c'])
      const afterImport = await listAllOps(asImportSyncer, importedSpace, dan.did)
      expect(afterImport.ops).toEqual([])
      // and the commit has the same contents at a newer rev
      expect(afterImport.commit.rev > importCheckpoint).toBe(true)
      expect(afterImport.commit.data).toEqual(importBaseline.commit.data)
      const importSince = await listAllOps(asImportSyncer, importedSpace, dan.did, {
        since: importCheckpoint,
      })
      expect(importSince.ops).toEqual([])
      expect(importSince.commit.rev).toBe(afterImport.commit.rev)

      // when the writer writes after the import
      await sc.write(dan, importedSpace, { rkey: 'd' })

      // then a syncer that kept its checkpoint is still correct
      const importPartial = await listAllOps(asImportSyncer, importedSpace, dan.did, {
        since: importCheckpoint,
      })
      expect(importPartial.ops.map((op) => op.rkey)).toEqual(['d'])
      expect(
        applyOps(applyOps(new RepoCommit(), importBaseline.ops), importPartial.ops).matches(
          importPartial.commit,
        ),
      ).toBe(true)
      // but one starting from the retained window gets one op for a four-record repo,
      // and only the set hash shows it
      const importFromScratch = await listAllOps(asImportSyncer, importedSpace, dan.did)
      expect(importFromScratch.ops.map((op) => op.rkey)).toEqual(['d'])
      expect(
        applyOps(new RepoCommit(), importFromScratch.ops).matches(importFromScratch.commit),
      ).toBe(false)

      // --- clearRecords on an already-empty repo -------------------------------
      // given a repo whose only record was deleted, leaving a create and a delete op
      const emptySpace = await sc.createSpace(alice, { members: [dan], skey: 'emptied' })
      await sc.write(dan, emptySpace, { rkey: 'x' })
      await sc.del(dan, emptySpace, { rkey: 'x' })
      const stateBefore = await sc.repoState(dan, emptySpace)

      // when it is cleared
      await sc.clear(dan, emptySpace)

      // then nothing happens: the rev is unchanged and the oplog is NOT cleared,
      // despite the lexicon saying clearRecords clears it
      const stateAfter = await sc.repoState(dan, emptySpace)
      expect(stateAfter!.rev).toBe(stateBefore!.rev)
      const emptyCred = await sc.credentialFor(dan, emptySpace)
      const emptyOps = await listAllOps(emptyCred.clientFor(dan.pds), emptySpace, dan.did)
      expect(emptyOps.ops.map((op) => [op.rkey, op.cid === null])).toEqual([
        ['x', false],
        ['x', true],
      ])
    } finally {
      await network.close()
    }
  }, 120_000)

  it('measures listing 10,000 records of one writer with and without values', async () => {
    const network = await TestNetworkNoAppView.create({})
    try {
      const RECORD_COUNT = 10_000
      const BATCH = 200 // applyWrites accepts at most 200 writes (applyWrites.ts MAX_WRITES)
      const sc = new SpaceClient(network)
      const alice = await sc.createActor('alice', network.pds)
      const dan = await sc.createActor('dan', network.pds)
      const space = await sc.createSpace(alice, { members: [dan] })

      // given 10,000 records of about 300 bytes each, written in batches of 200
      const text = 'lorem ipsum '.repeat(20)
      const startedWriting = performance.now()
      for (let first = 0; first < RECORD_COUNT; first += BATCH) {
        await dan.client.call(
          com.atproto.space.applyWrites,
          {
            space,
            repo: dan.did,
            writes: Array.from({ length: BATCH }, (_, i) => ({
              $type: 'com.atproto.space.applyWrites#create' as const,
              collection: TEST_COLLECTION,
              rkey: `r${String(first + i).padStart(5, '0')}`,
              value: {
                $type: TEST_COLLECTION,
                text: `${first + i} ${text}`,
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            })),
          },
          { headers: dan.headers },
        )
      }
      const writeMs = performance.now() - startedWriting

      const cred = await sc.credentialFor(dan, space)
      const meterRun = async <T>(
        run: (asSyncer: Client) => Promise<T>,
      ): Promise<MeteredRun<T>> => {
        const meter = { requests: 0, decodedBytes: 0, urls: [] as string[] }
        const asSyncer = new Client({
          service: dan.pds.url,
          fetch: async (input: string | URL | Request, init?: RequestInit) => {
            const response = await cred.fetch(input, init)
            meter.requests++
            meter.decodedBytes += (await response.clone().arrayBuffer()).byteLength
            meter.urls.push(input instanceof Request ? input.url : String(input))
            return response
          },
        })
        const started = performance.now()
        const result = await run(asSyncer)
        return { result, ms: performance.now() - started, ...meter }
      }

      const listAllRecords = async (
        asSyncer: Client,
        opts: { excludeValues: boolean; limit: number },
      ) => {
        const records: RecordsListing['records'] = []
        let cursor: string | undefined
        let pages = 0
        do {
          const page = await asSyncer.call(com.atproto.space.listRecords, {
            space,
            repo: dan.did,
            ...opts,
            cursor,
          })
          pages++
          records.push(...page.records)
          cursor = page.cursor
        } while (cursor)
        return { records, pages }
      }

      // The same pages over raw HTTP with gzip accepted, for the bytes a network would carry.
      const gzipWireBytes = async (urls: string[]) => {
        let total = 0
        for (const url of urls) {
          const headers = await createSpaceSigHeaders(cred.key, {
            authorization: `Atproto-Space-Credential ${cred.credential}`,
            audience: dan.did,
          })
          total += await new Promise<number>((resolve, reject) => {
            httpGet(url, { headers: { ...headers, 'accept-encoding': 'gzip' } }, (res) => {
              let bytes = 0
              res.on('data', (chunk: Buffer) => (bytes += chunk.length))
              res.on('end', () => resolve(bytes))
              res.on('error', reject)
            }).on('error', reject)
          })
        }
        return total
      }

      // when the writer's records are listed at the maximum page size, three times each
      const cells: Record<string, unknown> = {}
      const measured: Record<string, MeteredRun<RecordsListing>> = {}
      for (const [name, excludeValues, limit] of [
        ['excludeValues,limit=1000', true, 1000],
        ['values,limit=1000', false, 1000],
        ['excludeValues,limit=50', true, 50],
        ['values,limit=50', false, 50],
      ] as const) {
        const runs: MeteredRun<RecordsListing>[] = []
        for (let i = 0; i < 3; i++) {
          runs.push(await meterRun((asSyncer) => listAllRecords(asSyncer, { excludeValues, limit })))
        }
        measured[name] = runs[0]
        cells[name] = {
          pages: runs[0].result.pages,
          records: runs[0].result.records.length,
          requests: runs[0].requests,
          decodedBytes: runs[0].decodedBytes,
          gzipWireBytes: await gzipWireBytes(runs[0].urls),
          wallMs: runs.map((run) => Math.round(run.ms)),
        }
      }

      // then every cell returns exactly the 10,000 distinct records
      for (const run of Object.values(measured)) {
        expect(run.result.records).toHaveLength(RECORD_COUNT)
        expect(new Set(run.result.records.map((r) => r.rkey)).size).toBe(RECORD_COUNT)
      }
      // and values are inlined only when asked for
      expect(measured['excludeValues,limit=1000'].result.records.every((r) => r.value === undefined)).toBe(true)
      expect(measured['values,limit=1000'].result.records.every((r) => r.value !== undefined)).toBe(true)
      // and the page counts follow the limit
      expect(measured['excludeValues,limit=1000'].result.pages).toBe(measured['values,limit=1000'].result.pages)
      expect(measured['excludeValues,limit=50'].result.pages).toBe(measured['values,limit=50'].result.pages)
      // and values are what the bytes are
      expect(measured['values,limit=1000'].decodedBytes).toBeGreaterThan(
        2 * measured['excludeValues,limit=1000'].decodedBytes,
      )

      // when the whole oplog is paged too, for comparison
      const oplog: Record<string, unknown> = {}
      for (const excludeValues of [true, false]) {
        const run = await meterRun((asSyncer) =>
          listAllOps(asSyncer, space, dan.did, { excludeValues }),
        )
        // then it is 10,000 ops in 1,000-op pages, ending in the commit
        expect(run.result.ops).toHaveLength(RECORD_COUNT)
        expect(run.result.commit).toBeDefined()
        oplog[`excludeValues=${excludeValues}`] = {
          pages: run.result.pages,
          requests: run.requests,
          decodedBytes: run.decodedBytes,
          wallMs: Math.round(run.ms),
        }
      }

      // and the full STAR archive, for comparison
      const star = await meterRun(async () => {
        const response = await cred.fetch(
          `${dan.pds.url}/xrpc/com.atproto.space.getRepo?space=${encodeURIComponent(space)}&repo=${dan.did}`,
        )
        return (await response.arrayBuffer()).byteLength
      })

      console.log(
        `K5_RESULT ${JSON.stringify({
          write: { records: RECORD_COUNT, batches: RECORD_COUNT / BATCH, ms: Math.round(writeMs) },
          listRecords: cells,
          listRepoOps: oplog,
          getRepo: { bytes: star.result, wallMs: Math.round(star.ms) },
        })}`,
      )
    } finally {
      await network.close()
    }
  }, 600_000)
})
