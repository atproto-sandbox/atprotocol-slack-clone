/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type HeadersMap, XRPCError } from '@atproto/xrpc'
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../lexicons.js'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../util.js'
import type * as OrgAtgrpDefs from './defs.js'
import type * as ComAtprotoRepoStrongRef from '../../com/atproto/repo/strongRef.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'org.atgrp.requestJoin'

export type QueryParams = {}

export interface InputSchema {
  group: string
  /** An invite in the caller's inbox space. */
  invite?: string
  /** Shown to the group with the request. */
  message?: string
}

export interface OutputSchema {
  status: 'pending' | 'admitted' | (string & {})
  request?: OrgAtgrpDefs.JoinRequest
  membership?: ComAtprotoRepoStrongRef.Main
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

export class GroupNotFoundError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class InvalidInviteError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class JoinClosedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'GroupNotFound') return new GroupNotFoundError(e)
    if (e.error === 'InvalidInvite') return new InvalidInviteError(e)
    if (e.error === 'JoinClosed') return new JoinClosedError(e)
  }

  return e
}
