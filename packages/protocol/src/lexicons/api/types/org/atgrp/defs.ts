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
const id = 'org.atgrp.defs'

/** A pending join request. */
export interface JoinRequest {
  $type?: 'org.atgrp.defs#joinRequest'
  member: string
  createdAt: string
  message?: string
}

const hashJoinRequest = 'joinRequest'

export function isJoinRequest<V>(v: V) {
  return is$typed(v, id, hashJoinRequest)
}

export function validateJoinRequest<V>(v: V) {
  return validate<JoinRequest & V>(v, id, hashJoinRequest)
}
