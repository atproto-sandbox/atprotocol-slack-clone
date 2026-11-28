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
import type * as OrgAtgrpModDefs from './defs.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'org.atgrp.mod.submitReport'

export type QueryParams = {}

export interface InputSchema {
  group: string
  /** An account DID or record URI. */
  subject: string
  /** If set, a specific version of the record. */
  cid?: string
  reasonType: OrgAtgrpModDefs.ReasonType
  reason?: string
  /** The group rule the subject breaks. */
  rule?: string
}

export interface OutputSchema {
  eventId: string
  createdAt: string
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

export class InvalidSubjectError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'GroupNotFound') return new GroupNotFoundError(e)
    if (e.error === 'InvalidSubject') return new InvalidSubjectError(e)
  }

  return e
}
