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
const id = 'org.atgrp.mod.defs'

export type ReasonType =
  | 'org.atgrp.mod.defs#reasonSpam'
  | 'org.atgrp.mod.defs#reasonViolation'
  | 'org.atgrp.mod.defs#reasonMisleading'
  | 'org.atgrp.mod.defs#reasonNsfw'
  | 'org.atgrp.mod.defs#reasonRude'
  | 'org.atgrp.mod.defs#reasonOther'
  | (string & {})

/** Spam or unwanted promotion. */
export const REASONSPAM = `${id}#reasonSpam`
/** Breaks a group rule. */
export const REASONVIOLATION = `${id}#reasonViolation`
/** Misleading content, impersonation, or scams. */
export const REASONMISLEADING = `${id}#reasonMisleading`
/** Unwanted or unlabeled NSFW content. */
export const REASONNSFW = `${id}#reasonNsfw`
/** Rude, harassing, or hateful content. */
export const REASONRUDE = `${id}#reasonRude`
/** Anything else. */
export const REASONOTHER = `${id}#reasonOther`

/** A subject in the moderation queue. */
export interface SubjectView {
  $type?: 'org.atgrp.mod.defs#subjectView'
  /** An account DID or record URI. */
  subject: string
  /** If set, a specific version of the record. */
  cid?: string
  status: 'open' | 'resolved'
  createdAt: string
  updatedAt: string
  reportCount?: number
  /** Free-form moderator tags in label value syntax ([a-z-]+). */
  tags?: string[]
}

const hashSubjectView = 'subjectView'

export function isSubjectView<V>(v: V) {
  return is$typed(v, id, hashSubjectView)
}

export function validateSubjectView<V>(v: V) {
  return validate<SubjectView & V>(v, id, hashSubjectView)
}

/** An event in a subject's moderation history. */
export interface EventView {
  $type?: 'org.atgrp.mod.defs#eventView'
  eventId: string
  createdAt: string
  /** An account DID or record URI. */
  subject: string
  /** If set, a specific version of the record. */
  cid?: string
  /** May be withheld to protect reporters and moderators. */
  createdBy?: string
  event:
    | $Typed<ReportEvent>
    | $Typed<AppealEvent>
    | $Typed<StatusEvent>
    | $Typed<TagEvent>
    | $Typed<LabelEvent>
    | $Typed<EjectEvent>
    | { $type: string }
}

const hashEventView = 'eventView'

export function isEventView<V>(v: V) {
  return is$typed(v, id, hashEventView)
}

export function validateEventView<V>(v: V) {
  return validate<EventView & V>(v, id, hashEventView)
}

/** A report was filed. */
export interface ReportEvent {
  $type?: 'org.atgrp.mod.defs#reportEvent'
  reasonType: ReasonType
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

/** An appeal was filed. */
export interface AppealEvent {
  $type?: 'org.atgrp.mod.defs#appealEvent'
  note?: string
}

const hashAppealEvent = 'appealEvent'

export function isAppealEvent<V>(v: V) {
  return is$typed(v, id, hashAppealEvent)
}

export function validateAppealEvent<V>(v: V) {
  return validate<AppealEvent & V>(v, id, hashAppealEvent)
}

/** A moderator changed the subject's status or added a note. */
export interface StatusEvent {
  $type?: 'org.atgrp.mod.defs#statusEvent'
  /** The status after this event. */
  status: 'open' | 'resolved'
  /** Only visible to moderators. */
  note?: string
}

const hashStatusEvent = 'statusEvent'

export function isStatusEvent<V>(v: V) {
  return is$typed(v, id, hashStatusEvent)
}

export function validateStatusEvent<V>(v: V) {
  return validate<StatusEvent & V>(v, id, hashStatusEvent)
}

/** A moderator added or removed tags. */
export interface TagEvent {
  $type?: 'org.atgrp.mod.defs#tagEvent'
  add?: string[]
  remove?: string[]
}

const hashTagEvent = 'tagEvent'

export function isTagEvent<V>(v: V) {
  return is$typed(v, id, hashTagEvent)
}

export function validateTagEvent<V>(v: V) {
  return validate<TagEvent & V>(v, id, hashTagEvent)
}

/** A label record was written or deleted. */
export interface LabelEvent {
  $type?: 'org.atgrp.mod.defs#labelEvent'
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
  $type?: 'org.atgrp.mod.defs#ejectEvent'
}

const hashEjectEvent = 'ejectEvent'

export function isEjectEvent<V>(v: V) {
  return is$typed(v, id, hashEjectEvent)
}

export function validateEjectEvent<V>(v: V) {
  return validate<EjectEvent & V>(v, id, hashEjectEvent)
}
