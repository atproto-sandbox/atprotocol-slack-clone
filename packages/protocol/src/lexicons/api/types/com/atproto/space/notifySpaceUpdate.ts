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
import type * as ComAtprotoSpaceDefs from './defs.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'com.atproto.space.notifySpaceUpdate'

export type QueryParams = {}

export interface InputSchema {
  space: string
  /** The token the endpoint was registered with. */
  token: string
  update:
    | $Typed<ComAtprotoSpaceDefs.RepoWrite>
    | $Typed<ComAtprotoSpaceDefs.RepoRemoved>
    | $Typed<SpaceDeleted>
    | $Typed<RegistrationExpired>
    | { $type: string }
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
}

export function toKnownErr(e: any) {
  return e
}

/** The space has been deleted. Confirm with authorizeSpaceSync before dropping its data. */
export interface SpaceDeleted {
  $type?: 'com.atproto.space.notifySpaceUpdate#spaceDeleted'
}

const hashSpaceDeleted = 'spaceDeleted'

export function isSpaceDeleted<V>(v: V) {
  return is$typed(v, id, hashSpaceDeleted)
}

export function validateSpaceDeleted<V>(v: V) {
  return validate<SpaceDeleted & V>(v, id, hashSpaceDeleted)
}

/** The endpoint's registration has expired. Sent in place of the first update after expiry. Call authorizeSpaceSync to keep receiving notifications. */
export interface RegistrationExpired {
  $type?: 'com.atproto.space.notifySpaceUpdate#registrationExpired'
  spaceRev: string
}

const hashRegistrationExpired = 'registrationExpired'

export function isRegistrationExpired<V>(v: V) {
  return is$typed(v, id, hashRegistrationExpired)
}

export function validateRegistrationExpired<V>(v: V) {
  return validate<RegistrationExpired & V>(v, id, hashRegistrationExpired)
}
