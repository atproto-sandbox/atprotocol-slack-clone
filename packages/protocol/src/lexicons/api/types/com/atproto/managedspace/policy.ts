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
const id = 'com.atproto.managedspace.policy'

/** Space policy that delegates access decisions to an external app through checkAccess. */
export interface Main {
  $type?: 'com.atproto.managedspace.policy'
  /** The `did#serviceId` reference of the managing app. */
  managingApp: string
  /** Publish the policy as a com.atproto.space.policy record in the space. */
  publishPolicy: boolean
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain)
}
