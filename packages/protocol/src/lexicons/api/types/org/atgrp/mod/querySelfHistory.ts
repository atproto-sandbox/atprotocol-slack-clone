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
const id = 'org.atgrp.mod.querySelfHistory'

export type QueryParams = {
  group: string
  /** The caller's DID or one of their record URIs. Omit for all. */
  subject?: string
  sort?: 'newest' | 'oldest' | (string & {})
  limit?: number
  cursor?: string
}
export type InputSchema = undefined

export interface OutputSchema {
  cursor?: string
  events: OrgAtgrpModDefs.EventView[]
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

export class InvalidCursorError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'GroupNotFound') return new GroupNotFoundError(e)
    if (e.error === 'InvalidSubject') return new InvalidSubjectError(e)
    if (e.error === 'InvalidCursor') return new InvalidCursorError(e)
  }

  return e
}
