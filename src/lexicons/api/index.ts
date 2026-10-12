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
import * as ComAtprotoServerGetServiceAuth from './types/com/atproto/server/getServiceAuth.js'
import * as ComAtprotoSimplespaceCheckUserAccess from './types/com/atproto/simplespace/checkUserAccess.js'
import * as ComAtprotoSimplespaceCreateSpace from './types/com/atproto/simplespace/createSpace.js'
import * as ComAtprotoSimplespaceDefs from './types/com/atproto/simplespace/defs.js'
import * as ComAtprotoSimplespaceDeleteSpace from './types/com/atproto/simplespace/deleteSpace.js'
import * as ComAtprotoSimplespaceGetSpace from './types/com/atproto/simplespace/getSpace.js'
import * as ComAtprotoSimplespaceListMembers from './types/com/atproto/simplespace/listMembers.js'
import * as ComAtprotoSimplespacePutMember from './types/com/atproto/simplespace/putMember.js'
import * as ComAtprotoSimplespaceRemoveMember from './types/com/atproto/simplespace/removeMember.js'
import * as ComAtprotoSimplespaceUpdateSpace from './types/com/atproto/simplespace/updateSpace.js'
import * as ComAtprotoSpaceApplyWrites from './types/com/atproto/space/applyWrites.js'
import * as ComAtprotoSpaceCreateRecord from './types/com/atproto/space/createRecord.js'
import * as ComAtprotoSpaceDefs from './types/com/atproto/space/defs.js'
import * as ComAtprotoSpaceDeleteRecord from './types/com/atproto/space/deleteRecord.js'
import * as ComAtprotoSpaceGetBlob from './types/com/atproto/space/getBlob.js'
import * as ComAtprotoSpaceGetDelegationToken from './types/com/atproto/space/getDelegationToken.js'
import * as ComAtprotoSpaceGetLatestCommit from './types/com/atproto/space/getLatestCommit.js'
import * as ComAtprotoSpaceGetRecord from './types/com/atproto/space/getRecord.js'
import * as ComAtprotoSpaceGetRepo from './types/com/atproto/space/getRepo.js'
import * as ComAtprotoSpaceGetSpaceCredential from './types/com/atproto/space/getSpaceCredential.js'
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
import * as ComAtprotoSpaceUnregisterNotify from './types/com/atproto/space/unregisterNotify.js'
import * as OrgSlackOperatorExecute from './types/org/slack/operator/execute.js'
import * as OrgSlackOperatorGetOperation from './types/org/slack/operator/getOperation.js'
import * as OrgSlackOperatorListInboxWriters from './types/org/slack/operator/listInboxWriters.js'

