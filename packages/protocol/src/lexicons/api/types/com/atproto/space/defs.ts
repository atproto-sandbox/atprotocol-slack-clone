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

/** Commit to the current state of a space repo. Not signed; authenticated by the repo host with a MAC instead. */
export interface Commit {
  $type?: 'com.atproto.space.defs#commit'
  /** Commit format version, currently 1. */
  ver: number
  repo: string
  space: string
  rev: string
  /** SHA-256 digest of the repo's LtHash state. */
  data: Uint8Array
}

const hashCommit = 'commit'

export function isCommit<V>(v: V) {
  return is$typed(v, id, hashCommit)
}

export function validateCommit<V>(v: V) {
  return validate<Commit & V>(v, id, hashCommit)
}

/** A repo in the space advanced to a new revision. */
export interface RepoWrite {
  $type?: 'com.atproto.space.defs#repoWrite'
  repo: string
  repoRev: string
  data: Uint8Array
  /** The space revision at which this update was sequenced. */
  spaceRev: string
  /** The space revision before this update, if any. Set in notifySpaceUpdate, where a gap indicates missed notifications, which can be recovered with listWriters. */
  prevSpaceRev?: string
}

const hashRepoWrite = 'repoWrite'

export function isRepoWrite<V>(v: V) {
  return is$typed(v, id, hashRepoWrite)
}

export function validateRepoWrite<V>(v: V) {
  return validate<RepoWrite & V>(v, id, hashRepoWrite)
}

/** A repo was removed from the writer set. */
export interface RepoRemoved {
  $type?: 'com.atproto.space.defs#repoRemoved'
  repo: string
  /** The space revision at which this update was sequenced. */
  spaceRev: string
  /** The space revision before this update, if any. Set in notifySpaceUpdate, where a gap indicates missed notifications, which can be recovered with listWriters. */
  prevSpaceRev?: string
}

const hashRepoRemoved = 'repoRemoved'

export function isRepoRemoved<V>(v: V) {
  return is$typed(v, id, hashRepoRemoved)
}

export function validateRepoRemoved<V>(v: V) {
  return validate<RepoRemoved & V>(v, id, hashRepoRemoved)
}
