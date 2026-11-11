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
const id = 'new.flock.operator.createWorkspace'

export type QueryParams = {}

export interface InputSchema {
  name: string
  operationId: string
}

export interface OutputSchema {
  operationId: string
  workspace: string
  /** The workspace's general channel. */
  channel: string
  state:
    | 'queued'
    | 'running'
    | 'pending'
    | 'completed'
    | 'failed'
    | 'paused'
    | (string & {})
  completedSteps: string[]
  error?: string
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

export class AuthorizationRequiredError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class OperationIdConflictError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class PausedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class BusyError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'Unauthorized') return new UnauthorizedError(e)
    if (e.error === 'AuthorizationRequired')
      return new AuthorizationRequiredError(e)
    if (e.error === 'OperationIdConflict')
      return new OperationIdConflictError(e)
    if (e.error === 'Paused') return new PausedError(e)
    if (e.error === 'Busy') return new BusyError(e)
  }

  return e
}
