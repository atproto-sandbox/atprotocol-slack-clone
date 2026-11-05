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
  ComAtprotoManagedspaceCheckUserAccess: {
    lexicon: 1,
    id: 'com.atproto.managedspace.checkUserAccess',
    defs: {
      main: {
        type: 'query',
        description:
          "Ask a space's managing app whether to authorize a user to read or write. Served by the managingApp (not the PDS), called by the authority of a space governed by the managedspace policy. Authenticated with service auth from the authority.",
        parameters: {
          type: 'params',
          required: ['space', 'user', 'access'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            user: {
              type: 'string',
              format: 'did',
              description: 'The DID of the requesting user.',
            },
            access: {
              type: 'string',
              knownValues: ['read', 'write'],
              description: 'The kind of access being checked.',
            },
            clientId: {
              type: 'string',
              description:
                'The attested client_id, if a client attestation was presented. Omitted for write checks.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['authorized'],
            properties: {
              authorized: {
                type: 'boolean',
                description: 'Whether the managing app authorizes the request.',
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
          'Space policy that defers each user access decision to an external managing app, which the authority asks via checkUserAccess.',
        required: ['managingApp'],
        properties: {
          managingApp: {
            type: 'string',
            description:
              "Service identifier of the managing app: a DID with an optional service fragment (e.g. 'did:web:example.com#forum').",
          },
          publishPolicy: {
            type: 'boolean',
            default: false,
            description:
              "Publish the policy to readers as a com.atproto.space.policy record in the authority's repo in the space.",
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
          "List the members of a space governed by the memberspace policy, and their read and write access. Must be called on the space authority's PDS. Requires OAuth with a covering read_self grant; a space credential is not sufficient, so members hosted elsewhere cannot enumerate the list. To make the list visible to readers, set the policy's publishMembers.",
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 100,
              description: 'Maximum number of members to return.',
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
                  ref: 'lex:com.atproto.memberspace.listMembers#member',
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
            name: 'PolicyMismatch',
            description: 'The space is not governed by the memberspace policy.',
          },
        ],
      },
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
  ComAtprotoMemberspacePolicy: {
    lexicon: 1,
    id: 'com.atproto.memberspace.policy',
    defs: {
      main: {
        type: 'object',
        description:
          'Space policy that governs access via a member list maintained by the space host, managed with putMember and removeMember.',
        properties: {
          publicRead: {
            type: 'boolean',
            default: false,
            description:
              'If true, the authority issues a space credential to anyone, with or without a delegation token. Otherwise, only to members whose entry has read set.',
          },
          publicWrite: {
            type: 'boolean',
            default: false,
            description:
              "If true, the authority tracks and forwards notifications for any user's writes. Otherwise, only for members whose entry has write set.",
          },
          allowedApps: {
            type: 'array',
            description:
              'If set, the authority mints a credential only for these apps, evaluated against the attested client_id. When omitted, any app may read the space and no client attestation is required. Does not apply to writes.',
            items: {
              type: 'string',
              description: 'An OAuth client ID.',
            },
          },
          publishPolicy: {
            type: 'boolean',
            default: false,
            description:
              "Publish the policy to readers as a com.atproto.space.policy record in the authority's repo in the space.",
          },
          publishMembers: {
            type: 'boolean',
            default: false,
            description:
              "Publish the member list to readers as com.atproto.memberspace.member records in the authority's repo in the space.",
          },
        },
      },
    },
  },
  ComAtprotoMemberspacePutMember: {
    lexicon: 1,
    id: 'com.atproto.memberspace.putMember',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Add a member to the member list of a space governed by the memberspace policy, or replace their read and write access. Requires auth as the space owner.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'did', 'read', 'write'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              did: {
                type: 'string',
                format: 'did',
                description: 'The DID of the member.',
              },
              read: {
                type: 'boolean',
                description:
                  "Whether the member may read when the policy's publicRead is not set.",
              },
              write: {
                type: 'boolean',
                description:
                  "Whether the member's writes are tracked when the policy's publicWrite is not set.",
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotSpaceOwner',
          },
          {
            name: 'PolicyMismatch',
            description: 'The space is not governed by the memberspace policy.',
          },
        ],
      },
    },
  },
  ComAtprotoMemberspaceRemoveMember: {
    lexicon: 1,
    id: 'com.atproto.memberspace.removeMember',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Remove a member from the member list of a space governed by the memberspace policy. Requires auth as the space owner.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'did'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              did: {
                type: 'string',
                format: 'did',
                description: 'The DID of the member to remove.',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotSpaceOwner',
          },
          {
            name: 'PolicyMismatch',
            description: 'The space is not governed by the memberspace policy.',
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
          "Space policy for data that only its owner should see, such as bookmarks, mutes, or drafts. Only the space authority's own account is authorized to read, and the authority tracks no other writers. Has no configuration fields.",
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
          'Apply a batch transaction of creates, updates, and deletes in a permissioned space. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'writes'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              repo: {
                type: 'string',
                format: 'did',
                description:
                  'The DID of the repo to write to (the authenticated member).',
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
            description:
              'An update or delete targeted a record that does not exist.',
          },
          {
            name: 'RecordAlreadyExists',
            description:
              'A create targeted a collection and rkey that already holds a record.',
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
            maxLength: 512,
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
  ComAtprotoSpaceClearRecords: {
    lexicon: 1,
    id: 'com.atproto.space.clearRecords',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Delete every record in the authenticated account's space repo. The repo advances to a new revision with the empty repo's digest, and its oplog is cleared. In the space authority's own repo, the records the host publishes from the space's configuration (com.atproto.space.policy and com.atproto.memberspace.member) are kept, and the digest is that of the records that remain. Succeeds whether or not the repo held any records to delete. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              repo: {
                type: 'string',
                format: 'did',
                description:
                  'The DID of the repo to clear (the authenticated member).',
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
  ComAtprotoSpaceCreateRecord: {
    lexicon: 1,
    id: 'com.atproto.space.createRecord',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Create a single new record in a permissioned space. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'collection', 'record'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              repo: {
                type: 'string',
                format: 'did',
                description:
                  'The DID of the repo to write to (the authenticated member).',
              },
              collection: {
                type: 'string',
                format: 'nsid',
                description: 'The NSID of the record collection.',
              },
              rkey: {
                type: 'string',
                format: 'record-key',
                description: 'The Record Key.',
                maxLength: 512,
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
                description: 'URI of the created record.',
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
            description:
              'A record already exists at this collection and rkey. Retry with a different rkey, or use putRecord.',
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
          "Create a new space governed by the given policy. The space is anchored on the authenticated user's DID, who becomes the space owner. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['spaceType', 'policy'],
            properties: {
              spaceType: {
                type: 'string',
                format: 'nsid',
                description:
                  'The NSID of the space type, describing the modality of the space (e.g. app.bsky.group, app.bsky.personal).',
              },
              skey: {
                type: 'string',
                format: 'record-key',
                description:
                  'The space key. Used to differentiate multiple spaces of the same type under the same owner. Same syntax requirements as a record key. If not provided, one will be auto-generated (TID).',
              },
              policy: {
                type: 'union',
                description:
                  'The policy governing the space, including its configuration.',
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
            required: ['uri'],
            properties: {
              uri: {
                type: 'string',
                format: 'space-ref',
                description: 'URI of the created space.',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceAlreadyExists',
            description:
              'A space with this owner, type, and skey already exists. A space that was previously deleted may be created again.',
          },
          {
            name: 'UnsupportedPolicy',
            description: 'The requested policy is not one the host implements.',
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
          'A commit over the current state of a permissioned repo. Carries no signature: the repo host authenticates it to a syncer with a MAC in the Atproto-Space-Mac response header.',
        required: ['ver', 'repo', 'space', 'rev', 'data'],
        properties: {
          ver: {
            type: 'integer',
            description: 'Commit format version, currently 1.',
          },
          repo: {
            type: 'string',
            format: 'did',
            description: 'The author DID of the repo.',
          },
          space: {
            type: 'string',
            format: 'space-ref',
            description: 'Reference to the space.',
          },
          rev: {
            type: 'string',
            format: 'tid',
            description: 'Commit revision (TID).',
          },
          data: {
            type: 'bytes',
            description: 'sha256 digest of the LtHash state (32 bytes).',
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
          "Delete a record from a permissioned space, or ensure it doesn't exist. Succeeds whether or not the record was present. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'collection', 'rkey'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              repo: {
                type: 'string',
                format: 'did',
                description:
                  'The DID of the repo to delete from (the authenticated member).',
              },
              collection: {
                type: 'string',
                format: 'nsid',
                description: 'The NSID of the record collection.',
              },
              rkey: {
                type: 'string',
                format: 'record-key',
                description: 'The Record Key.',
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
          "Delete a space. Requires auth as the space owner. Deletes the owner's own repo in the space; other members' repos are left in place. Afterwards, reads and writes fail with SpaceNotFound and getSpaceCredential returns SpaceDeleted. Idempotent. Implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space to delete.',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotSpaceOwner',
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
          "Download a space's host-side state as a space meta archive, for account migration: a STAR file with the atproto-space-meta profile. The archive's metadata is the space. Its body is the space's policy, then any state the policy keeps (such as a memberspace member list), then the writer set. Served by the space host. Requires OAuth as the space owner with a covering read_self grant.",
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
          },
        },
        output: {
          encoding: 'application/octet-stream',
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotSpaceOwner',
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
          "Get a blob referenced from a record in a permissioned space. Returns the full blob as originally uploaded. Blobs are not uploaded through this namespace: a space record references a blob uploaded via com.atproto.repo.uploadBlob, so a client writing blob-bearing records into a space needs a blob permission alongside its space permission. Use listBlobs to enumerate a repo's blobs in a space. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services).",
        parameters: {
          type: 'params',
          required: ['space', 'repo', 'cid'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            repo: {
              type: 'string',
              format: 'did',
              description: 'The DID of the account whose repo holds the blob.',
            },
            cid: {
              type: 'string',
              format: 'cid',
              description: 'The CID of the blob to fetch.',
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
          "Mint a delegation token for a space, proving the requesting app is acting on the user's behalf. Exchanged with the space authority for a space credential. Served by the requesting user's PDS. Requires OAuth auth.",
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
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
                description: 'A signed JWT delegation token.',
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
          "Get the current commit for an account's permissioned repo within a space. Served by a repo host. When called with a space credential, the caller must send an Atproto-Space-Want-Mac header, and the commit's MAC is returned in the Atproto-Space-Mac response header. Throws RepoNotFound when the account holds no repo in the space, including the case of a member that has never written to it. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services).",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            repo: {
              type: 'string',
              format: 'did',
              description:
                'The DID of the account whose latest commit to retrieve.',
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
                description: "The account's current commit.",
              },
            },
            required: ['commit'],
          },
        },
        errors: [
          {
            name: 'BadSpaceMac',
            description:
              'The Atproto-Space-Want-Mac header is missing or malformed, names an unsupported type or version, or carries an invalid key share.',
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
          "Get a single record from a permissioned space. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services). When called with a space credential, the caller must send an Atproto-Space-Want-Mac header, and the record's MAC is returned in the Atproto-Space-Mac response header. Throws RepoNotFound when the account holds no repo in the space; this does not distinguish a member that has never written from a non-member.",
        parameters: {
          type: 'params',
          required: ['space', 'repo', 'collection', 'rkey'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            repo: {
              type: 'string',
              format: 'did',
              description: 'The DID of the account whose repo to read from.',
            },
            collection: {
              type: 'string',
              format: 'nsid',
              description: 'The NSID of the record collection.',
            },
            rkey: {
              type: 'string',
              format: 'record-key',
              description: 'The Record Key.',
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
            name: 'BadSpaceMac',
            description:
              'The Atproto-Space-Want-Mac header is missing or malformed, names an unsupported type or version, or carries an invalid key share.',
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
          "Download an account's permissioned repo within a space as a STAR file, for full-state recovery. The archive's metadata is the repo's commit; each key/value pair is a record path ('{collection}/{rkey}') and the record's DRISL encoding, in strict lexicographic order of the path. Blobs are not included and are fetched separately via getBlob. Served by a repo host. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services). When called with a space credential, the caller must send an Atproto-Space-Want-Mac header, and the commit's MAC is returned in the Atproto-Space-Mac response header.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            repo: {
              type: 'string',
              format: 'did',
              description: 'The DID of the account whose repo to download.',
            },
          },
        },
        output: {
          encoding: 'application/octet-stream',
        },
        errors: [
          {
            name: 'BadSpaceMac',
            description:
              'The Atproto-Space-Want-Mac header is missing or malformed, names an unsupported type or version, or carries an invalid key share.',
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
          'Describe a space, including the policy that governs it. Served by the space host for every space it hosts, regardless of policy. Requires OAuth as the space owner with a covering read_self grant. A policy may optionally be published in the space, as a com.atproto.space.policy record, so that syncers can view it.',
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['uri', 'policy'],
            properties: {
              uri: {
                type: 'string',
                format: 'space-ref',
                description: 'URI of the space.',
              },
              policy: {
                type: 'union',
                description:
                  'The policy governing the space, including its configuration.',
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
        ],
      },
    },
  },
  ComAtprotoSpaceGetSpaceCredential: {
    lexicon: 1,
    id: 'com.atproto.space.getSpaceCredential',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Request a space credential. Called on the space authority. A delegation token is required when the space gates on the user. A client attestation is required when the space gates on app identity. A space that requires neither offers public access. The resulting space credential reads repos across the space.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'credentialKid'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              credentialKid: {
                type: 'string',
                description:
                  'P-256 did:key to bind the credential to. Each request using the credential is signed by this key.',
              },
              delegationToken: {
                type: 'string',
                description:
                  'Optional delegation token establishing the user being acted for. Required only when the space gates on the user.',
              },
              clientAttestation: {
                type: 'string',
                description:
                  "Optional client attestation JWT establishing the app's identity. Required only when the space gates on app identity.",
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
                description: 'A signed JWT space credential.',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
            description:
              'The space does not exist. An authority may also answer this in place of UserNotAuthorized, so that a refusal does not disclose that the space exists to a user who may not read it.',
          },
          {
            name: 'SpaceDeleted',
          },
          {
            name: 'UserNotAuthorized',
            description: 'Refused on the basis of the requesting user.',
          },
          {
            name: 'AppNotAuthorized',
            description: 'Refused on the basis of the requesting app.',
          },
          {
            name: 'NotAuthorized',
            description:
              'Refused without attributing the refusal to the user or the app. Authorities that do not wish to disclose which perimeter failed may return this in place of UserNotAuthorized or AppNotAuthorized.',
          },
          {
            name: 'InvalidDelegationToken',
          },
          {
            name: 'InvalidClientAttestation',
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
          "Import the authenticated account's repo in a space from a STAR file, as served by getRepo, during account migration, replacing whatever this host holds for that repo. The archive's commit names the space and must name the account as its repo. If the account is the space's authority, the space must first be imported with importSpaceMeta. Blobs are not included and are uploaded separately. Requires OAuth with a create grant for every collection in the archive, implemented by PDS.",
        input: {
          encoding: 'application/octet-stream',
        },
        errors: [
          {
            name: 'SpaceNotFound',
            description:
              "The account is the space's authority, and the space has not been imported.",
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
          "Import a space from a space meta archive, as served by exportSpaceMeta, during account migration, replacing whatever this host holds for that space. The space must be anchored on the authenticated account's DID. Must come before importing the account's own repo in the space with importRepo. Notification registrations, credential revocations, and deleted space tombstones are not carried over. Requires OAuth with manage=create and manage=update grants for the space, implemented by PDS.",
        input: {
          encoding: 'application/octet-stream',
        },
        errors: [
          {
            name: 'NotSpaceOwner',
          },
          {
            name: 'UnsupportedPolicy',
            description:
              "The archive's policy, or a value within it, is not one the host implements. A host will not store a policy it cannot enforce.",
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
          "List the CIDs of blobs referenced by an account's records within a permissioned space, optionally since some revision of that repo. Lets a syncer discover which blobs to fetch via getBlob, and lets an account enumerate the blobs it must carry when migrating a permissioned repo. Scoped to one space: blobs behind permissioned records are never enumerated by com.atproto.sync.listBlobs, which is unauthenticated. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services).",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            repo: {
              type: 'string',
              format: 'did',
              description: 'The DID of the account whose blobs to list.',
            },
            since: {
              type: 'string',
              format: 'tid',
              description:
                'Optional revision of the permissioned repo to list blobs since.',
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
          "List the records in an account's repo within a permissioned space, optionally filtered by collection. By default each record's value is inlined; set excludeValues for a metadata-only listing (collection, rkey, cid). Used for full-state recovery. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services). Throws RepoNotFound when the account holds no repo in the space; this does not distinguish a member that has never written from a non-member.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            repo: {
              type: 'string',
              format: 'did',
              description: 'The DID of the account whose repo to list.',
            },
            collection: {
              type: 'string',
              format: 'nsid',
              description:
                'The NSID of the record collection. If omitted, lists records across all collections.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 50,
              description: 'The number of records to return.',
            },
            cursor: {
              type: 'string',
            },
            reverse: {
              type: 'boolean',
              description: 'Flag to reverse the order of the returned records.',
            },
            excludeValues: {
              type: 'boolean',
              default: false,
              description:
                'If true, omit inlined record values and return only metadata (collection, rkey, cid).',
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
            description:
              "The record's value. Inlined by default; omitted when excludeValues is set.",
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
          "List the operation log for an account's permissioned repo within a space, returning operations after a given revision. Primary incremental sync mechanism. By default each created or updated operation inlines the record's current value; set excludeValues for metadata-only entries. Note the oplog is a transport optimization with no history guarantee: a host may compact it or drop it, and it does not survive account migration, so omitting `since` returns the retained window rather than the repo's full history. Use getRepo for an initial sync or when a `since` revision is no longer available. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services). When called with a space credential, the caller must send an Atproto-Space-Want-Mac header, and a response that includes the commit carries its MAC in the Atproto-Space-Mac response header.",
        parameters: {
          type: 'params',
          required: ['space', 'repo'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            repo: {
              type: 'string',
              format: 'did',
              description: 'The DID of the account whose oplog to retrieve.',
            },
            since: {
              type: 'string',
              format: 'tid',
              description:
                "Return operations after this revision. The caller's own sync position; use `cursor` to continue a paginated response.",
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 100,
              description: 'Maximum number of operations to return.',
            },
            cursor: {
              type: 'string',
              description:
                'Opaque pagination cursor from a previous response. Takes precedence over `since` when both are supplied.',
            },
            excludeValues: {
              type: 'boolean',
              default: false,
              description:
                'If true, omit inlined record values and return only operation metadata.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['ops'],
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
                  "The account's current commit. Included when the response reaches the head of the oplog; omitted on backfill responses.",
              },
              cursor: {
                type: 'string',
                description:
                  'Pass as `cursor` to fetch the next page. Absent once the response reaches the head of the oplog.',
              },
            },
          },
        },
        errors: [
          {
            name: 'BadSpaceMac',
            description:
              'The Atproto-Space-Want-Mac header is missing or malformed, names an unsupported type or version, or carries an invalid key share.',
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
      opEntry: {
        type: 'object',
        description:
          "A single operation in a permissioned repo's oplog. cid is null for deletes; prev is null for creates. Operations sharing the same rev belong to the same batch. value carries the record's current value for creates and updates, unless excludeValues was set or the value is stale (superseded by a later operation).",
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
          },
          prev: {
            type: 'string',
            format: 'cid',
          },
          value: {
            type: 'unknown',
            description:
              "The record's current value, inlined for create and update operations. Omitted when excludeValues is set, for deletes, or when the value has been superseded by a later operation.",
          },
        },
      },
    },
  },
  ComAtprotoSpaceListRepos: {
    lexicon: 1,
    id: 'com.atproto.space.listRepos',
    defs: {
      main: {
        type: 'query',
        description:
          "List the known repos that hold data in a space (the writer set), with each repo's current repoRev and commit data. Served by the space host. This is the sync boundary, not an access-control list: it enumerates only writers, never readers. The set is what the authority claims from write notifications and is not itself authoritative; a repo's host is the source of truth.",
        parameters: {
          type: 'params',
          required: ['space'],
          properties: {
            space: {
              type: 'string',
              format: 'space-ref',
              description: 'Reference to the space.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 100,
              description: 'Maximum number of repos to return.',
            },
            cursor: {
              type: 'string',
              description:
                "Return repos updated after this space revision (exclusive). Use a previous response's cursor or a previously processed spaceRev.",
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
                  type: 'ref',
                  ref: 'lex:com.atproto.space.listRepos#repo',
                },
                description:
                  'Returned in ascending spaceRev order. A repo may reappear if updated while paginating.',
              },
              cursor: {
                type: 'string',
                description:
                  'Pass this cursor on the next request. Omitted when no repos are returned.',
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
      repo: {
        type: 'object',
        required: ['did', 'repoRev', 'data', 'spaceRev'],
        properties: {
          did: {
            type: 'string',
            format: 'did',
            description: 'The DID of a repo that holds data in the space.',
          },
          repoRev: {
            type: 'string',
            description:
              "The repo's current revision (TID), as last reported to the authority. May lag the repo host, which is the source of truth.",
            format: 'tid',
          },
          data: {
            type: 'bytes',
            description:
              "The repo's current commit data (sha256 of the LtHash state), as last reported to the authority.",
          },
          spaceRev: {
            type: 'string',
            format: 'tid',
            description:
              'The space revision at which this repo was last updated.',
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
          "List the spaces the authenticated user holds a repo in (i.e. spaces the user has written data to) or is the authority of, optionally filtered by type and/or authority DID. Note this is not 'spaces I'm a member of' — a member's PDS only tracks spaces its user has written to. Requires auth, implemented by PDS.",
        parameters: {
          type: 'params',
          properties: {
            spaceType: {
              type: 'string',
              format: 'nsid',
              description: 'Filter to spaces of this space type.',
            },
            did: {
              type: 'string',
              format: 'did',
              description: 'Filter to spaces under this authority DID.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              default: 50,
              description: 'The number of spaces to return.',
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
      },
      spaceView: {
        type: 'object',
        required: ['uri'],
        properties: {
          uri: {
            type: 'string',
            format: 'space-ref',
            description: 'URI of the space.',
          },
        },
      },
    },
  },
  ComAtprotoSpaceNotifyCredentialRevoked: {
    lexicon: 1,
    id: 'com.atproto.space.notifyCredentialRevoked',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Notify a repo host that the space authority has revoked one or more credentials. Authenticated with service auth from the space authority, addressed to the repo DID.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'credentials'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              credentials: {
                type: 'array',
                minLength: 1,
                maxLength: 100,
                description: 'The jti of the revoked credentials.',
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
  ComAtprotoSpaceNotifySpaceDeleted: {
    lexicon: 1,
    id: 'com.atproto.space.notifySpaceDeleted',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Notify a syncing service that a space was deleted and its copy should be dropped. Sent by the space authority to registered services, retried until delivered or the registration expires. Requires service auth.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the deleted space.',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoSpaceNotifyWrite: {
    lexicon: 1,
    id: 'com.atproto.space.notifyWrite',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Notify that a repo in a space has advanced. Repo hosts reliably deliver their latest state to the space host, which sequences updates and forwards them to registered syncers with reasonable-effort delivery. Authenticated with service auth.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'repoRev', 'data'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              repo: {
                type: 'string',
                format: 'did',
                description: 'The DID of the account whose repo advanced.',
              },
              repoRev: {
                type: 'string',
                description: 'The repo revision after the write.',
                format: 'tid',
              },
              data: {
                type: 'bytes',
                description:
                  "The repo's current commit data (sha256 of the LtHash state) after the write. Lets the space host maintain each repo's commit data for listRepos.",
              },
              spaceRev: {
                type: 'string',
                format: 'tid',
                description:
                  'The space revision assigned by the space host. Present only on notifications forwarded to syncers.',
              },
              prevSpaceRev: {
                type: 'string',
                format: 'tid',
                description:
                  'The previous space revision. Omitted on the first update in a space. A gap indicates missed notifications; recover using listRepos with cursor.',
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
            description: 'The repo revision exceeds the permitted clock skew.',
          },
        ],
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
          'Write a record in a permissioned space, creating or updating it as needed. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'repo', 'collection', 'rkey', 'record'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              repo: {
                type: 'string',
                format: 'did',
                description:
                  'The DID of the repo to write to (the authenticated member).',
              },
              collection: {
                type: 'string',
                format: 'nsid',
                description: 'The NSID of the record collection.',
              },
              rkey: {
                type: 'string',
                format: 'record-key',
                description: 'The Record Key.',
                maxLength: 512,
              },
              validate: {
                type: 'boolean',
                description:
                  "Can be set to 'false' to skip Lexicon schema validation of record data, 'true' to require it, or leave unset to validate only for known Lexicons.",
              },
              record: {
                type: 'unknown',
                description: 'The record to write.',
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
                description: 'URI of the written record.',
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
  ComAtprotoSpaceRegisterNotify: {
    lexicon: 1,
    id: 'com.atproto.space.registerNotify',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Register a service to be notified of writes to any repo in a space. Called on the space host. The registering service is named by its service identifier rather than a bare URL, because notifyWrite is delivered with service auth addressed to that identifier; the delivery endpoint is resolved from the service's DID document. Authenticated with a space credential. Re-registering an existing service replaces its registration and extends the expiry.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'service'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              service: {
                type: 'string',
                description:
                  "Service identifier of the subscriber: a DID with an optional service fragment naming the entry in its DID document to deliver to (e.g. 'did:web:syncer.example.com#atproto_space_syncer'). notifyWrite calls are addressed to this identifier.",
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['expiresAt'],
            properties: {
              expiresAt: {
                type: 'string',
                format: 'datetime',
                description:
                  'When the registration expires. May be later than the expiry of the space credential the request was authenticated with; renew before this time to stay subscribed.',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'ServiceNotResolvable',
            description:
              'The service identifier could not be resolved to a DID document with a matching service endpoint.',
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
          "Remove an account from a space's writer set, so that listRepos no longer lists it. The account is tracked again if it later writes while still authorized. Idempotent: succeeds whether or not the account was in the writer set. Requires auth as an account that may manage the space.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'did'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              did: {
                type: 'string',
                format: 'did',
                description: 'The DID of the writer to remove.',
              },
            },
          },
        },
        errors: [
          {
            name: 'SpaceNotFound',
          },
          {
            name: 'NotSpaceOwner',
          },
        ],
      },
    },
  },
  ComAtprotoSpaceUnregisterNotify: {
    lexicon: 1,
    id: 'com.atproto.space.unregisterNotify',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Withdraw a write-notification registration made through registerNotify. Called on the space host. Idempotent: succeeds whether or not a matching registration existed. Registrations also lapse on their own at the expiry returned by registerNotify, so this is for explicit withdrawal rather than cleanup. Authenticated with a space credential.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'service'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
              },
              service: {
                type: 'string',
                description:
                  'Service identifier of the subscriber to remove, as passed to registerNotify.',
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
  ComAtprotoSpaceUpdateSpace: {
    lexicon: 1,
    id: 'com.atproto.space.updateSpace',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Replace the policy of a space wholesale. A policy with a different $type migrates the space, discarding state held by the previous policy (such as a member list). The authenticated user must be the space owner. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space', 'policy'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space to update.',
              },
              policy: {
                type: 'union',
                description:
                  'The policy governing the space, including its configuration. Replaces the current policy.',
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
            name: 'NotSpaceOwner',
          },
          {
            name: 'UnsupportedPolicy',
            description: 'The requested policy is not one the host implements.',
          },
        ],
      },
    },
  },
  OrgSlackOperatorExecute: {
    lexicon: 1,
    id: 'org.slack.operator.execute',
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
                ref: 'lex:org.slack.operator.execute#operationRequest',
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
                ref: 'lex:org.slack.operator.execute#operation',
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
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 80,
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
              maxLength: 128,
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
  OrgSlackOperatorGetOperation: {
    lexicon: 1,
    id: 'org.slack.operator.getOperation',
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
                ref: 'lex:org.slack.operator.execute#operation',
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
  OrgSlackOperatorListInboxWriters: {
    lexicon: 1,
    id: 'org.slack.operator.listInboxWriters',
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
  ComAtprotoManagedspaceCheckUserAccess:
    'com.atproto.managedspace.checkUserAccess',
  ComAtprotoManagedspacePolicy: 'com.atproto.managedspace.policy',
  ComAtprotoMemberspaceListMembers: 'com.atproto.memberspace.listMembers',
  ComAtprotoMemberspacePolicy: 'com.atproto.memberspace.policy',
  ComAtprotoMemberspacePutMember: 'com.atproto.memberspace.putMember',
  ComAtprotoMemberspaceRemoveMember: 'com.atproto.memberspace.removeMember',
  ComAtprotoPersonalspacePolicy: 'com.atproto.personalspace.policy',
  ComAtprotoServerGetServiceAuth: 'com.atproto.server.getServiceAuth',
  ComAtprotoSpaceApplyWrites: 'com.atproto.space.applyWrites',
  ComAtprotoSpaceClearRecords: 'com.atproto.space.clearRecords',
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
  ComAtprotoSpaceGetSpaceCredential: 'com.atproto.space.getSpaceCredential',
  ComAtprotoSpaceImportRepo: 'com.atproto.space.importRepo',
  ComAtprotoSpaceImportSpaceMeta: 'com.atproto.space.importSpaceMeta',
  ComAtprotoSpaceListBlobs: 'com.atproto.space.listBlobs',
  ComAtprotoSpaceListRecords: 'com.atproto.space.listRecords',
  ComAtprotoSpaceListRepoOps: 'com.atproto.space.listRepoOps',
  ComAtprotoSpaceListRepos: 'com.atproto.space.listRepos',
  ComAtprotoSpaceListSpaces: 'com.atproto.space.listSpaces',
  ComAtprotoSpaceNotifyCredentialRevoked:
    'com.atproto.space.notifyCredentialRevoked',
  ComAtprotoSpaceNotifySpaceDeleted: 'com.atproto.space.notifySpaceDeleted',
  ComAtprotoSpaceNotifyWrite: 'com.atproto.space.notifyWrite',
  ComAtprotoSpacePutRecord: 'com.atproto.space.putRecord',
  ComAtprotoSpaceRegisterNotify: 'com.atproto.space.registerNotify',
  ComAtprotoSpaceRemoveWriter: 'com.atproto.space.removeWriter',
  ComAtprotoSpaceUnregisterNotify: 'com.atproto.space.unregisterNotify',
  ComAtprotoSpaceUpdateSpace: 'com.atproto.space.updateSpace',
  OrgSlackOperatorExecute: 'org.slack.operator.execute',
  OrgSlackOperatorGetOperation: 'org.slack.operator.getOperation',
  OrgSlackOperatorListInboxWriters: 'org.slack.operator.listInboxWriters',
} as const
