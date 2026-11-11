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
const id = 'new.flock.operator.listStalledOperations'

export type QueryParams = {
  workspace: string
}
export type InputSchema = undefined

export interface OutputSchema {
  operations: StalledOperation[]
  registrations: FailedRegistration[]
  truncated: boolean
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

export interface StalledOperation {
  $type?: 'new.flock.operator.listStalledOperations#stalledOperation'
  actor: string
  operationId: string
  state: string
  error?: string
  updatedAt: string
}

const hashStalledOperation = 'stalledOperation'

export function isStalledOperation<V>(v: V) {
  return is$typed(v, id, hashStalledOperation)
}

export function validateStalledOperation<V>(v: V) {
  return validate<StalledOperation & V>(v, id, hashStalledOperation)
}

/** A space that gets no change ticks: its registration failed since it last succeeded, or ran out. */
export interface FailedRegistration {
  $type?: 'new.flock.operator.listStalledOperations#failedRegistration'
  space: string
  /** Attempts that failed since the last success; 0 for one that only ran out. */
  failures: number
  error?: string
  nextAttemptAt?: string
  /** When its registration ran out, if it has. */
  expiredAt?: string
}

const hashFailedRegistration = 'failedRegistration'

export function isFailedRegistration<V>(v: V) {
  return is$typed(v, id, hashFailedRegistration)
}

export function validateFailedRegistration<V>(v: V) {
  return validate<FailedRegistration & V>(v, id, hashFailedRegistration)
}
