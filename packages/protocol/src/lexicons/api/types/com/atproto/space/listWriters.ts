/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type HeadersMap, XRPCError } from '@atproto/xrpc'
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../../lexicons.js'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../../util.js'
import type * as ComAtprotoSpaceDefs from './defs.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'com.atproto.space.listWriters'

export type QueryParams = {
  space: string
  limit?: number
  /** Return repos updated after this space revision. Removed repos may be garbage collected after 72 hrs, so a syncer whose last seen space revision is older should list the whole writer set instead. */
  cursor?: string
}
export type InputSchema = undefined

export interface OutputSchema {
  /** The latest update to each repo, ordered by spaceRev, ascending. prevSpaceRev is not set. */
  repos: (
    | $Typed<ComAtprotoSpaceDefs.RepoWrite>
    | $Typed<ComAtprotoSpaceDefs.RepoRemoved>
    | { $type: string }
  )[]
  cursor?: string
}

export interface CallOptions {
  signal?: AbortSignal
  headers?: HeadersMap
}

export interface Response {
  success: boolean
  headers: HeadersMap
  data: OutputSchema
}

export class SpaceNotFoundError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class RepoTakendownError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class RepoDeactivatedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'SpaceNotFound') return new SpaceNotFoundError(e)
    if (e.error === 'RepoTakendown') return new RepoTakendownError(e)
    if (e.error === 'RepoDeactivated') return new RepoDeactivatedError(e)
  }

  return e
}
