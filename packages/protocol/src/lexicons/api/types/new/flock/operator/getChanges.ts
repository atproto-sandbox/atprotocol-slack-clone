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
const id = 'new.flock.operator.getChanges'

export type QueryParams = {}

export interface InputSchema {
  follow: Follow[]
}

export interface OutputSchema {
  /** The operator's newest notice cursor, to follow a space from once it is synced. */
  head: string
  changed: Change[]
  denied: string[]
  reset: string[]
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
  data: OutputSchema
}

export class UnauthorizedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'Unauthorized') return new UnauthorizedError(e)
  }

  return e
}

export interface Follow {
  $type?: 'new.flock.operator.getChanges#follow'
  space: string
  /** The cursor this space was last synced or answered at. */
  after: string
}

const hashFollow = 'follow'

export function isFollow<V>(v: V) {
  return is$typed(v, id, hashFollow)
}

export function validateFollow<V>(v: V) {
  return validate<Follow & V>(v, id, hashFollow)
}

export interface Change {
  $type?: 'new.flock.operator.getChanges#change'
  space: string
  /** This space's newest notice: follow it from here once it is synced. */
  cursor: string
}

const hashChange = 'change'

export function isChange<V>(v: V) {
  return is$typed(v, id, hashChange)
}

export function validateChange<V>(v: V) {
  return validate<Change & V>(v, id, hashChange)
}
