/**
 * GENERATED CODE - DO NOT MODIFY
 */
import {
  XrpcClient,
  type FetchHandler,
  type FetchHandlerOptions,
} from '@atproto/xrpc'
import { schemas } from './lexicons.js'
import { CID } from 'multiformats/cid'
import { type OmitKey, type Un$Typed } from './util.js'
import * as ComAtprotoManagedspaceCheckUserAccess from './types/com/atproto/managedspace/checkUserAccess.js'
import * as ComAtprotoManagedspacePolicy from './types/com/atproto/managedspace/policy.js'
import * as ComAtprotoMemberspaceListMembers from './types/com/atproto/memberspace/listMembers.js'
import * as ComAtprotoMemberspacePolicy from './types/com/atproto/memberspace/policy.js'
import * as ComAtprotoMemberspacePutMember from './types/com/atproto/memberspace/putMember.js'
import * as ComAtprotoMemberspaceRemoveMember from './types/com/atproto/memberspace/removeMember.js'
import * as ComAtprotoPersonalspacePolicy from './types/com/atproto/personalspace/policy.js'
import * as ComAtprotoServerGetServiceAuth from './types/com/atproto/server/getServiceAuth.js'
import * as ComAtprotoSpaceApplyWrites from './types/com/atproto/space/applyWrites.js'
import * as ComAtprotoSpaceClearRecords from './types/com/atproto/space/clearRecords.js'
import * as ComAtprotoSpaceCreateRecord from './types/com/atproto/space/createRecord.js'
import * as ComAtprotoSpaceCreateSpace from './types/com/atproto/space/createSpace.js'
import * as ComAtprotoSpaceDefs from './types/com/atproto/space/defs.js'
import * as ComAtprotoSpaceDeleteRecord from './types/com/atproto/space/deleteRecord.js'
import * as ComAtprotoSpaceDeleteSpace from './types/com/atproto/space/deleteSpace.js'
import * as ComAtprotoSpaceExportSpaceMeta from './types/com/atproto/space/exportSpaceMeta.js'
import * as ComAtprotoSpaceGetBlob from './types/com/atproto/space/getBlob.js'
import * as ComAtprotoSpaceGetDelegationToken from './types/com/atproto/space/getDelegationToken.js'
import * as ComAtprotoSpaceGetLatestCommit from './types/com/atproto/space/getLatestCommit.js'
import * as ComAtprotoSpaceGetRecord from './types/com/atproto/space/getRecord.js'
import * as ComAtprotoSpaceGetRepo from './types/com/atproto/space/getRepo.js'
import * as ComAtprotoSpaceGetSpace from './types/com/atproto/space/getSpace.js'
import * as ComAtprotoSpaceGetSpaceCredential from './types/com/atproto/space/getSpaceCredential.js'
import * as ComAtprotoSpaceImportRepo from './types/com/atproto/space/importRepo.js'
import * as ComAtprotoSpaceImportSpaceMeta from './types/com/atproto/space/importSpaceMeta.js'
import * as ComAtprotoSpaceListBlobs from './types/com/atproto/space/listBlobs.js'
import * as ComAtprotoSpaceListRecords from './types/com/atproto/space/listRecords.js'
import * as ComAtprotoSpaceListRepoOps from './types/com/atproto/space/listRepoOps.js'
import * as ComAtprotoSpaceListRepos from './types/com/atproto/space/listRepos.js'
import * as ComAtprotoSpaceListSpaces from './types/com/atproto/space/listSpaces.js'
import * as ComAtprotoSpaceNotifyCredentialRevoked from './types/com/atproto/space/notifyCredentialRevoked.js'
import * as ComAtprotoSpaceNotifySpaceDeleted from './types/com/atproto/space/notifySpaceDeleted.js'
import * as ComAtprotoSpaceNotifyWrite from './types/com/atproto/space/notifyWrite.js'
import * as ComAtprotoSpacePutRecord from './types/com/atproto/space/putRecord.js'
import * as ComAtprotoSpaceRegisterNotify from './types/com/atproto/space/registerNotify.js'
import * as ComAtprotoSpaceRemoveWriter from './types/com/atproto/space/removeWriter.js'
import * as ComAtprotoSpaceUnregisterNotify from './types/com/atproto/space/unregisterNotify.js'
import * as ComAtprotoSpaceUpdateSpace from './types/com/atproto/space/updateSpace.js'
import * as OrgSlackOperatorExecute from './types/org/slack/operator/execute.js'
import * as OrgSlackOperatorGetOperation from './types/org/slack/operator/getOperation.js'
import * as OrgSlackOperatorListInboxWriters from './types/org/slack/operator/listInboxWriters.js'

