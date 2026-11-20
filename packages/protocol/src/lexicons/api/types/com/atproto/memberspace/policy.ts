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

/** Space policy that grants access based on a member list. */
export interface Main {
  $type?: 'com.atproto.memberspace.policy'
  /** If true, anyone may read the space. Otherwise, only members with read access. */
  publicRead: boolean
  /** If true, any account's writes are tracked in the writer set, except members without write access. Otherwise, only members with write access. */
  publicWrite: boolean
  /** If set, only these apps (by OAuth client ID) may read the space. */
  allowedApps?: string[]
  /** Publish the policy as a com.atproto.space.policy record in the space. */
  publishPolicy: boolean
  /** Publish the member list as com.atproto.memberspace.member records in the space. */
  publishMembers: boolean
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain)
}
