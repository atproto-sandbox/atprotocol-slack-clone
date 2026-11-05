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
import type * as ComAtprotoPersonalspacePolicy from '../personalspace/policy.js'
import type * as ComAtprotoMemberspacePolicy from '../memberspace/policy.js'
import type * as ComAtprotoManagedspacePolicy from '../managedspace/policy.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'com.atproto.space.getSpace'

export type QueryParams = {
  /** Reference to the space. */
  space: string
}
export type InputSchema = undefined

export interface OutputSchema {
  /** URI of the space. */
  uri: string
  policy:
    | $Typed<ComAtprotoPersonalspacePolicy.Main>
    | $Typed<ComAtprotoMemberspacePolicy.Main>
    | $Typed<ComAtprotoManagedspacePolicy.Main>
    | { $type: string }
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

export class SpaceNotFoundError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'SpaceNotFound') return new SpaceNotFoundError(e)
  }

  return e
}