export * as ComAtprotoManagedspaceCheckUserAccess from './types/com/atproto/managedspace/checkUserAccess.js'
export * as ComAtprotoManagedspacePolicy from './types/com/atproto/managedspace/policy.js'
export * as ComAtprotoMemberspaceListMembers from './types/com/atproto/memberspace/listMembers.js'
export * as ComAtprotoMemberspacePolicy from './types/com/atproto/memberspace/policy.js'
export * as ComAtprotoMemberspacePutMember from './types/com/atproto/memberspace/putMember.js'
export * as ComAtprotoMemberspaceRemoveMember from './types/com/atproto/memberspace/removeMember.js'
export * as ComAtprotoPersonalspacePolicy from './types/com/atproto/personalspace/policy.js'
export * as ComAtprotoServerGetServiceAuth from './types/com/atproto/server/getServiceAuth.js'
export * as ComAtprotoSpaceApplyWrites from './types/com/atproto/space/applyWrites.js'
export * as ComAtprotoSpaceClearRecords from './types/com/atproto/space/clearRecords.js'
export * as ComAtprotoSpaceCreateRecord from './types/com/atproto/space/createRecord.js'
export * as ComAtprotoSpaceCreateSpace from './types/com/atproto/space/createSpace.js'
export * as ComAtprotoSpaceDefs from './types/com/atproto/space/defs.js'
export * as ComAtprotoSpaceDeleteRecord from './types/com/atproto/space/deleteRecord.js'
export * as ComAtprotoSpaceDeleteSpace from './types/com/atproto/space/deleteSpace.js'
export * as ComAtprotoSpaceExportSpaceMeta from './types/com/atproto/space/exportSpaceMeta.js'
export * as ComAtprotoSpaceGetBlob from './types/com/atproto/space/getBlob.js'
export * as ComAtprotoSpaceGetDelegationToken from './types/com/atproto/space/getDelegationToken.js'
export * as ComAtprotoSpaceGetLatestCommit from './types/com/atproto/space/getLatestCommit.js'
export * as ComAtprotoSpaceGetRecord from './types/com/atproto/space/getRecord.js'
export * as ComAtprotoSpaceGetRepo from './types/com/atproto/space/getRepo.js'
export * as ComAtprotoSpaceGetSpace from './types/com/atproto/space/getSpace.js'
export * as ComAtprotoSpaceGetSpaceCredential from './types/com/atproto/space/getSpaceCredential.js'
export * as ComAtprotoSpaceImportRepo from './types/com/atproto/space/importRepo.js'
export * as ComAtprotoSpaceImportSpaceMeta from './types/com/atproto/space/importSpaceMeta.js'
export * as ComAtprotoSpaceListBlobs from './types/com/atproto/space/listBlobs.js'
export * as ComAtprotoSpaceListRecords from './types/com/atproto/space/listRecords.js'
export * as ComAtprotoSpaceListRepoOps from './types/com/atproto/space/listRepoOps.js'
export * as ComAtprotoSpaceListRepos from './types/com/atproto/space/listRepos.js'
export * as ComAtprotoSpaceListSpaces from './types/com/atproto/space/listSpaces.js'
export * as ComAtprotoSpaceNotifyCredentialRevoked from './types/com/atproto/space/notifyCredentialRevoked.js'
export * as ComAtprotoSpaceNotifySpaceDeleted from './types/com/atproto/space/notifySpaceDeleted.js'
export * as ComAtprotoSpaceNotifyWrite from './types/com/atproto/space/notifyWrite.js'
export * as ComAtprotoSpacePutRecord from './types/com/atproto/space/putRecord.js'
export * as ComAtprotoSpaceRegisterNotify from './types/com/atproto/space/registerNotify.js'
export * as ComAtprotoSpaceRemoveWriter from './types/com/atproto/space/removeWriter.js'
export * as ComAtprotoSpaceUnregisterNotify from './types/com/atproto/space/unregisterNotify.js'
export * as ComAtprotoSpaceUpdateSpace from './types/com/atproto/space/updateSpace.js'
export * as OrgSlackOperatorExecute from './types/org/slack/operator/execute.js'
export * as OrgSlackOperatorGetOperation from './types/org/slack/operator/getOperation.js'
export * as OrgSlackOperatorListInboxWriters from './types/org/slack/operator/listInboxWriters.js'

