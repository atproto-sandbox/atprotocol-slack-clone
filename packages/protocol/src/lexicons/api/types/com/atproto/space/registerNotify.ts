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
const id = 'com.atproto.space.registerNotify'

export type QueryParams = {}

export interface InputSchema {
  /** Reference to the space. */
  space: string
  /** Service identifier of the subscriber: a DID with an optional service fragment naming the entry in its DID document to deliver to (e.g. 'did:web:syncer.example.com#atproto_space_syncer'). notifyWrite calls are addressed to this identifier. */
  service: string
}

export interface OutputSchema {
  /** When the registration expires. May be later than the expiry of the space credential the request was authenticated with; renew before this time to stay subscribed. */
  expiresAt: string
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

export class SpaceNotFoundError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class ServiceNotResolvableError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'SpaceNotFound') return new SpaceNotFoundError(e)
    if (e.error === 'ServiceNotResolvable')
      return new ServiceNotResolvableError(e)
  }

  return e
}
