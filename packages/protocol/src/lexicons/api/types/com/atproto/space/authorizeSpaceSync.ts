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
const id = 'com.atproto.space.authorizeSpaceSync'

export type QueryParams = {}

export interface InputSchema {
  space: string
  /** P-256 did:key that the credential is bound to. */
  credentialKey: string
  /** Obtained from getDelegationToken. */
  delegationToken?: string
  clientAttestation?: string
  notify?: Notify
}

export interface OutputSchema {
  credential: string
  /** The space's current revision. Omitted before the space's first update. */
  spaceRev?: string
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

export class SpaceNotFoundError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class SpaceDeletedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class AccountNotAuthorizedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class AppNotAuthorizedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class NotAuthorizedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class InvalidDelegationTokenError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class InvalidClientAttestationError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class RegistrationNotConfirmedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class RepoTakendownError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export class RepoDeactivatedError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'SpaceNotFound') return new SpaceNotFoundError(e)
    if (e.error === 'SpaceDeleted') return new SpaceDeletedError(e)
    if (e.error === 'AccountNotAuthorized')
      return new AccountNotAuthorizedError(e)
    if (e.error === 'AppNotAuthorized') return new AppNotAuthorizedError(e)
    if (e.error === 'NotAuthorized') return new NotAuthorizedError(e)
    if (e.error === 'InvalidDelegationToken')
      return new InvalidDelegationTokenError(e)
    if (e.error === 'InvalidClientAttestation')
      return new InvalidClientAttestationError(e)
    if (e.error === 'RegistrationNotConfirmed')
      return new RegistrationNotConfirmedError(e)
    if (e.error === 'RepoTakendown') return new RepoTakendownError(e)
    if (e.error === 'RepoDeactivated') return new RepoDeactivatedError(e)
  }

  return e
}

export interface Notify {
  $type?: 'com.atproto.space.authorizeSpaceSync#notify'
  /** Base HTTPS URL that notification methods are called against. */
  endpoint: string
  /** Opaque secret, included in the body of each request to the endpoint. The endpoint and token together identify the registration, so the token should stay the same across authorizations. */
  token: string
}

const hashNotify = 'notify'

export function isNotify<V>(v: V) {
  return is$typed(v, id, hashNotify)
}

export function validateNotify<V>(v: V) {
  return validate<Notify & V>(v, id, hashNotify)
}