export class AtpBaseClient extends XrpcClient {
  com: ComNS
  org: OrgNS

  constructor(options: FetchHandler | FetchHandlerOptions) {
    super(options, schemas)
    this.com = new ComNS(this)
    this.org = new OrgNS(this)
  }

  /** @deprecated use `this` instead */
  get xrpc(): XrpcClient {
    return this
  }
}

export class ComNS {
  _client: XrpcClient
  atproto: ComAtprotoNS

  constructor(client: XrpcClient) {
    this._client = client
    this.atproto = new ComAtprotoNS(client)
  }
}

export class ComAtprotoNS {
  _client: XrpcClient
  managedspace: ComAtprotoManagedspaceNS
  memberspace: ComAtprotoMemberspaceNS
  personalspace: ComAtprotoPersonalspaceNS
  server: ComAtprotoServerNS
  space: ComAtprotoSpaceNS

  constructor(client: XrpcClient) {
    this._client = client
    this.managedspace = new ComAtprotoManagedspaceNS(client)
    this.memberspace = new ComAtprotoMemberspaceNS(client)
    this.personalspace = new ComAtprotoPersonalspaceNS(client)
    this.server = new ComAtprotoServerNS(client)
    this.space = new ComAtprotoSpaceNS(client)
  }
}

export class ComAtprotoManagedspaceNS {
  _client: XrpcClient

  constructor(client: XrpcClient) {
    this._client = client
  }

  checkUserAccess(
    params?: ComAtprotoManagedspaceCheckUserAccess.QueryParams,
    opts?: ComAtprotoManagedspaceCheckUserAccess.CallOptions,
  ): Promise<ComAtprotoManagedspaceCheckUserAccess.Response> {
    return this._client.call(
      'com.atproto.managedspace.checkUserAccess',
      params,
      undefined,
      opts,
    )
  }
}

export class ComAtprotoMemberspaceNS {
  _client: XrpcClient

  constructor(client: XrpcClient) {
    this._client = client
  }

  listMembers(
    params?: ComAtprotoMemberspaceListMembers.QueryParams,
    opts?: ComAtprotoMemberspaceListMembers.CallOptions,
  ): Promise<ComAtprotoMemberspaceListMembers.Response> {
    return this._client
      .call('com.atproto.memberspace.listMembers', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoMemberspaceListMembers.toKnownErr(e)
      })
  }

  putMember(
    data?: ComAtprotoMemberspacePutMember.InputSchema,
    opts?: ComAtprotoMemberspacePutMember.CallOptions,
  ): Promise<ComAtprotoMemberspacePutMember.Response> {
    return this._client
      .call('com.atproto.memberspace.putMember', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoMemberspacePutMember.toKnownErr(e)
      })
  }

  removeMember(
    data?: ComAtprotoMemberspaceRemoveMember.InputSchema,
    opts?: ComAtprotoMemberspaceRemoveMember.CallOptions,
  ): Promise<ComAtprotoMemberspaceRemoveMember.Response> {
    return this._client
      .call('com.atproto.memberspace.removeMember', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoMemberspaceRemoveMember.toKnownErr(e)
      })
  }
}

export class ComAtprotoPersonalspaceNS {
  _client: XrpcClient

  constructor(client: XrpcClient) {
    this._client = client
  }
}

export class ComAtprotoServerNS {
  _client: XrpcClient

  constructor(client: XrpcClient) {
    this._client = client
  }

  getServiceAuth(
    params?: ComAtprotoServerGetServiceAuth.QueryParams,
    opts?: ComAtprotoServerGetServiceAuth.CallOptions,
  ): Promise<ComAtprotoServerGetServiceAuth.Response> {
    return this._client
      .call('com.atproto.server.getServiceAuth', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoServerGetServiceAuth.toKnownErr(e)
      })
  }
}

export class ComAtprotoSpaceNS {
  _client: XrpcClient

