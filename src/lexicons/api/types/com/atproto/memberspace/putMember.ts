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
const id = 'com.atproto.memberspace.putMember'

export type QueryParams = {}

export interface InputSchema {
  /** Reference to the space. */
  space: string
  /** The DID of the member. */
  did: string
  /** Whether the member may read when the policy's publicRead is not set. */
  read: boolean
  /** Whether the member's writes are tracked when the policy's publicWrite is not set. */
  write: boolean
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

export class NotSpaceOwnerError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class PolicyMismatchError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'SpaceNotFound') return new SpaceNotFoundError(e)
    if (e.error === 'NotSpaceOwner') return new NotSpaceOwnerError(e)
    if (e.error === 'PolicyMismatch') return new PolicyMismatchError(e)
  }

  return e
}
