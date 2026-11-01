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
const id = 'com.atproto.space.defs'

/** A commit over the current state of a permissioned repo. Carries no signature: the repo host authenticates it to a syncer with a MAC in the Atproto-Space-Mac response header. */
export interface Commit {
  $type?: 'com.atproto.space.defs#commit'
  /** Commit format version, currently 1. */
  ver: number
  /** The author DID of the repo. */
  repo: string
  /** Reference to the space. */
  space: string
  /** Commit revision (TID). */
  rev: string
  /** sha256 digest of the LtHash state (32 bytes). */
  data: Uint8Array
}

const hashCommit = 'commit'

export function isCommit<V>(v: V) {
  return is$typed(v, id, hashCommit)
}

export function validateCommit<V>(v: V) {
  return validate<Commit & V>(v, id, hashCommit)
}
