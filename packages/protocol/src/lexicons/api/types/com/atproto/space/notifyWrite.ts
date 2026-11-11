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

const is$typed = _is$typed,
  validate = _validate
const id = 'com.atproto.space.notifyWrite'

export type QueryParams = {}

export interface InputSchema {
  /** Reference to the space. */
  space: string
  /** The DID of the account whose repo advanced. */
  repo: string
  /** The repo revision after the write. */
  repoRev: string
  /** The repo's current commit data (sha256 of the LtHash state) after the write. Lets the space host maintain each repo's commit data for listRepos. */
  data: Uint8Array
  /** The space revision assigned by the space host. Present only on notifications forwarded to syncers. */
  spaceRev?: string
  /** The previous space revision. Omitted on the first update in a space. A gap indicates missed notifications; recover using listRepos with cursor. */
  prevSpaceRev?: string
}

export interface CallOptions {
  signal?: AbortSignal
  headers?: HeadersMap
  qp?: QueryParams
  encoding?: 'application/json'
}

export interface Response {
  success: boolean
  headers: HeadersMap
}

export class SpaceNotFoundError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class FutureRevError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'SpaceNotFound') return new SpaceNotFoundError(e)
    if (e.error === 'FutureRev') return new FutureRevError(e)
  }

  return e
}
