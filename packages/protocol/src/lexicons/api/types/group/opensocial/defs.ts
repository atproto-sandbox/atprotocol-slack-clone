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
const id = 'group.opensocial.defs'

/** A subject in the moderation queue. */
export interface ModSubjectView {
  $type?: 'group.opensocial.defs#modSubjectView'
  /** An account DID or record URI. */
  subject: string
  /** If set, a specific version of the record. */
  cid?: string
  status: 'open' | 'escalated' | 'resolved'
  createdAt: string
  updatedAt: string
  reportCount: number
}

const hashModSubjectView = 'modSubjectView'

export function isModSubjectView<V>(v: V) {
  return is$typed(v, id, hashModSubjectView)
}

export function validateModSubjectView<V>(v: V) {
  return validate<ModSubjectView & V>(v, id, hashModSubjectView)
}

/** An event in a subject's moderation history. */
export interface ModerationEvent {
  $type?: 'group.opensocial.defs#moderationEvent'
  id: string
  createdAt: string
  /** May be withheld to protect reporters and moderators. */
  createdBy?: string
  event:
    | $Typed<ReportEvent>
    | $Typed<StatusEvent>
    | $Typed<LabelEvent>
    | $Typed<EjectEvent>
    | { $type: string }
}

const hashModerationEvent = 'moderationEvent'

export function isModerationEvent<V>(v: V) {
  return is$typed(v, id, hashModerationEvent)
}

export function validateModerationEvent<V>(v: V) {
  return validate<ModerationEvent & V>(v, id, hashModerationEvent)
}

/** A report was filed. */
export interface ReportEvent {
  $type?: 'group.opensocial.defs#reportEvent'
  reasonType:
    | 'spam'
    | 'violation'
    | 'misleading'
    | 'nsfw'
    | 'rude'
    | 'other'
    | (string & {})
  reason?: string
  rule?: string
}

const hashReportEvent = 'reportEvent'

export function isReportEvent<V>(v: V) {
  return is$typed(v, id, hashReportEvent)
}

export function validateReportEvent<V>(v: V) {
  return validate<ReportEvent & V>(v, id, hashReportEvent)
}

/** A moderator changed the subject's status or added a note. */
export interface StatusEvent {
  $type?: 'group.opensocial.defs#statusEvent'
  status: 'open' | 'escalated' | 'resolved'
  note?: string
}

const hashStatusEvent = 'statusEvent'

export function isStatusEvent<V>(v: V) {
  return is$typed(v, id, hashStatusEvent)
}

export function validateStatusEvent<V>(v: V) {
  return validate<StatusEvent & V>(v, id, hashStatusEvent)
}

/** A label record was written or deleted. */
export interface LabelEvent {
  $type?: 'group.opensocial.defs#labelEvent'
  /** The label record. */
  uri: string
  val: string
  deleted: boolean
}

const hashLabelEvent = 'labelEvent'

export function isLabelEvent<V>(v: V) {
  return is$typed(v, id, hashLabelEvent)
}

export function validateLabelEvent<V>(v: V) {
  return validate<LabelEvent & V>(v, id, hashLabelEvent)
}

/** The subject was ejected from the group. */
export interface EjectEvent {
  $type?: 'group.opensocial.defs#ejectEvent'
}

const hashEjectEvent = 'ejectEvent'

export function isEjectEvent<V>(v: V) {
  return is$typed(v, id, hashEjectEvent)
}

export function validateEjectEvent<V>(v: V) {
  return validate<EjectEvent & V>(v, id, hashEjectEvent)
}

/** A pending join request. */
export interface JoinRequest {
  $type?: 'group.opensocial.defs#joinRequest'
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