  constructor(client: XrpcClient) {
    this._client = client
  }

  applyWrites(
    data?: ComAtprotoSpaceApplyWrites.InputSchema,
    opts?: ComAtprotoSpaceApplyWrites.CallOptions,
  ): Promise<ComAtprotoSpaceApplyWrites.Response> {
    return this._client
      .call('com.atproto.space.applyWrites', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceApplyWrites.toKnownErr(e)
      })
  }

  clearRecords(
    data?: ComAtprotoSpaceClearRecords.InputSchema,
    opts?: ComAtprotoSpaceClearRecords.CallOptions,
  ): Promise<ComAtprotoSpaceClearRecords.Response> {
    return this._client.call(
      'com.atproto.space.clearRecords',
      opts?.qp,
      data,
      opts,
    )
  }

  createRecord(
    data?: ComAtprotoSpaceCreateRecord.InputSchema,
    opts?: ComAtprotoSpaceCreateRecord.CallOptions,
  ): Promise<ComAtprotoSpaceCreateRecord.Response> {
    return this._client
      .call('com.atproto.space.createRecord', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceCreateRecord.toKnownErr(e)
      })
  }

  createSpace(
    data?: ComAtprotoSpaceCreateSpace.InputSchema,
    opts?: ComAtprotoSpaceCreateSpace.CallOptions,
  ): Promise<ComAtprotoSpaceCreateSpace.Response> {
    return this._client
      .call('com.atproto.space.createSpace', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceCreateSpace.toKnownErr(e)
      })
  }

  deleteRecord(
    data?: ComAtprotoSpaceDeleteRecord.InputSchema,
    opts?: ComAtprotoSpaceDeleteRecord.CallOptions,
  ): Promise<ComAtprotoSpaceDeleteRecord.Response> {
    return this._client
      .call('com.atproto.space.deleteRecord', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceDeleteRecord.toKnownErr(e)
      })
  }

  deleteSpace(
    data?: ComAtprotoSpaceDeleteSpace.InputSchema,
    opts?: ComAtprotoSpaceDeleteSpace.CallOptions,
  ): Promise<ComAtprotoSpaceDeleteSpace.Response> {
    return this._client
      .call('com.atproto.space.deleteSpace', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceDeleteSpace.toKnownErr(e)
      })
  }

  exportSpaceMeta(
    params?: ComAtprotoSpaceExportSpaceMeta.QueryParams,
    opts?: ComAtprotoSpaceExportSpaceMeta.CallOptions,
  ): Promise<ComAtprotoSpaceExportSpaceMeta.Response> {
    return this._client
      .call('com.atproto.space.exportSpaceMeta', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceExportSpaceMeta.toKnownErr(e)
      })
  }

  getBlob(
    params?: ComAtprotoSpaceGetBlob.QueryParams,
    opts?: ComAtprotoSpaceGetBlob.CallOptions,
  ): Promise<ComAtprotoSpaceGetBlob.Response> {
    return this._client
      .call('com.atproto.space.getBlob', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceGetBlob.toKnownErr(e)
      })
  }

  getDelegationToken(
    params?: ComAtprotoSpaceGetDelegationToken.QueryParams,
    opts?: ComAtprotoSpaceGetDelegationToken.CallOptions,
  ): Promise<ComAtprotoSpaceGetDelegationToken.Response> {
    return this._client.call(
      'com.atproto.space.getDelegationToken',
      params,
      undefined,
      opts,
    )
  }

  getLatestCommit(
    params?: ComAtprotoSpaceGetLatestCommit.QueryParams,
    opts?: ComAtprotoSpaceGetLatestCommit.CallOptions,
  ): Promise<ComAtprotoSpaceGetLatestCommit.Response> {
    return this._client
      .call('com.atproto.space.getLatestCommit', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceGetLatestCommit.toKnownErr(e)
      })
  }

  getRecord(
    params?: ComAtprotoSpaceGetRecord.QueryParams,
    opts?: ComAtprotoSpaceGetRecord.CallOptions,
  ): Promise<ComAtprotoSpaceGetRecord.Response> {
    return this._client
      .call('com.atproto.space.getRecord', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceGetRecord.toKnownErr(e)
      })
  }

  getRepo(
    params?: ComAtprotoSpaceGetRepo.QueryParams,
    opts?: ComAtprotoSpaceGetRepo.CallOptions,
  ): Promise<ComAtprotoSpaceGetRepo.Response> {
    return this._client
      .call('com.atproto.space.getRepo', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceGetRepo.toKnownErr(e)
      })
  }

  getSpace(
    params?: ComAtprotoSpaceGetSpace.QueryParams,
    opts?: ComAtprotoSpaceGetSpace.CallOptions,
  ): Promise<ComAtprotoSpaceGetSpace.Response> {
    return this._client
      .call('com.atproto.space.getSpace', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceGetSpace.toKnownErr(e)
      })
  }

  getSpaceCredential(
    data?: ComAtprotoSpaceGetSpaceCredential.InputSchema,
    opts?: ComAtprotoSpaceGetSpaceCredential.CallOptions,
  ): Promise<ComAtprotoSpaceGetSpaceCredential.Response> {
    return this._client
      .call('com.atproto.space.getSpaceCredential', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceGetSpaceCredential.toKnownErr(e)
      })
  }

  importRepo(
    data?: ComAtprotoSpaceImportRepo.InputSchema,
    opts?: ComAtprotoSpaceImportRepo.CallOptions,
  ): Promise<ComAtprotoSpaceImportRepo.Response> {
    return this._client
      .call('com.atproto.space.importRepo', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceImportRepo.toKnownErr(e)
      })
  }

  importSpaceMeta(
    data?: ComAtprotoSpaceImportSpaceMeta.InputSchema,
    opts?: ComAtprotoSpaceImportSpaceMeta.CallOptions,
  ): Promise<ComAtprotoSpaceImportSpaceMeta.Response> {
    return this._client
      .call('com.atproto.space.importSpaceMeta', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceImportSpaceMeta.toKnownErr(e)
      })
  }

  listBlobs(
    params?: ComAtprotoSpaceListBlobs.QueryParams,
    opts?: ComAtprotoSpaceListBlobs.CallOptions,
  ): Promise<ComAtprotoSpaceListBlobs.Response> {
    return this._client
      .call('com.atproto.space.listBlobs', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceListBlobs.toKnownErr(e)
      })
  }

  listRecords(
    params?: ComAtprotoSpaceListRecords.QueryParams,
    opts?: ComAtprotoSpaceListRecords.CallOptions,
  ): Promise<ComAtprotoSpaceListRecords.Response> {
    return this._client
      .call('com.atproto.space.listRecords', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceListRecords.toKnownErr(e)
      })
  }

  listRepoOps(
    params?: ComAtprotoSpaceListRepoOps.QueryParams,
    opts?: ComAtprotoSpaceListRepoOps.CallOptions,
  ): Promise<ComAtprotoSpaceListRepoOps.Response> {
    return this._client
      .call('com.atproto.space.listRepoOps', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceListRepoOps.toKnownErr(e)
      })
  }

  listRepos(
    params?: ComAtprotoSpaceListRepos.QueryParams,
    opts?: ComAtprotoSpaceListRepos.CallOptions,
  ): Promise<ComAtprotoSpaceListRepos.Response> {
    return this._client
      .call('com.atproto.space.listRepos', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSpaceListRepos.toKnownErr(e)
      })
  }

  listSpaces(
    params?: ComAtprotoSpaceListSpaces.QueryParams,
    opts?: ComAtprotoSpaceListSpaces.CallOptions,
  ): Promise<ComAtprotoSpaceListSpaces.Response> {
    return this._client.call(
      'com.atproto.space.listSpaces',
      params,
      undefined,
      opts,
    )
  }

  notifyCredentialRevoked(
    data?: ComAtprotoSpaceNotifyCredentialRevoked.InputSchema,
    opts?: ComAtprotoSpaceNotifyCredentialRevoked.CallOptions,
  ): Promise<ComAtprotoSpaceNotifyCredentialRevoked.Response> {
    return this._client.call(
      'com.atproto.space.notifyCredentialRevoked',
      opts?.qp,
      data,
      opts,
    )
  }

  notifySpaceDeleted(
    data?: ComAtprotoSpaceNotifySpaceDeleted.InputSchema,
    opts?: ComAtprotoSpaceNotifySpaceDeleted.CallOptions,
  ): Promise<ComAtprotoSpaceNotifySpaceDeleted.Response> {
    return this._client.call(
      'com.atproto.space.notifySpaceDeleted',
      opts?.qp,
      data,
      opts,
    )
  }

  notifyWrite(
    data?: ComAtprotoSpaceNotifyWrite.InputSchema,
    opts?: ComAtprotoSpaceNotifyWrite.CallOptions,
  ): Promise<ComAtprotoSpaceNotifyWrite.Response> {
    return this._client
      .call('com.atproto.space.notifyWrite', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceNotifyWrite.toKnownErr(e)
      })
  }

  putRecord(
    data?: ComAtprotoSpacePutRecord.InputSchema,
    opts?: ComAtprotoSpacePutRecord.CallOptions,
  ): Promise<ComAtprotoSpacePutRecord.Response> {
    return this._client
      .call('com.atproto.space.putRecord', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpacePutRecord.toKnownErr(e)
      })
  }

  registerNotify(
    data?: ComAtprotoSpaceRegisterNotify.InputSchema,
    opts?: ComAtprotoSpaceRegisterNotify.CallOptions,
  ): Promise<ComAtprotoSpaceRegisterNotify.Response> {
    return this._client
      .call('com.atproto.space.registerNotify', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceRegisterNotify.toKnownErr(e)
      })
  }

  removeWriter(
    data?: ComAtprotoSpaceRemoveWriter.InputSchema,
    opts?: ComAtprotoSpaceRemoveWriter.CallOptions,
  ): Promise<ComAtprotoSpaceRemoveWriter.Response> {
    return this._client
      .call('com.atproto.space.removeWriter', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceRemoveWriter.toKnownErr(e)
      })
  }

  unregisterNotify(
    data?: ComAtprotoSpaceUnregisterNotify.InputSchema,
    opts?: ComAtprotoSpaceUnregisterNotify.CallOptions,
  ): Promise<ComAtprotoSpaceUnregisterNotify.Response> {
    return this._client
      .call('com.atproto.space.unregisterNotify', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceUnregisterNotify.toKnownErr(e)
      })
  }

  updateSpace(
    data?: ComAtprotoSpaceUpdateSpace.InputSchema,
    opts?: ComAtprotoSpaceUpdateSpace.CallOptions,
  ): Promise<ComAtprotoSpaceUpdateSpace.Response> {
    return this._client
      .call('com.atproto.space.updateSpace', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSpaceUpdateSpace.toKnownErr(e)
      })
  }
}

