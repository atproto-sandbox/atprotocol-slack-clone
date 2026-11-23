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
    | 'decideGroupJoinRequest'
    | 'leaveChannel'
    | 'installApp'
    | 'updateAppAccess'
    | 'uninstallApp'
    | 'enableExtension'
    | 'disableExtension'
    | (string & {})
  subject?: string
  member?: string
  roles?: string[]
  active?: boolean
  skey?: string
  extId?: string
  name?: string
  visibility?: 'public' | 'private' | (string & {})
  members?: string[]
  channels?: ChannelGrant[]
  request?: string
  requestId?: string
  decision?: 'approve' | 'deny' | (string & {})
  expiresAt?: string
}

const hashOperationRequest = 'operationRequest'

export function isOperationRequest<V>(v: V) {
  return is$typed(v, id, hashOperationRequest)
}

export function validateOperationRequest<V>(v: V) {
  return validate<OperationRequest & V>(v, id, hashOperationRequest)
}

/** A channel an app is granted by installApp or updateAppAccess: read, and write when `write` is true. */
export interface ChannelGrant {
  $type?: 'new.flock.operator.execute#channelGrant'
  skey: string
  write: boolean
}

const hashChannelGrant = 'channelGrant'

export function isChannelGrant<V>(v: V) {
  return is$typed(v, id, hashChannelGrant)
}

export function validateChannelGrant<V>(v: V) {
  return validate<ChannelGrant & V>(v, id, hashChannelGrant)
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
    | 'aborted_actor_revoked'
    | (string & {})
  completedSteps: string[]
  takenOverBy?: string
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
