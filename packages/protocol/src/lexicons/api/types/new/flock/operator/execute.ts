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
const id = 'new.flock.operator.execute'

export type QueryParams = {}

export interface InputSchema {
  workspace: string
  operationId: string
  request: OperationRequest
}

export interface OutputSchema {
  operation: Operation
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

export class ConflictError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class PausedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'Unauthorized') return new UnauthorizedError(e)
    if (e.error === 'Conflict') return new ConflictError(e)
    if (e.error === 'Paused') return new PausedError(e)
  }

  return e
}

/** The server validates the required fields for each kind and rejects extra or missing fields. */
export interface OperationRequest {
  $type?: 'new.flock.operator.execute#operationRequest'
  kind:
    | 'inviteMember'
    | 'removeMember'
    | 'setAdmin'
    | 'createChannel'
    | 'transitionChannel'
    | 'archiveChannel'
    | 'decideJoinRequest'
    | 'leaveWorkspace'
    | 'leaveChannel'
    | 'reconcileWorkspace'
    | (string & {})
  subject?: string
  active?: boolean
  skey?: string
  name?: string
  visibility?: 'public' | 'private' | (string & {})
  members?: string[]
  request?: string
  requestId?: string
  decision?: 'approve' | 'deny' | (string & {})
}

const hashOperationRequest = 'operationRequest'

export function isOperationRequest<V>(v: V) {
  return is$typed(v, id, hashOperationRequest)
}

export function validateOperationRequest<V>(v: V) {
  return validate<OperationRequest & V>(v, id, hashOperationRequest)
}

export interface Operation {
  $type?: 'new.flock.operator.execute#operation'
  operationId: string
  /** Lowercase hexadecimal SHA-256 of canonical request JSON. */
  requestHash: string
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
  updatedAt: string
}

const hashOperation = 'operation'

export function isOperation<V>(v: V) {
  return is$typed(v, id, hashOperation)
}

export function validateOperation<V>(v: V) {
  return validate<Operation & V>(v, id, hashOperation)
}