export class OrgNS {
  _client: XrpcClient
  slack: OrgSlackNS

  constructor(client: XrpcClient) {
    this._client = client
    this.slack = new OrgSlackNS(client)
  }
}

export class OrgSlackNS {
  _client: XrpcClient
  operator: OrgSlackOperatorNS

  constructor(client: XrpcClient) {
    this._client = client
    this.operator = new OrgSlackOperatorNS(client)
  }
}

export class OrgSlackOperatorNS {
  _client: XrpcClient

  constructor(client: XrpcClient) {
    this._client = client
  }

  execute(
    data?: OrgSlackOperatorExecute.InputSchema,
    opts?: OrgSlackOperatorExecute.CallOptions,
  ): Promise<OrgSlackOperatorExecute.Response> {
    return this._client
      .call('org.slack.operator.execute', opts?.qp, data, opts)
      .catch((e) => {
        throw OrgSlackOperatorExecute.toKnownErr(e)
      })
  }

  getOperation(
    params?: OrgSlackOperatorGetOperation.QueryParams,
    opts?: OrgSlackOperatorGetOperation.CallOptions,
  ): Promise<OrgSlackOperatorGetOperation.Response> {
    return this._client
      .call('org.slack.operator.getOperation', params, undefined, opts)
      .catch((e) => {
        throw OrgSlackOperatorGetOperation.toKnownErr(e)
      })
  }

  listInboxWriters(
    params?: OrgSlackOperatorListInboxWriters.QueryParams,
    opts?: OrgSlackOperatorListInboxWriters.CallOptions,
  ): Promise<OrgSlackOperatorListInboxWriters.Response> {
    return this._client
      .call('org.slack.operator.listInboxWriters', params, undefined, opts)
      .catch((e) => {
        throw OrgSlackOperatorListInboxWriters.toKnownErr(e)
      })
  }
}
