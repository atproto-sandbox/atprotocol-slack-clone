/**
 * GENERATED CODE - DO NOT MODIFY
 */
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
const id = 'com.atproto.memberspace.policy'

/** Space policy that governs access via a member list maintained by the space host, managed with putMember and removeMember. */
export interface Main {
  $type?: 'com.atproto.memberspace.policy'
  /** If true, the authority issues a space credential to anyone, with or without a delegation token. Otherwise, only to members whose entry has read set. */
  publicRead: boolean
  /** If true, the authority tracks and forwards notifications for any user's writes. Otherwise, only for members whose entry has write set. */
  publicWrite: boolean
  /** If set, the authority mints a credential only for these apps, evaluated against the attested client_id. When omitted, any app may read the space and no client attestation is required. Does not apply to writes. */
  allowedApps?: string[]
  /** Publish the policy to readers as a com.atproto.space.policy record in the authority's repo in the space. */
  publishPolicy: boolean
  /** Publish the member list to readers as com.atproto.memberspace.member records in the authority's repo in the space. */
  publishMembers: boolean
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain)
}
