/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../lexicons.js'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../util.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'group.opensocial.policy'

/** Space policy for group spaces: each role's access and scopes in the space, whether it is public, and whether it is listed in the space index. The host always publishes it in the space as a com.atproto.space.policy record. */
export interface Main {
  $type?: 'group.opensocial.policy'
  /** If true, anyone may read the space. */
  publicRead: boolean
  /** If true, the host leaves the space out of the group's space index. */
  unlisted: boolean
  /** At most one entry per role. */
  grants: Grant[]
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain)
}

/** A role's grants in one space. read and write apply to members acting as themselves; scopes apply to acting as the group. */
export interface Grant {
  $type?: 'group.opensocial.policy#grant'
  /** A role record's key. */
  role: string
  /** If true, members with this role may read the space. */
  read: boolean
  /** If true, members with this role are in the space's writer set, so their own records sync to readers. */
  write: boolean
  /** OAuth scopes for acting as the group in this space, one per item. */
  scopes?: string[]
}

const hashGrant = 'grant'

export function isGrant<V>(v: V) {
  return is$typed(v, id, hashGrant)
}

export function validateGrant<V>(v: V) {
  return validate<Grant & V>(v, id, hashGrant)
}
