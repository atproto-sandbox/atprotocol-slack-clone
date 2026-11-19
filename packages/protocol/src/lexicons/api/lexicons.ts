/**
 * GENERATED CODE - DO NOT MODIFY
 */
import {
  type LexiconDoc,
  Lexicons,
  ValidationError,
  type ValidationResult,
} from '@atproto/lexicon'
import { type $Typed, is$typed, maybe$typed } from './util.js'

export const schemaDict = {
  ComAtprotoManagedspaceCheckAccess: {
    lexicon: 1,
    id: 'com.atproto.managedspace.checkAccess',
    defs: {
      main: {
        type: 'query',
        description:
          "Check an account's read and write access to a managed space. Called by the space host, implemented by the space's managing app. Requires service auth.",
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
            clientId: {
              type: 'string',
              format: 'uri',
              description:
                'OAuth client ID of the requesting app, if attested.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['read', 'write'],
            properties: {
              read: {
                type: 'boolean',
              },
              write: {
                type: 'boolean',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoManagedspacePolicy: {
    lexicon: 1,
    id: 'com.atproto.managedspace.policy',
    defs: {
      main: {
        type: 'object',
        description:
          'Space policy that delegates access decisions to an external app through checkAccess.',
        required: ['managingApp'],
        properties: {
          managingApp: {
            type: 'string',
            description: 'The `did#serviceId` reference of the managing app.',
          },
          publishPolicy: {
            type: 'boolean',
            default: false,
            description:
              'Publish the policy as a com.atproto.space.policy record in the space.',
          },
        },
      },
    },
  },
  ComAtprotoMemberspaceDefs: {
    lexicon: 1,
    id: 'com.atproto.memberspace.defs',
    defs: {
      member: {
        type: 'object',
        required: ['did', 'read', 'write'],
        properties: {
          did: {
            type: 'string',
            format: 'did',
          },
          read: {
            type: 'boolean',
          },
          write: {
            type: 'boolean',
          },
        },
      },
    },
  },
  ComAtprotoMemberspaceListMembers: {
    lexicon: 1,
    id: 'com.atproto.memberspace.listMembers',
    defs: {
      main: {
        type: 'query',
        description:
          'List the members of a space with a memberspace policy. Requires auth as the space authority, implemented by PDS.',
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 100,
            },
            cursor: {
              type: 'string',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['members'],
            properties: {
              cursor: {
                type: 'string',
              },
              members: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:com.atproto.memberspace.defs#member',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
          {
            name: 'PolicyMismatch',
            description: 'The space does not have a memberspace policy.',
          },
          {
            name: 'InvalidCursor',
          },
        ],
      },
    },
  },
  ComAtprotoMemberspacePolicy: {
    lexicon: 1,
    id: 'com.atproto.memberspace.policy',
    defs: {
      main: {
        type: 'object',
        description: 'Space policy that grants access based on a member list.',
        properties: {
          publicRead: {
            type: 'boolean',
            default: false,
            description:
              'If true, anyone may read the space. Otherwise, only members with read access.',
          },
          publicWrite: {
            type: 'boolean',
            default: false,
            description:
              "If true, any account's writes are tracked in the writer set, except members without write access. Otherwise, only members with write access.",
          },
          allowedApps: {
            type: 'array',
            description:
              'If set, only these apps (by OAuth client ID) may read the space.',
            items: {
              type: 'string',
              format: 'uri',
            },
          },
          publishPolicy: {
            type: 'boolean',
            default: false,
            description:
              'Publish the policy as a com.atproto.space.policy record in the space.',
          },
          publishMembers: {
            type: 'boolean',
            default: false,
            description:
              'Publish the member list as com.atproto.memberspace.member records in the space.',
          },
        },
      },
    },
  },
  ComAtprotoMemberspacePutMembers: {
    lexicon: 1,
    id: 'com.atproto.memberspace.putMembers',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Add members to a space, or update existing members' access, in a single commit. Requires auth as the space authority, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'members'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              members: {
                type: 'array',
                maxLength: 100,
                items: {
                  type: 'ref',
                  ref: 'lex:com.atproto.memberspace.defs#member',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
          {
            name: 'PolicyMismatch',
            description: 'The space does not have a memberspace policy.',
          },
        ],
      },
    },
  },
  ComAtprotoMemberspaceRemoveMembers: {
    lexicon: 1,
    id: 'com.atproto.memberspace.removeMembers',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Remove members from a space in a single commit. DIDs that are not members are ignored. Requires auth as the space authority, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'dids'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              dids: {
                type: 'array',
                maxLength: 100,
                items: {
                  type: 'string',
                  format: 'did',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
          {
            name: 'PolicyMismatch',
            description: 'The space does not have a memberspace policy.',
          },
        ],
      },
    },
  },
  ComAtprotoPersonalspacePolicy: {
    lexicon: 1,
    id: 'com.atproto.personalspace.policy',
    defs: {
      main: {
        type: 'object',
        description:
          'Space policy for personal data that only the space authority and authorized apps can read, such as bookmarks or drafts.',
        properties: {},
      },
    },
  },
  ComAtprotoServerGetServiceAuth: {
    lexicon: 1,
    id: 'com.atproto.server.getServiceAuth',
    defs: {
      main: {
        type: 'query',
        description:
          'Get a signed token on behalf of the requesting DID for the requested service.',
        parameters: {
          type: 'params',
          required: ['aud'],
          properties: {
            aud: {
              type: 'string',
              maxLength: 2048,
              description:
                'The DID or `did#serviceId` reference of the service that the token will be used to authenticate with.',
            },
            exp: {
              type: 'integer',
              description:
                'The time in Unix Epoch seconds that the JWT expires. Defaults to 60 seconds in the future. The service may enforce certain time bounds on tokens depending on the requested scope.',
            },
            lxm: {
              type: 'string',
              format: 'nsid',
              description:
                'Lexicon (XRPC) method to bind the requested token to',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['token'],
            properties: {
              token: {
                type: 'string',
              },
            },
          },
        },
        errors: [
          {
            name: 'BadExpiration',
            description:
              'Indicates that the requested expiration date is not a valid. May be in the past or may be reliant on the requested scopes.',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceApplyWrites: {
    lexicon: 1,
    id: 'com.atproto.space.applyWrites',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Apply a batch transaction of creates, updates, and deletes to a space repo. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'writes'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              repo: {
                type: 'string',
                format: 'did',
              },
              validate: {
                type: 'boolean',
                description:
                  "Can be set to 'false' to skip Lexicon schema validation of record data across all operations, 'true' to require it, or leave unset to validate only for known Lexicons.",
              },
              writes: {
                type: 'array',
                items: {
                  type: 'union',
                  refs: [
                    'lex:com.atproto.space.applyWrites#create',
                    'lex:com.atproto.space.applyWrites#update',
                    'lex:com.atproto.space.applyWrites#delete',
                  ],
                  closed: true,
                },
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'union',
                  refs: [
                    'lex:com.atproto.space.applyWrites#createResult',
                    'lex:com.atproto.space.applyWrites#updateResult',
                    'lex:com.atproto.space.applyWrites#deleteResult',
                  ],
                  closed: true,
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RecordNotFound',
          },
          {
            name: 'RecordAlreadyExists',
          },
        ],
      },
      create: {
        type: 'object',
        description: 'Operation which creates a new record.',
        required: ['collection', 'value'],
        properties: {
          collection: {
            type: 'string',
            format: 'nsid',
          },
          rkey: {
            type: 'string',
            format: 'record-key',
          },
          value: {
            type: 'unknown',
          },
        },
      },
      update: {
        type: 'object',
        description: 'Operation which updates an existing record.',
        required: ['collection', 'rkey', 'value'],
        properties: {
          collection: {
            type: 'string',
            format: 'nsid',
          },
          rkey: {
            type: 'string',
            format: 'record-key',
          },
          value: {
            type: 'unknown',
          },
        },
      },
      delete: {
        type: 'object',
        description: 'Operation which deletes an existing record.',
        required: ['collection', 'rkey'],
        properties: {
          collection: {
            type: 'string',
            format: 'nsid',
          },
          rkey: {
            type: 'string',
            format: 'record-key',
          },
        },
      },
      createResult: {
        type: 'object',
        required: ['uri', 'cid'],
        properties: {
          uri: {
            type: 'string',
            format: 'at-uri',
          },
          cid: {
            type: 'string',
            format: 'cid',
          },
          validationStatus: {
            type: 'string',
            knownValues: ['valid', 'unknown'],
          },
        },
      },
      updateResult: {
        type: 'object',
        required: ['uri', 'cid'],
        properties: {
          uri: {
            type: 'string',
            format: 'at-uri',
          },
          cid: {
            type: 'string',
            format: 'cid',
          },
          validationStatus: {
            type: 'string',
            knownValues: ['valid', 'unknown'],
          },
        },
      },
      deleteResult: {
        type: 'object',
        required: [],
        properties: {},
      },
    },
  },
  ComAtprotoSpaceAuthorizeSpaceSync: {
    lexicon: 1,
    id: 'com.atproto.space.authorizeSpaceSync',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Authorize syncing a space, returning a new credential for reading data across it and the space's current revision, and optionally registering for notifications of updates to it. Depending on the space's policy, a delegation token and/or client attestation may be required. Implemented by the space host.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'credentialKey'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              credentialKey: {
                type: 'string',
                description: 'P-256 did:key that the credential is bound to.',
              },
              delegationToken: {
                type: 'string',
                description: 'Obtained from getDelegationToken.',
              },
              clientAttestation: {
                type: 'string',
              },
              notify: {
                type: 'ref',
                ref: 'lex:com.atproto.space.authorizeSpaceSync#notify',
                description:
                  "Register an endpoint to be notified of updates to the space via notifySpaceUpdate. The registration stays active while this credential is valid. After it expires, the endpoint receives only a prompt to reauthorize, or notice of the space's deletion.",
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['credential'],
            properties: {
              credential: {
                type: 'string',
              },
              spaceRev: {
                type: 'string',
                format: 'tid',
                description:
                  "The space's current revision. Omitted before the space's first update.",
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
            description:
              'May also be returned in place of AccountNotAuthorized, to avoid revealing that the space exists.',
          },
          {
            name: 'SpaceDeleted',
          },
          {
            name: 'AccountNotAuthorized',
          },
          {
            name: 'AppNotAuthorized',
          },
          {
            name: 'NotAuthorized',
            description:
              'Generic refusal. May be returned in place of AccountNotAuthorized or AppNotAuthorized.',
          },
          {
            name: 'InvalidDelegationToken',
          },
          {
            name: 'InvalidClientAttestation',
          },
          {
            name: 'RegistrationNotConfirmed',
            description:
              'The notify endpoint did not confirm the registration.',
          },
          {
            name: 'RepoTakendown',
            description: 'The space authority has been taken down.',
          },
          {
            name: 'RepoDeactivated',
            description: 'The space authority has been deactivated.',
          },
        ],
      },
      notify: {
        type: 'object',
        required: ['endpoint', 'token'],
        properties: {
          endpoint: {
            type: 'string',
            format: 'uri',
            description:
              'Base HTTPS URL that notification methods are called against.',
          },
          token: {
            type: 'string',
            maxLength: 512,
            description:
              'Opaque secret, included in the body of each request to the endpoint. The endpoint and token together identify the registration, so the token should stay the same across authorizations.',
          },
        },
      },
    },
  },
  ComAtprotoSpaceClearRecords: {
    lexicon: 1,
    id: 'com.atproto.space.clearRecords',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Delete all records in the authenticated account's space repo. In the space authority's repo, records published from the space's configuration (such as its policy) are kept. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              repo: {
                type: 'string',
                format: 'did',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {},
          },
        },
      },
    },
  },
  ComAtprotoSpaceConfirmRegistration: {
    lexicon: 1,
    id: 'com.atproto.space.confirmRegistration',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Confirm a new notification registration. Called by the space host on an endpoint passed to authorizeSpaceSync, before registering it. The syncing service checks that it issued the token for the space, and echoes back the challenge.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'token', 'challenge'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              token: {
                type: 'string',
                maxLength: 512,
              },
              challenge: {
                type: 'string',
                maxLength: 512,
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['challenge'],
            properties: {
              challenge: {
                type: 'string',
                maxLength: 512,
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoSpaceCreateRecord: {
    lexicon: 1,
    id: 'com.atproto.space.createRecord',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Create a single new record in a space repo. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'collection', 'record'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              repo: {
                type: 'string',
                format: 'did',
              },
              collection: {
                type: 'string',
                format: 'nsid',
              },
              rkey: {
                type: 'string',
                format: 'record-key',
              },
              validate: {
                type: 'boolean',
                description:
                  "Can be set to 'false' to skip Lexicon schema validation of record data, 'true' to require it, or leave unset to validate only for known Lexicons.",
              },
              record: {
                type: 'unknown',
                description: 'The record itself. Must contain a $type field.',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['uri', 'cid'],
            properties: {
              uri: {
                type: 'string',
                format: 'at-uri',
              },
              cid: {
                type: 'string',
                format: 'cid',
              },
              validationStatus: {
                type: 'string',
                knownValues: ['valid', 'unknown'],
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RecordAlreadyExists',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceCreateSpace: {
    lexicon: 1,
    id: 'com.atproto.space.createSpace',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Create a new space, with the authenticated account as its authority. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['spaceType', 'policy'],
            properties: {
              spaceType: {
                type: 'string',
                format: 'nsid',
              },
              skey: {
                type: 'string',
                format: 'record-key',
                description: 'Space key. Generated as a TID if not provided.',
              },
              policy: {
                type: 'union',
                description:
                  'PDSes must support all of the listed policies. Other space hosts may support only some of them, and any host may support policies beyond those listed.',
                refs: [
                  'lex:com.atproto.personalspace.policy',
                  'lex:com.atproto.memberspace.policy',
                  'lex:com.atproto.managedspace.policy',
                ],
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceAlreadyExists',
          },
          {
            name: 'UnsupportedPolicy',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceDefs: {
    lexicon: 1,
    id: 'com.atproto.space.defs',
    defs: {
      commit: {
        type: 'object',
        description:
          'Commit to the current state of a space repo. Not signed; authenticated by the repo host with a MAC instead.',
        required: ['ver', 'repo', 'space', 'rev', 'data'],
        properties: {
          ver: {
            type: 'integer',
            description: 'Commit format version, currently 1.',
          },
          repo: {
            type: 'string',
            format: 'did',
          },
          space: {
            type: 'string',
            format: 'space-ref',
          },
          rev: {
            type: 'string',
            format: 'tid',
          },
          data: {
            type: 'bytes',
            description: "SHA-256 digest of the repo's LtHash state.",
          },
        },
      },
      repoWrite: {
        type: 'object',
        description: 'A repo in the space advanced to a new revision.',
        required: ['repo', 'repoRev', 'data', 'spaceRev'],
        properties: {
          repo: {
            type: 'string',
            format: 'did',
          },
          repoRev: {
            type: 'string',
            format: 'tid',
          },
          data: {
            type: 'bytes',
          },
          spaceRev: {
            type: 'string',
            format: 'tid',
            description:
              'The space revision at which this update was sequenced.',
          },
          prevSpaceRev: {
            type: 'string',
            format: 'tid',
            description:
              'The space revision before this update, if any. Set in notifySpaceUpdate, where a gap indicates missed notifications, which can be recovered with listWriters.',
          },
        },
      },
      repoRemoved: {
        type: 'object',
        description: 'A repo was removed from the writer set.',
        required: ['repo', 'spaceRev'],
        properties: {
          repo: {
            type: 'string',
            format: 'did',
          },
          spaceRev: {
            type: 'string',
            format: 'tid',
            description:
              'The space revision at which this update was sequenced.',
          },
          prevSpaceRev: {
            type: 'string',
            format: 'tid',
            description:
              'The space revision before this update, if any. Set in notifySpaceUpdate, where a gap indicates missed notifications, which can be recovered with listWriters.',
          },
        },
      },
    },
  },
  ComAtprotoSpaceDeleteRecord: {
    lexicon: 1,
    id: 'com.atproto.space.deleteRecord',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Delete a record from a space repo, or ensure it doesn't exist. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'collection', 'rkey'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              repo: {
                type: 'string',
                format: 'did',
              },
              collection: {
                type: 'string',
                format: 'nsid',
              },
              rkey: {
                type: 'string',
                format: 'record-key',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {},
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceDeleteSpace: {
    lexicon: 1,
    id: 'com.atproto.space.deleteSpace',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Delete a space, along with the authority's space repo. Requires auth as the space authority, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceExportSpaceMeta: {
    lexicon: 1,
    id: 'com.atproto.space.exportSpaceMeta',
    defs: {
      main: {
        type: 'query',
        description:
          "Export a space's state, such as its policy and member list, as a STAR file for account migration. Requires auth as the space authority, implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
          },
        },
        output: {
          encoding: 'application/vnd.dasl.star',
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceGetBlob: {
    lexicon: 1,
    id: 'com.atproto.space.getBlob',
    defs: {
      main: {
        type: 'query',
        description:
          "Get a blob referenced by a record in a space repo. Returns the full blob as originally uploaded. Requires auth as the repo's account or with a space credential; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space', 'repo', 'cid'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
            cid: {
              type: 'string',
              format: 'cid',
            },
          },
        },
        output: {
          encoding: '*/*',
        },
        errors: [
          {
            name: 'BlobNotFound',
          },
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoNotFound',
          },
          {
            name: 'RepoTakendown',
          },
          {
            name: 'RepoSuspended',
          },
          {
            name: 'RepoDeactivated',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceGetDelegationToken: {
    lexicon: 1,
    id: 'com.atproto.space.getDelegationToken',
    defs: {
      main: {
        type: 'query',
        description:
          'Get a delegation token for a space, to exchange with the space host for a space credential. Requires auth, implemented by PDS.',
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['token'],
            properties: {
              token: {
                type: 'string',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoSpaceGetLatestCommit: {
    lexicon: 1,
    id: 'com.atproto.space.getLatestCommit',
    defs: {
      main: {
        type: 'query',
        description:
          "Get the current commit of a space repo. Responses are authenticated with a MAC. Requires auth as the repo's account or with a space credential; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {
              commit: {
                type: 'ref',
                ref: 'lex:com.atproto.space.defs#commit',
              },
            },
            required: ['commit'],
          },
        },
        errors: [
          {
            name: 'InvalidSpaceMac',
            description:
              'The MAC requested in the Accept-Signature header is missing or invalid.',
          },
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoNotFound',
          },
          {
            name: 'RepoTakendown',
          },
          {
            name: 'RepoSuspended',
          },
          {
            name: 'RepoDeactivated',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceGetRecord: {
    lexicon: 1,
    id: 'com.atproto.space.getRecord',
    defs: {
      main: {
        type: 'query',
        description:
          "Get a single record from a space repo. Responses are authenticated with a MAC. Requires auth as the repo's account or with a space credential; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space', 'repo', 'collection', 'rkey'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
            collection: {
              type: 'string',
              format: 'nsid',
            },
            rkey: {
              type: 'string',
              format: 'record-key',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['uri', 'cid', 'value'],
            properties: {
              uri: {
                type: 'string',
                format: 'at-uri',
              },
              cid: {
                type: 'string',
                format: 'cid',
              },
              value: {
                type: 'unknown',
              },
            },
          },
        },
        errors: [
          {
            name: 'InvalidSpaceMac',
            description:
              'The MAC requested in the Accept-Signature header is missing or invalid.',
          },
          {
            name: 'RecordNotFound',
          },
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoNotFound',
          },
          {
            name: 'RepoTakendown',
          },
          {
            name: 'RepoSuspended',
          },
          {
            name: 'RepoDeactivated',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceGetRepo: {
    lexicon: 1,
    id: 'com.atproto.space.getRepo',
    defs: {
      main: {
        type: 'query',
        description:
          "Download a space repo as a STAR file. Responses are authenticated with a MAC. Requires auth as the repo's account or with a space credential; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
          },
        },
        output: {
          encoding: 'application/vnd.dasl.star',
        },
        errors: [
          {
            name: 'InvalidSpaceMac',
            description:
              'The MAC requested in the Accept-Signature header is missing or invalid.',
          },
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoNotFound',
          },
          {
            name: 'RepoTakendown',
          },
          {
            name: 'RepoSuspended',
          },
          {
            name: 'RepoDeactivated',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceGetSpace: {
    lexicon: 1,
    id: 'com.atproto.space.getSpace',
    defs: {
      main: {
        type: 'query',
        description:
          'Get a space and its policy. Requires auth as the space authority, implemented by PDS.',
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'policy'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              policy: {
                type: 'union',
                description:
                  'PDSes must support all of the listed policies. Other space hosts may support only some of them, and any host may support policies beyond those listed.',
                refs: [
                  'lex:com.atproto.personalspace.policy',
                  'lex:com.atproto.memberspace.policy',
                  'lex:com.atproto.managedspace.policy',
                ],
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceImportRepo: {
    lexicon: 1,
    id: 'com.atproto.space.importRepo',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Import the authenticated account's space repo from a STAR file, for account migration. If the account is the space's authority, the space must first be imported with importSpaceMeta. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/vnd.dasl.star',
        },
        errors: [
          {
            name: 'SpaceNotFound',
            description:
              "The account is the space's authority, and the space has not been imported yet.",
          },
          {
            name: 'InvalidRepoFile',
            description: 'The STAR file is malformed or fails verification.',
          },
          {
            name: 'RepoMismatch',
            description:
              'The repo in the STAR file does not belong to the authenticated account.',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceImportSpaceMeta: {
    lexicon: 1,
    id: 'com.atproto.space.importSpaceMeta',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Import a space's state from an archive produced by exportSpaceMeta, for account migration. Must be called before importing the authority's space repo with importRepo. Requires auth as the space authority, implemented by PDS.",
        input: {
          encoding: 'application/vnd.dasl.star',
        },
        errors: [
          {
            name: 'NotAuthorized',
          },
          {
            name: 'UnsupportedPolicy',
          },
          {
            name: 'InvalidSpaceMeta',
            description: 'The STAR file is malformed or fails verification.',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceListBlobs: {
    lexicon: 1,
    id: 'com.atproto.space.listBlobs',
    defs: {
      main: {
        type: 'query',
        description:
          "List blob CIDs referenced by records in a space repo. Requires auth as the repo's account or with a space credential; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 500,
            },
            cursor: {
              type: 'string',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['cids'],
            properties: {
              cursor: {
                type: 'string',
              },
              cids: {
                type: 'array',
                items: {
                  type: 'string',
                  format: 'cid',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoNotFound',
          },
          {
            name: 'RepoTakendown',
          },
          {
            name: 'RepoSuspended',
          },
          {
            name: 'RepoDeactivated',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceListRecords: {
    lexicon: 1,
    id: 'com.atproto.space.listRecords',
    defs: {
      main: {
        type: 'query',
        description:
          "List records in a space repo, optionally filtered by collection. Requires auth as the repo's account or with a space credential; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
            collection: {
              type: 'string',
              format: 'nsid',
              description: 'If omitted, lists records across all collections.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 50,
            },
            cursor: {
              type: 'string',
            },
            excludeValues: {
              type: 'boolean',
              default: false,
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['records'],
            properties: {
              cursor: {
                type: 'string',
              },
              records: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:com.atproto.space.listRecords#record',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoNotFound',
          },
          {
            name: 'RepoTakendown',
          },
          {
            name: 'RepoSuspended',
          },
          {
            name: 'RepoDeactivated',
          },
          {
            name: 'InvalidCursor',
          },
        ],
      },
      record: {
        type: 'object',
        required: ['collection', 'rkey', 'cid'],
        properties: {
          collection: {
            type: 'string',
            format: 'nsid',
          },
          rkey: {
            type: 'string',
            format: 'record-key',
          },
          cid: {
            type: 'string',
            format: 'cid',
          },
          value: {
            type: 'unknown',
          },
        },
      },
    },
  },
  ComAtprotoSpaceListRepoOps: {
    lexicon: 1,
    id: 'com.atproto.space.listRepoOps',
    defs: {
      main: {
        type: 'query',
        description:
          "List operations on a space repo after a given revision. Used for incremental sync. Hosts may truncate the log, so use getRepo for a full sync. Responses are authenticated with a MAC. Requires auth as the repo's account or with a space credential; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            repo: {
              type: 'string',
              format: 'did',
            },
            since: {
              type: 'string',
              format: 'tid',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 100,
            },
            cursor: {
              type: 'string',
            },
            excludeValues: {
              type: 'boolean',
              default: false,
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['ops', 'commit'],
            properties: {
              ops: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:com.atproto.space.listRepoOps#opEntry',
                },
              },
              commit: {
                type: 'ref',
                ref: 'lex:com.atproto.space.defs#commit',
                description:
                  "The repo's current commit. A syncer compares it against its own set hash once it has applied the last page, which has no cursor.",
              },
              cursor: {
                type: 'string',
              },
            },
          },
        },
        errors: [
          {
            name: 'InvalidSpaceMac',
            description:
              'The MAC requested in the Accept-Signature header is missing or invalid.',
          },
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoNotFound',
          },
          {
            name: 'RepoTakendown',
          },
          {
            name: 'RepoSuspended',
          },
          {
            name: 'RepoDeactivated',
          },
          {
            name: 'InvalidCursor',
          },
        ],
      },
      opEntry: {
        type: 'object',
        description:
          'Operations that share a rev were applied in the same commit.',
        required: ['rev', 'collection', 'rkey', 'cid', 'prev'],
        nullable: ['cid', 'prev'],
        properties: {
          rev: {
            type: 'string',
            format: 'tid',
          },
          collection: {
            type: 'string',
            format: 'nsid',
          },
          rkey: {
            type: 'string',
            format: 'record-key',
          },
          cid: {
            type: 'string',
            format: 'cid',
            description:
              'CID of the record after the operation. Null for deletes.',
          },
          prev: {
            type: 'string',
            format: 'cid',
            description:
              'CID of the record before the operation. Null for creates.',
          },
          value: {
            type: 'unknown',
            description:
              'Omitted for deletes, if excludeValues is set, or if the record has since changed.',
          },
        },
      },
    },
  },
  ComAtprotoSpaceListSpaces: {
    lexicon: 1,
    id: 'com.atproto.space.listSpaces',
    defs: {
      main: {
        type: 'query',
        description:
          'List spaces that the authenticated account has written to or is the authority for. Requires auth, implemented by PDS.',
        parameters: {
          type: 'params',
          properties: {
            spaceDid: {
              type: 'string',
              format: 'did',
              description: 'Filter to spaces with this DID as their authority.',
            },
            spaceType: {
              type: 'string',
              format: 'nsid',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 50,
            },
            cursor: {
              type: 'string',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['spaces'],
            properties: {
              cursor: {
                type: 'string',
              },
              spaces: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:com.atproto.space.listSpaces#spaceView',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'InvalidCursor',
          },
        ],
      },
      spaceView: {
        type: 'object',
        required: ['space'],
        properties: {
          space: {
            type: 'string',
            format: 'space-ref',
          },
          repoRev: {
            type: 'string',
            format: 'tid',
            description:
              "The current revision of the account's repo in the space, if it has one.",
          },
          data: {
            type: 'bytes',
            description:
              "The current commit data of the account's repo in the space, if it has one.",
          },
          spaceRev: {
            type: 'string',
            format: 'tid',
            description:
              "The current revision of the space. Only included if the account is the space's authority.",
          },
        },
      },
    },
  },
  ComAtprotoSpaceListWriters: {
    lexicon: 1,
    id: 'com.atproto.space.listWriters',
    defs: {
      main: {
        type: 'query',
        description:
          "List the repos in a space's writer set, with the latest known state of each: its current revision, or its removal from the writer set. Requires a space credential, implemented by the space host.",
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 100,
            },
            cursor: {
              type: 'string',
              description:
                'Return repos updated after this space revision. Removed repos may be garbage collected after 72 hrs, so a syncer whose last seen space revision is older should list the whole writer set instead.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repos'],
            properties: {
              repos: {
                type: 'array',
                items: {
                  type: 'union',
                  refs: [
                    'lex:com.atproto.space.defs#repoWrite',
                    'lex:com.atproto.space.defs#repoRemoved',
                  ],
                },
                description:
                  'The latest update to each repo, ordered by spaceRev, ascending. prevSpaceRev is not set.',
              },
              cursor: {
                type: 'string',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'RepoTakendown',
            description: 'The space authority has been taken down.',
          },
          {
            name: 'RepoDeactivated',
            description: 'The space authority has been deactivated.',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceNotifyCredentialsRevoked: {
    lexicon: 1,
    id: 'com.atproto.space.notifyCredentialsRevoked',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Notify a repo host that space credentials have been revoked. Sent by the space host. Requires service auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'credentials'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              credentials: {
                type: 'array',
                minLength: 1,
                maxLength: 100,
                description: 'The IDs (jti) of the revoked credentials.',
                items: {
                  type: 'string',
                  minLength: 1,
                },
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoSpaceNotifyRepoUpdate: {
    lexicon: 1,
    id: 'com.atproto.space.notifyRepoUpdate',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Notify the space host that a space repo has been updated. Sent by repo hosts, with service auth.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'repoRev', 'data'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              repo: {
                type: 'string',
                format: 'did',
              },
              repoRev: {
                type: 'string',
                format: 'tid',
              },
              data: {
                type: 'bytes',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'FutureRev',
            description: 'The repo revision is too far in the future.',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceNotifySpaceUpdate: {
    lexicon: 1,
    id: 'com.atproto.space.notifySpaceUpdate',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Notify a syncing service of an update to a space. Sent by the space host to the notification endpoint registered through authorizeSpaceSync.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'token', 'update'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              token: {
                type: 'string',
                maxLength: 512,
                description: 'The token the endpoint was registered with.',
              },
              update: {
                type: 'union',
                refs: [
                  'lex:com.atproto.space.defs#repoWrite',
                  'lex:com.atproto.space.defs#repoRemoved',
                  'lex:com.atproto.space.notifySpaceUpdate#spaceDeleted',
                  'lex:com.atproto.space.notifySpaceUpdate#registrationExpired',
                ],
              },
            },
          },
        },
      },
      spaceDeleted: {
        type: 'object',
        description:
          'The space has been deleted. Confirm with authorizeSpaceSync before dropping its data.',
        properties: {},
      },
      registrationExpired: {
        type: 'object',
        description:
          "The endpoint's registration has expired. Sent in place of the first update after expiry. Call authorizeSpaceSync to keep receiving notifications.",
        required: ['spaceRev'],
        properties: {
          spaceRev: {
            type: 'string',
            format: 'tid',
          },
        },
      },
    },
  },
  ComAtprotoSpacePutRecord: {
    lexicon: 1,
    id: 'com.atproto.space.putRecord',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Write a record in a space repo, creating or updating it as needed. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'collection', 'rkey', 'record'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              repo: {
                type: 'string',
                format: 'did',
              },
              collection: {
                type: 'string',
                format: 'nsid',
              },
              rkey: {
                type: 'string',
                format: 'record-key',
              },
              validate: {
                type: 'boolean',
                description:
                  "Can be set to 'false' to skip Lexicon schema validation of record data, 'true' to require it, or leave unset to validate only for known Lexicons.",
              },
              record: {
                type: 'unknown',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['uri', 'cid'],
            properties: {
              uri: {
                type: 'string',
                format: 'at-uri',
              },
              cid: {
                type: 'string',
                format: 'cid',
              },
              validationStatus: {
                type: 'string',
                knownValues: ['valid', 'unknown'],
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceRemoveWriter: {
    lexicon: 1,
    id: 'com.atproto.space.removeWriter',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Remove an account from a space's writer set, as returned by listWriters. The removal is sent to registered syncers. The account is added back if it makes another authorized write to the space. Does nothing if the account is not in the writer set. Requires auth as the space authority, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              repo: {
                type: 'string',
                format: 'did',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceUpdateSpace: {
    lexicon: 1,
    id: 'com.atproto.space.updateSpace',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Replace the policy of a space. Changing to a different policy type discards state held by the previous policy, such as a member list. Requires auth as the space authority, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'policy'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              policy: {
                type: 'union',
                description:
                  'PDSes must support all of the listed policies. Other space hosts may support only some of them, and any host may support policies beyond those listed.',
                refs: [
                  'lex:com.atproto.personalspace.policy',
                  'lex:com.atproto.memberspace.policy',
                  'lex:com.atproto.managedspace.policy',
                ],
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotAuthorized',
          },
          {
            name: 'UnsupportedPolicy',
          },
        ],
      },
    },
  },
  NewFlockOperatorCreateWorkspace: {
    lexicon: 1,
    id: 'new.flock.operator.createWorkspace',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Creates a workspace under a workspace account (its authority: the caller's own, or the account named by authority) with the grant its authority flow left, for the caller: the workspace, inbox and general channel spaces, the profile, the caller in their member lists, the caller's roster and admin records and the directory entry, as one journaled operation that a retry with the same operation id resumes. A caller other than the workspace account needs that account's approval of this workspace (a createWorkspace authority flow they started), which this operation uses up; without a grant or that approval it answers AuthorizationRequired.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['name', 'operationId'],
            properties: {
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 60,
              },
              operationId: {
                type: 'string',
                format: 'tid',
              },
              authority: {
                type: 'string',
                format: 'did',
                description:
                  "The workspace account: its DID is in every URI of the workspace. Omitted, the caller's own.",
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: [
              'operationId',
              'workspace',
              'channel',
              'state',
              'completedSteps',
            ],
            properties: {
              operationId: {
                type: 'string',
                format: 'tid',
              },
              workspace: {
                type: 'string',
                format: 'space-ref',
              },
              channel: {
                type: 'string',
                format: 'space-ref',
                description: "The workspace's general channel.",
              },
              state: {
                type: 'string',
                knownValues: [
                  'queued',
                  'running',
                  'pending',
                  'completed',
                  'failed',
                  'paused',
                ],
              },
              completedSteps: {
                type: 'array',
                items: {
                  type: 'string',
                  maxLength: 128,
                },
              },
              error: {
                type: 'string',
                maxLength: 1000,
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
          {
            name: 'AuthorizationRequired',
            description:
              'The operator holds no usable grant for the caller as an authority: start the authority flow with purpose reauthorize, then retry with the same operation id.',
          },
          {
            name: 'OperationIdConflict',
          },
          {
            name: 'WorkspaceExists',
            description:
              'A workspace of this name exists under the workspace account, or someone else is creating it there: it is joined through its admins, or its creator, not created again.',
          },
          {
            name: 'Paused',
            description:
              'Workspace admin mutations are paused by the operator.',
          },
          {
            name: 'Busy',
            description:
              "Another operation holds this authority's workspaces; retry with the same operation id.",
          },
        ],
      },
    },
  },
  NewFlockOperatorExecute: {
    lexicon: 1,
    id: 'new.flock.operator.execute',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Submit an idempotent workspace administration operation. Caller identity is derived from the verified service-auth issuer.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['workspace', 'operationId', 'request'],
            properties: {
              workspace: {
                type: 'string',
                format: 'space-ref',
              },
              operationId: {
                type: 'string',
                format: 'tid',
              },
              request: {
                type: 'ref',
                ref: 'lex:new.flock.operator.execute#operationRequest',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['operation'],
            properties: {
              operation: {
                type: 'ref',
                ref: 'lex:new.flock.operator.execute#operation',
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
          {
            name: 'Conflict',
          },
          {
            name: 'Paused',
          },
        ],
      },
      operationRequest: {
        type: 'object',
        description:
          'The server validates the required fields for each kind and rejects extra or missing fields.',
        required: ['kind'],
        properties: {
          kind: {
            type: 'string',
            knownValues: [
              'inviteMember',
              'removeMember',
              'setAdmin',
              'createChannel',
              'transitionChannel',
              'archiveChannel',
              'decideJoinRequest',
              'leaveWorkspace',
              'leaveChannel',
              'reconcileWorkspace',
              'installApp',
              'updateAppAccess',
              'uninstallApp',
              'enableExtension',
              'disableExtension',
            ],
          },
          subject: {
            type: 'string',
            format: 'did',
          },
          active: {
            type: 'boolean',
          },
          skey: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          extId: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 320,
            maxGraphemes: 80,
          },
          visibility: {
            type: 'string',
            knownValues: ['public', 'private'],
          },
          members: {
            type: 'array',
            items: {
              type: 'string',
              format: 'did',
            },
            maxLength: 200,
          },
          channels: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:new.flock.operator.execute#channelGrant',
            },
            maxLength: 100,
          },
          request: {
            type: 'string',
            format: 'at-uri',
          },
          requestId: {
            type: 'string',
            format: 'tid',
          },
          decision: {
            type: 'string',
            knownValues: ['approve', 'deny'],
          },
        },
      },
      channelGrant: {
        type: 'object',
        description:
          'A channel an app is granted by installApp or updateAppAccess: read, and write when `write` is true.',
        required: ['skey', 'write'],
        properties: {
          skey: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          write: {
            type: 'boolean',
          },
        },
      },
      operation: {
        type: 'object',
        required: [
          'operationId',
          'requestHash',
          'state',
          'completedSteps',
          'updatedAt',
        ],
        properties: {
          operationId: {
            type: 'string',
            format: 'tid',
          },
          requestHash: {
            type: 'string',
            minLength: 64,
            maxLength: 64,
            description:
              'Lowercase hexadecimal SHA-256 of canonical request JSON.',
          },
          state: {
            type: 'string',
            knownValues: [
              'queued',
              'running',
              'pending',
              'completed',
              'failed',
              'paused',
            ],
          },
          completedSteps: {
            type: 'array',
            items: {
              type: 'string',
              maxLength: 2560,
              description:
                "A step the operation finished. A step about one member names its space key and the member's DID, so the bound allows the longest DID AT Protocol permits.",
            },
          },
          error: {
            type: 'string',
            maxLength: 1000,
          },
          updatedAt: {
            type: 'string',
            format: 'datetime',
          },
        },
      },
    },
  },
  NewFlockOperatorGetChanges: {
    lexicon: 1,
    id: 'new.flock.operator.getChanges',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Waits up to about 25 seconds for any followed space to change, then says which did. It names no writer, revision or content: a client that sees a space change asks that space's authority for listWriters, where its access is checked. Each space has its own cursor. A space the caller may not follow comes back in denied and its cursor does not move; a space whose cursor is older than the notices the operator keeps comes back in reset and should be synced. A call that follows nothing returns head at once: a client reads head, syncs a space, then follows it from head. A procedure, not a query, because 200 space references do not fit in a request line.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['follow'],
            properties: {
              follow: {
                type: 'array',
                maxLength: 200,
                items: {
                  type: 'ref',
                  ref: 'lex:new.flock.operator.getChanges#follow',
                },
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['head', 'changed', 'denied', 'reset'],
            properties: {
              head: {
                type: 'string',
                maxLength: 16,
                description:
                  "The operator's newest notice cursor, to follow a space from once it is synced.",
              },
              changed: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:new.flock.operator.getChanges#change',
                },
              },
              denied: {
                type: 'array',
                items: {
                  type: 'string',
                  format: 'space-ref',
                },
              },
              reset: {
                type: 'array',
                items: {
                  type: 'string',
                  format: 'space-ref',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
        ],
      },
      follow: {
        type: 'object',
        required: ['space', 'after'],
        properties: {
          space: {
            type: 'string',
            format: 'space-ref',
          },
          after: {
            type: 'string',
            maxLength: 16,
            description:
              'The cursor this space was last synced or answered at.',
          },
        },
      },
      change: {
        type: 'object',
        required: ['space', 'cursor'],
        properties: {
          space: {
            type: 'string',
            format: 'space-ref',
          },
          cursor: {
            type: 'string',
            maxLength: 16,
            description:
              "This space's newest notice: follow it from here once it is synced.",
          },
        },
      },
    },
  },
  NewFlockOperatorGetDmNotifyTarget: {
    lexicon: 1,
    id: 'new.flock.operator.getDmNotifyTarget',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Issue a stateless per-caller PDS webhook notification target for a DM space after verifying the caller holds a valid space credential and key possession proof for that space.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'credential', 'proof'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
              },
              credential: {
                type: 'string',
                maxLength: 8192,
              },
              proof: {
                type: 'ref',
                ref: 'lex:new.flock.operator.getDmNotifyTarget#credentialProof',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['endpoint', 'token'],
            properties: {
              endpoint: {
                type: 'string',
                format: 'uri',
              },
              token: {
                type: 'string',
                maxLength: 512,
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
          {
            name: 'InvalidRequest',
          },
        ],
      },
      credentialProof: {
        type: 'object',
        required: ['authorization', 'signatureInput', 'signature'],
        properties: {
          authorization: {
            type: 'string',
            maxLength: 16384,
          },
          signatureInput: {
            type: 'string',
            maxLength: 2048,
          },
          signature: {
            type: 'string',
            maxLength: 2048,
          },
        },
      },
    },
  },
  NewFlockOperatorGetOperation: {
    lexicon: 1,
    id: 'new.flock.operator.getOperation',
    defs: {
      main: {
        type: 'query',
        description:
          'Read the status of a journaled operation. The operator revalidates the caller as an active workspace admin.',
        parameters: {
          type: 'params',
          required: ['workspace', 'operationId'],
          properties: {
            workspace: {
              type: 'string',
              format: 'space-ref',
            },
            operationId: {
              type: 'string',
              format: 'tid',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['operation'],
            properties: {
              operation: {
                type: 'ref',
                ref: 'lex:new.flock.operator.execute#operation',
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
          {
            name: 'NotFound',
          },
        ],
      },
    },
  },
  NewFlockOperatorListInboxWriters: {
    lexicon: 1,
    id: 'new.flock.operator.listInboxWriters',
    defs: {
      main: {
        type: 'query',
        description:
          'Return DIDs in the current inbox member list with write=true. It never returns request records or request contents.',
        parameters: {
          type: 'params',
          required: ['workspace'],
          properties: {
            workspace: {
              type: 'string',
              format: 'space-ref',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['inbox', 'writers', 'checkedAt'],
            properties: {
              inbox: {
                type: 'string',
                format: 'space-ref',
              },
              writers: {
                type: 'array',
                items: {
                  type: 'string',
                  format: 'did',
                },
                maxLength: 200,
              },
              checkedAt: {
                type: 'string',
                format: 'datetime',
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
        ],
      },
    },
  },
  NewFlockOperatorListStalledOperations: {
    lexicon: 1,
    id: 'new.flock.operator.listStalledOperations',
    defs: {
      main: {
        type: 'query',
        description:
          "The workspace's operations that have not moved for five minutes, and its spaces whose change-notice registration has failed to renew. The operator revalidates the caller as an active workspace admin.",
        parameters: {
          type: 'params',
          required: ['workspace'],
          properties: {
            workspace: {
              type: 'string',
              format: 'space-ref',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['operations', 'registrations', 'truncated'],
            properties: {
              operations: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:new.flock.operator.listStalledOperations#stalledOperation',
                },
              },
              registrations: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:new.flock.operator.listStalledOperations#failedRegistration',
                },
              },
              truncated: {
                type: 'boolean',
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
        ],
      },
      stalledOperation: {
        type: 'object',
        required: ['actor', 'operationId', 'state', 'updatedAt'],
        properties: {
          actor: {
            type: 'string',
            format: 'did',
          },
          operationId: {
            type: 'string',
            format: 'tid',
          },
          state: {
            type: 'string',
            maxLength: 32,
          },
          error: {
            type: 'string',
            maxLength: 1000,
          },
          updatedAt: {
            type: 'string',
            format: 'datetime',
          },
        },
      },
      failedRegistration: {
        type: 'object',
        description:
          'A space that gets no change ticks: its registration failed since it last succeeded, or ran out.',
        required: ['space', 'failures'],
        properties: {
          space: {
            type: 'string',
            format: 'space-ref',
          },
          failures: {
            type: 'integer',
            minimum: 0,
            description:
              'Attempts that failed since the last success; 0 for one that only ran out.',
          },
          error: {
            type: 'string',
            maxLength: 1000,
          },
          nextAttemptAt: {
            type: 'string',
            format: 'datetime',
          },
          expiredAt: {
            type: 'string',
            format: 'datetime',
            description: 'When its registration ran out, if it has.',
          },
        },
      },
    },
  },
  NewFlockOperatorStartAuthorityFlow: {
    lexicon: 1,
    id: 'new.flock.operator.startAuthorityFlow',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Issues a single-use, two-minute ticket for the caller to grant the operator authority over a workspace account's workspaces (the caller's own account, or the one named by authority), and returns the operator URL that starts the flow. The caller opens it as a top-level navigation; the flow succeeds only for someone who signs in as that account. For createWorkspace with another account, it also leaves the caller an approval to create that one workspace.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['purpose'],
            properties: {
              purpose: {
                type: 'string',
                knownValues: ['createWorkspace', 'reauthorize'],
              },
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 60,
                description:
                  'The workspace to create, for purpose createWorkspace.',
              },
              authority: {
                type: 'string',
                format: 'did',
                description:
                  "The workspace account to approve for. Omitted, the caller's own.",
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['url'],
            properties: {
              url: {
                type: 'string',
                format: 'uri',
              },
            },
          },
        },
        errors: [
          {
            name: 'Unauthorized',
          },
        ],
      },
    },
  },
} as const
export const schemas = Object.values(schemaDict) as unknown as LexiconDoc[]
export const lexicons: Lexicons = new Lexicons(schemas)

export function validate<T extends { $type: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType: true,
): ValidationResult<T>
export function validate<T extends { $type?: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: false,
): ValidationResult<T>
export function validate(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: boolean,
): ValidationResult {
  return (requiredType ? is$typed : maybe$typed)(v, id, hash)
    ? lexicons.validate(`${id}#${hash}`, v)
    : {
        success: false,
        error: new ValidationError(
          `Must be an object with "${hash === 'main' ? id : `${id}#${hash}`}" $type property`,
        ),
      }
}

export const ids = {
  ComAtprotoManagedspaceCheckAccess: 'com.atproto.managedspace.checkAccess',
  ComAtprotoManagedspacePolicy: 'com.atproto.managedspace.policy',
  ComAtprotoMemberspaceDefs: 'com.atproto.memberspace.defs',
  ComAtprotoMemberspaceListMembers: 'com.atproto.memberspace.listMembers',
  ComAtprotoMemberspacePolicy: 'com.atproto.memberspace.policy',
  ComAtprotoMemberspacePutMembers: 'com.atproto.memberspace.putMembers',
  ComAtprotoMemberspaceRemoveMembers: 'com.atproto.memberspace.removeMembers',
  ComAtprotoPersonalspacePolicy: 'com.atproto.personalspace.policy',
  ComAtprotoServerGetServiceAuth: 'com.atproto.server.getServiceAuth',
  ComAtprotoSpaceApplyWrites: 'com.atproto.space.applyWrites',
  ComAtprotoSpaceAuthorizeSpaceSync: 'com.atproto.space.authorizeSpaceSync',
  ComAtprotoSpaceClearRecords: 'com.atproto.space.clearRecords',
  ComAtprotoSpaceConfirmRegistration: 'com.atproto.space.confirmRegistration',
  ComAtprotoSpaceCreateRecord: 'com.atproto.space.createRecord',
  ComAtprotoSpaceCreateSpace: 'com.atproto.space.createSpace',
  ComAtprotoSpaceDefs: 'com.atproto.space.defs',
  ComAtprotoSpaceDeleteRecord: 'com.atproto.space.deleteRecord',
  ComAtprotoSpaceDeleteSpace: 'com.atproto.space.deleteSpace',
  ComAtprotoSpaceExportSpaceMeta: 'com.atproto.space.exportSpaceMeta',
  ComAtprotoSpaceGetBlob: 'com.atproto.space.getBlob',
  ComAtprotoSpaceGetDelegationToken: 'com.atproto.space.getDelegationToken',
  ComAtprotoSpaceGetLatestCommit: 'com.atproto.space.getLatestCommit',
  ComAtprotoSpaceGetRecord: 'com.atproto.space.getRecord',
  ComAtprotoSpaceGetRepo: 'com.atproto.space.getRepo',
  ComAtprotoSpaceGetSpace: 'com.atproto.space.getSpace',
  ComAtprotoSpaceImportRepo: 'com.atproto.space.importRepo',
  ComAtprotoSpaceImportSpaceMeta: 'com.atproto.space.importSpaceMeta',
  ComAtprotoSpaceListBlobs: 'com.atproto.space.listBlobs',
  ComAtprotoSpaceListRecords: 'com.atproto.space.listRecords',
  ComAtprotoSpaceListRepoOps: 'com.atproto.space.listRepoOps',
  ComAtprotoSpaceListSpaces: 'com.atproto.space.listSpaces',
  ComAtprotoSpaceListWriters: 'com.atproto.space.listWriters',
  ComAtprotoSpaceNotifyCredentialsRevoked:
    'com.atproto.space.notifyCredentialsRevoked',
  ComAtprotoSpaceNotifyRepoUpdate: 'com.atproto.space.notifyRepoUpdate',
  ComAtprotoSpaceNotifySpaceUpdate: 'com.atproto.space.notifySpaceUpdate',
  ComAtprotoSpacePutRecord: 'com.atproto.space.putRecord',
  ComAtprotoSpaceRemoveWriter: 'com.atproto.space.removeWriter',
  ComAtprotoSpaceUpdateSpace: 'com.atproto.space.updateSpace',
  NewFlockOperatorCreateWorkspace: 'new.flock.operator.createWorkspace',
  NewFlockOperatorExecute: 'new.flock.operator.execute',
  NewFlockOperatorGetChanges: 'new.flock.operator.getChanges',
  NewFlockOperatorGetDmNotifyTarget: 'new.flock.operator.getDmNotifyTarget',
  NewFlockOperatorGetOperation: 'new.flock.operator.getOperation',
  NewFlockOperatorListInboxWriters: 'new.flock.operator.listInboxWriters',
  NewFlockOperatorListStalledOperations:
    'new.flock.operator.listStalledOperations',
  NewFlockOperatorStartAuthorityFlow: 'new.flock.operator.startAuthorityFlow',
} as const
