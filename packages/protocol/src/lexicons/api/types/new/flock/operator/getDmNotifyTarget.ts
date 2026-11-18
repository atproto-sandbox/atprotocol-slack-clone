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
const id = 'new.flock.operator.getDmNotifyTarget'

export type QueryParams = {}

export interface InputSchema {
  space: string
  credential: string
  proof: CredentialProof
}

export interface OutputSchema {
  endpoint: string
  token: string
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

export class InvalidRequestError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'Unauthorized') return new UnauthorizedError(e)
    if (e.error === 'InvalidRequest') return new InvalidRequestError(e)
  }

  return e
}

export interface CredentialProof {
  $type?: 'new.flock.operator.getDmNotifyTarget#credentialProof'
  authorization: string
  signatureInput: string
  signature: string
}

const hashCredentialProof = 'credentialProof'

export function isCredentialProof<V>(v: V) {
  return is$typed(v, id, hashCredentialProof)
}

export function validateCredentialProof<V>(v: V) {
  return validate<CredentialProof & V>(v, id, hashCredentialProof)
}
