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

/** Space policy that defers each user access decision to an external managing app, which the authority asks via checkUserAccess. */
export interface Main {
  $type?: 'com.atproto.managedspace.policy'
  /** Service identifier of the managing app: a DID with an optional service fragment (e.g. 'did:web:example.com#forum'). */
  managingApp: string
  /** Publish the policy to readers as a com.atproto.space.policy record in the authority's repo in the space. */
  publishPolicy: boolean
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain)
}
