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
const id = 'new.flock.operator.startAuthorityFlow'

export type QueryParams = {}

export interface InputSchema {
  purpose: 'createWorkspace' | 'reauthorize' | (string & {})
  /** The group display name, for purpose createWorkspace. */
  name?: string
  /** Existing group DID to reauthorize or complete workspace provisioning on. */
  authority?: string
  joinPolicy?: 'open' | 'approval' | 'invite' | (string & {})
  publicMeta?: boolean
  creationKey?: string
}

export interface OutputSchema {
  url: string
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