export * as ComAtprotoServerGetServiceAuth from './types/com/atproto/server/getServiceAuth.js'
export * as ComAtprotoSimplespaceCheckUserAccess from './types/com/atproto/simplespace/checkUserAccess.js'
export * as ComAtprotoSimplespaceCreateSpace from './types/com/atproto/simplespace/createSpace.js'
export * as ComAtprotoSimplespaceDefs from './types/com/atproto/simplespace/defs.js'
export * as ComAtprotoSimplespaceDeleteSpace from './types/com/atproto/simplespace/deleteSpace.js'
export * as ComAtprotoSimplespaceGetSpace from './types/com/atproto/simplespace/getSpace.js'
export * as ComAtprotoSimplespaceListMembers from './types/com/atproto/simplespace/listMembers.js'
export * as ComAtprotoSimplespacePutMember from './types/com/atproto/simplespace/putMember.js'
export * as ComAtprotoSimplespaceRemoveMember from './types/com/atproto/simplespace/removeMember.js'
export * as ComAtprotoSimplespaceUpdateSpace from './types/com/atproto/simplespace/updateSpace.js'
export * as ComAtprotoSpaceApplyWrites from './types/com/atproto/space/applyWrites.js'
export * as ComAtprotoSpaceCreateRecord from './types/com/atproto/space/createRecord.js'
export * as ComAtprotoSpaceDefs from './types/com/atproto/space/defs.js'
export * as ComAtprotoSpaceDeleteRecord from './types/com/atproto/space/deleteRecord.js'
export * as ComAtprotoSpaceGetBlob from './types/com/atproto/space/getBlob.js'
export * as ComAtprotoSpaceGetDelegationToken from './types/com/atproto/space/getDelegationToken.js'
export * as ComAtprotoSpaceGetLatestCommit from './types/com/atproto/space/getLatestCommit.js'
export * as ComAtprotoSpaceGetRecord from './types/com/atproto/space/getRecord.js'
export * as ComAtprotoSpaceGetRepo from './types/com/atproto/space/getRepo.js'
export * as ComAtprotoSpaceGetSpaceCredential from './types/com/atproto/space/getSpaceCredential.js'
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
export * as ComAtprotoSpaceUnregisterNotify from './types/com/atproto/space/unregisterNotify.js'
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
  server: ComAtprotoServerNS
  simplespace: ComAtprotoSimplespaceNS
  space: ComAtprotoSpaceNS

  constructor(client: XrpcClient) {
    this._client = client
    this.server = new ComAtprotoServerNS(client)
    this.simplespace = new ComAtprotoSimplespaceNS(client)
    this.space = new ComAtprotoSpaceNS(client)
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

export class ComAtprotoSimplespaceNS {
  _client: XrpcClient

  constructor(client: XrpcClient) {
    this._client = client
  }

  checkUserAccess(
    params?: ComAtprotoSimplespaceCheckUserAccess.QueryParams,
    opts?: ComAtprotoSimplespaceCheckUserAccess.CallOptions,
  ): Promise<ComAtprotoSimplespaceCheckUserAccess.Response> {
    return this._client.call(
      'com.atproto.simplespace.checkUserAccess',
      params,
      undefined,
      opts,
    )
  }

  createSpace(
    data?: ComAtprotoSimplespaceCreateSpace.InputSchema,
    opts?: ComAtprotoSimplespaceCreateSpace.CallOptions,
  ): Promise<ComAtprotoSimplespaceCreateSpace.Response> {
    return this._client
      .call('com.atproto.simplespace.createSpace', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSimplespaceCreateSpace.toKnownErr(e)
      })
  }

  deleteSpace(
    data?: ComAtprotoSimplespaceDeleteSpace.InputSchema,
    opts?: ComAtprotoSimplespaceDeleteSpace.CallOptions,
  ): Promise<ComAtprotoSimplespaceDeleteSpace.Response> {
    return this._client
      .call('com.atproto.simplespace.deleteSpace', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSimplespaceDeleteSpace.toKnownErr(e)
      })
  }

  getSpace(
    params?: ComAtprotoSimplespaceGetSpace.QueryParams,
    opts?: ComAtprotoSimplespaceGetSpace.CallOptions,
  ): Promise<ComAtprotoSimplespaceGetSpace.Response> {
    return this._client
      .call('com.atproto.simplespace.getSpace', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSimplespaceGetSpace.toKnownErr(e)
      })
  }

  listMembers(
    params?: ComAtprotoSimplespaceListMembers.QueryParams,
    opts?: ComAtprotoSimplespaceListMembers.CallOptions,
  ): Promise<ComAtprotoSimplespaceListMembers.Response> {
    return this._client
      .call('com.atproto.simplespace.listMembers', params, undefined, opts)
      .catch((e) => {
        throw ComAtprotoSimplespaceListMembers.toKnownErr(e)
      })
  }

  putMember(
    data?: ComAtprotoSimplespacePutMember.InputSchema,
    opts?: ComAtprotoSimplespacePutMember.CallOptions,
  ): Promise<ComAtprotoSimplespacePutMember.Response> {
    return this._client
      .call('com.atproto.simplespace.putMember', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSimplespacePutMember.toKnownErr(e)
      })
  }

  removeMember(
    data?: ComAtprotoSimplespaceRemoveMember.InputSchema,
    opts?: ComAtprotoSimplespaceRemoveMember.CallOptions,
  ): Promise<ComAtprotoSimplespaceRemoveMember.Response> {
    return this._client
      .call('com.atproto.simplespace.removeMember', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSimplespaceRemoveMember.toKnownErr(e)
      })
  }

  updateSpace(
    data?: ComAtprotoSimplespaceUpdateSpace.InputSchema,
    opts?: ComAtprotoSimplespaceUpdateSpace.CallOptions,
  ): Promise<ComAtprotoSimplespaceUpdateSpace.Response> {
    return this._client
      .call('com.atproto.simplespace.updateSpace', opts?.qp, data, opts)
      .catch((e) => {
        throw ComAtprotoSimplespaceUpdateSpace.toKnownErr(e)
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
