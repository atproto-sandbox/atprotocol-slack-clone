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
  ComAtprotoSimplespaceCheckUserAccess: {
    lexicon: 1,
    id: 'com.atproto.simplespace.checkUserAccess',
    defs: {
      main: {
        type: 'query',
        description:
          "Ask a space's managing app whether to authorize a user to read or write. Served by the managingApp (not the PDS), called by the space authority when the corresponding policy is 'managing-app'. Authenticated with service auth from the authority.",
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
  ComAtprotoSimplespaceCreateSpace: {
    lexicon: 1,
    id: 'com.atproto.simplespace.createSpace',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Create a new space managed by the simplespace implementation. The space is anchored on the authenticated user's DID, who becomes the space owner. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['spaceType', 'readPolicy', 'writePolicy', 'appAccess'],
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
              readPolicy: {
                type: 'union',
                description:
                  'How the authority decides whether to authorize a user to read the space.',
                refs: [
                  'lex:com.atproto.simplespace.defs#publicPolicy',
                  'lex:com.atproto.simplespace.defs#memberListPolicy',
                  'lex:com.atproto.simplespace.defs#managingAppPolicy',
                ],
              },
              writePolicy: {
                type: 'union',
                description:
                  "How the authority decides whether to track and forward a user's write notifications.",
                refs: [
                  'lex:com.atproto.simplespace.defs#publicPolicy',
                  'lex:com.atproto.simplespace.defs#memberListPolicy',
                  'lex:com.atproto.simplespace.defs#managingAppPolicy',
                ],
              },
              appAccess: {
                type: 'union',
                description:
                  'How the authority decides whether to authorize a requesting app.',
                refs: [
                  'lex:com.atproto.simplespace.defs#open',
                  'lex:com.atproto.simplespace.defs#allowList',
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
            description: 'A requested policy is not one the host implements.',
          },
          {
            name: 'UnsupportedAppAccess',
            description:
              'The requested appAccess variant is not one the host implements. A host will not store an app access policy it cannot enforce.',
          },
        ],
      },
    },
  },
  ComAtprotoSimplespaceDefs: {
    lexicon: 1,
    id: 'com.atproto.simplespace.defs',
    defs: {
      publicPolicy: {
        type: 'object',
        description: 'User access policy: any user may access the space.',
        properties: {},
      },
      memberListPolicy: {
        type: 'object',
        description:
          "User access policy: only users on the space's member list may access it.",
        properties: {},
      },
      managingAppPolicy: {
        type: 'object',
        description:
          'User access policy: the managing app is asked, via checkUserAccess, whether to authorize each user.',
        required: ['managingApp'],
        properties: {
          managingApp: {
            type: 'string',
            description:
              "Service identifier of the managing app: a DID with an optional service fragment (e.g. 'did:web:example.com#forum').",
          },
        },
      },
      open: {
        type: 'object',
        description:
          'App access policy: any app may access the space. No client attestation required.',
        properties: {},
      },
      allowList: {
        type: 'object',
        description:
          'App access policy: only the named clients may access the space, evaluated against the attested client_id.',
        required: ['allowed'],
        properties: {
          allowed: {
            type: 'array',
            description: 'The OAuth client IDs permitted to access the space.',
            items: {
              type: 'string',
              description: 'An OAuth client ID.',
            },
          },
        },
      },
    },
  },
  ComAtprotoSimplespaceDeleteSpace: {
    lexicon: 1,
    id: 'com.atproto.simplespace.deleteSpace',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Delete a space. The authenticated user must be the space owner. The authority's own repo in the space is deleted along with it, since the space host and the repo host are the same service here; other members' repos are flagged as belonging to a deleted space rather than erased. After deletion, all reads and writes against the space fail with SpaceNotFound, and getSpaceCredential answers SpaceDeleted so a syncer that missed the notification still learns to drop its copy. Idempotent. Requires auth, implemented by PDS.",
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
  ComAtprotoSimplespaceGetSpace: {
    lexicon: 1,
    id: 'com.atproto.simplespace.getSpace',
    defs: {
      main: {
        type: 'query',
        description:
          'Describe a space managed by the simplespace implementation, including its configuration. Served by the space host. Requires either OAuth (for a caller with an account on this host) or a space credential (for a member hosted elsewhere); either way the caller must be authorized for the space.',
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
            required: ['uri', 'readPolicy', 'writePolicy', 'appAccess'],
            properties: {
              uri: {
                type: 'string',
                format: 'space-ref',
                description: 'URI of the space.',
              },
              readPolicy: {
                type: 'union',
                description:
                  'How the authority decides whether to authorize a user to read the space.',
                refs: [
                  'lex:com.atproto.simplespace.defs#publicPolicy',
                  'lex:com.atproto.simplespace.defs#memberListPolicy',
                  'lex:com.atproto.simplespace.defs#managingAppPolicy',
                ],
              },
              writePolicy: {
                type: 'union',
                description:
                  "How the authority decides whether to track and forward a user's write notifications.",
                refs: [
                  'lex:com.atproto.simplespace.defs#publicPolicy',
                  'lex:com.atproto.simplespace.defs#memberListPolicy',
                  'lex:com.atproto.simplespace.defs#managingAppPolicy',
                ],
              },
              appAccess: {
                type: 'union',
                description:
                  'How the authority decides whether to authorize a requesting app.',
                refs: [
                  'lex:com.atproto.simplespace.defs#open',
                  'lex:com.atproto.simplespace.defs#allowList',
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
  ComAtprotoSimplespaceListMembers: {
    lexicon: 1,
    id: 'com.atproto.simplespace.listMembers',
    defs: {
      main: {
        type: 'query',
        description:
          "List the members in a space's host-internal member list and their read and write access. Must be called on the space authority's PDS. Requires OAuth with a covering read grant; a space credential is not sufficient, so members hosted elsewhere cannot enumerate the list.",
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
                  ref: 'lex:com.atproto.simplespace.listMembers#member',
                },
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
  ComAtprotoSimplespacePutMember: {
    lexicon: 1,
    id: 'com.atproto.simplespace.putMember',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Add a member to a space's host-internal member list or replace their read and write access. Requires auth as the space owner.",
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
                  'Whether the member may read under a member-list read policy.',
              },
              write: {
                type: 'boolean',
                description:
                  "Whether the member's writes are tracked under a member-list write policy.",
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
  ComAtprotoSimplespaceRemoveMember: {
    lexicon: 1,
    id: 'com.atproto.simplespace.removeMember',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Remove a member from a space's host-internal member list. Requires auth as the space owner.",
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
        ],
      },
    },
  },
  ComAtprotoSimplespaceUpdateSpace: {
    lexicon: 1,
    id: 'com.atproto.simplespace.updateSpace',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Update the configuration of a space. The authenticated user must be the space owner. Omitted fields are left unchanged. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space to update.',
              },
              readPolicy: {
                type: 'union',
                description:
                  'How the authority decides whether to authorize a user to read the space. When supplied, replaces the current read policy wholesale.',
                refs: [
                  'lex:com.atproto.simplespace.defs#publicPolicy',
                  'lex:com.atproto.simplespace.defs#memberListPolicy',
                  'lex:com.atproto.simplespace.defs#managingAppPolicy',
                ],
              },
              writePolicy: {
                type: 'union',
                description:
                  "How the authority decides whether to track and forward a user's write notifications. When supplied, replaces the current write policy wholesale.",
                refs: [
                  'lex:com.atproto.simplespace.defs#publicPolicy',
                  'lex:com.atproto.simplespace.defs#memberListPolicy',
                  'lex:com.atproto.simplespace.defs#managingAppPolicy',
                ],
              },
              appAccess: {
                type: 'union',
                description:
                  'How the authority decides whether to authorize a requesting app. When supplied, replaces the current policy wholesale.',
                refs: [
                  'lex:com.atproto.simplespace.defs#open',
                  'lex:com.atproto.simplespace.defs#allowList',
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
            description: 'A requested policy is not one the host implements.',
          },
          {
            name: 'UnsupportedAppAccess',
            description:
              'The requested appAccess variant is not one the host implements. A host will not store an app access policy it cannot enforce.',
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
  ComAtprotoSpaceDefs: {
    lexicon: 1,
    id: 'com.atproto.space.defs',
    defs: {
      signedCommit: {
        type: 'object',
        description:
          'A signed commit over the current state of a permissioned repo.',
        required: ['ver', 'hash', 'mac', 'ikm', 'sig', 'rev'],
        properties: {
          ver: {
            type: 'integer',
            description:
              'Commit format version, currently 1. Corresponds to the version in the ctx protocol tag (atproto-space-v1).',
          },
          hash: {
            type: 'bytes',
            description: 'sha256 digest of the LtHash state (32 bytes).',
          },
          ikm: {
            type: 'bytes',
            description:
              'Per-signature input keying material (32 random bytes)',
          },
          sig: {
            type: 'bytes',
            description:
              "Signature over ctx (space, author DID, rev, ikm) by the user's atproto signing key. Does not cover the repo hash.",
          },
          mac: {
            type: 'bytes',
            description:
              "HMAC-SHA256 over hash, keyed by HKDF-SHA256(ikm, info=ctx). Binds the repo hash to this commit's context.",
          },
          rev: {
            type: 'string',
            format: 'tid',
            description: 'Commit revision (TID), also bound into ctx.',
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
          "Get the current signed commit for an account's permissioned repo within a space. Served by a repo host. Throws RepoNotFound when the account holds no repo in the space, including the case of a member that has never written to it. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services).",
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
                ref: 'lex:com.atproto.space.defs#signedCommit',
                description: "The account's current signed commit.",
              },
            },
            required: ['commit'],
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
  ComAtprotoSpaceGetRecord: {
    lexicon: 1,
    id: 'com.atproto.space.getRecord',
    defs: {
      main: {
        type: 'query',
        description:
          "Get a single record from a permissioned space. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services). Throws RepoNotFound when the account holds no repo in the space; this does not distinguish a member that has never written from a non-member.",
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
          "Download an account's permissioned repo within a space as a CAR file, for full-state recovery. The CAR declares two roots in order: the signed commit, then a DRISL (DAG-CBOR) index mapping '{collection}/{rkey}' to record CID. Record blocks follow, in the same canonical DAG-CBOR key order as the index (length-first, then bytewise). Blobs are not included and are fetched separately via getBlob. Served by a repo host. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services).",
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
            excludeValues: {
              type: 'boolean',
              default: false,
              description:
                'If true, omit the record blocks and return only the commit and index roots. The index is still fully authenticated by folding its entries into a set hash and comparing against the commit, so a syncer can diff it against a local copy and fetch just the records it lacks. Note the resulting CAR declares two roots and carries no non-root blocks.',
            },
          },
        },
        output: {
          encoding: 'application/vnd.ipld.car',
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
  ComAtprotoSpaceGetSpaceCredential: {
    lexicon: 1,
    id: 'com.atproto.space.getSpaceCredential',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Exchange a delegation token for a space credential. Called on the space authority, with the delegation token as the request's authorization token and an HTTP message signature over Authorization made by the key to bind the credential to. The resulting space credential reads repos across the space. Requires a delegation token and HTTP message signature, plus a client attestation when the space gates on app identity.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['space'],
            properties: {
              space: {
                type: 'string',
                format: 'space-ref',
                description: 'Reference to the space.',
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
          "List the operation log for an account's permissioned repo within a space, returning operations after a given revision. Primary incremental sync mechanism. By default each created or updated operation inlines the record's current value; set excludeValues for metadata-only entries. Note the oplog is a transport optimization with no history guarantee: a host may compact it or drop it, and it does not survive account migration, so omitting `since` returns the retained window rather than the repo's full history. Use getRepo for an initial sync or when a `since` revision is no longer available. Callable with either OAuth (for the authenticated user's own data) or a space credential (for syncing services).",
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
                ref: 'lex:com.atproto.space.defs#signedCommit',
                description:
                  "The account's current signed commit. Included when the response reaches the head of the oplog; omitted on backfill responses.",
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
          "List the known repos that hold data in a space (the writer set), with each repo's current repoRev and commit hash. Served by the space host. This is the sync boundary, not an access-control list: it enumerates only writers, never readers. The set is what the authority claims from write notifications and is not itself authoritative; a repo's host is the source of truth.",
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
        required: ['did', 'repoRev', 'hash', 'spaceRev'],
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
          hash: {
            type: 'bytes',
            description:
              "The repo's current commit hash (sha256 of the LtHash state), as last reported to the authority.",
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
          "List the spaces the authenticated user holds a repo in (i.e. spaces the user has written data to), optionally filtered by type and/or authority DID. Note this is not 'spaces I'm a member of' — a member's PDS only tracks spaces its user has written to. Requires auth, implemented by PDS.",
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
          "Notify a syncing service that a space has been deleted, and that it should drop every copy of the space's data it holds. Sent by the space authority to the services registered for the space, best-effort. Authenticated with service auth addressed to the receiving service.",
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
            required: ['space', 'repo', 'repoRev', 'hash'],
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
              hash: {
                type: 'bytes',
                description:
                  "The repo's current commit hash (sha256 of the LtHash state) after the write. Lets the space host maintain each repo's hash for listRepos.",
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
  ComAtprotoServerGetServiceAuth: 'com.atproto.server.getServiceAuth',
  ComAtprotoSimplespaceCheckUserAccess:
    'com.atproto.simplespace.checkUserAccess',
  ComAtprotoSimplespaceCreateSpace: 'com.atproto.simplespace.createSpace',
  ComAtprotoSimplespaceDefs: 'com.atproto.simplespace.defs',
  ComAtprotoSimplespaceDeleteSpace: 'com.atproto.simplespace.deleteSpace',
  ComAtprotoSimplespaceGetSpace: 'com.atproto.simplespace.getSpace',
  ComAtprotoSimplespaceListMembers: 'com.atproto.simplespace.listMembers',
  ComAtprotoSimplespacePutMember: 'com.atproto.simplespace.putMember',
  ComAtprotoSimplespaceRemoveMember: 'com.atproto.simplespace.removeMember',
  ComAtprotoSimplespaceUpdateSpace: 'com.atproto.simplespace.updateSpace',
  ComAtprotoSpaceApplyWrites: 'com.atproto.space.applyWrites',
  ComAtprotoSpaceCreateRecord: 'com.atproto.space.createRecord',
  ComAtprotoSpaceDefs: 'com.atproto.space.defs',
  ComAtprotoSpaceDeleteRecord: 'com.atproto.space.deleteRecord',
  ComAtprotoSpaceGetBlob: 'com.atproto.space.getBlob',
  ComAtprotoSpaceGetDelegationToken: 'com.atproto.space.getDelegationToken',
  ComAtprotoSpaceGetLatestCommit: 'com.atproto.space.getLatestCommit',
  ComAtprotoSpaceGetRecord: 'com.atproto.space.getRecord',
  ComAtprotoSpaceGetRepo: 'com.atproto.space.getRepo',
  ComAtprotoSpaceGetSpaceCredential: 'com.atproto.space.getSpaceCredential',
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
  ComAtprotoSpaceUnregisterNotify: 'com.atproto.space.unregisterNotify',
  OrgSlackOperatorExecute: 'org.slack.operator.execute',
  OrgSlackOperatorGetOperation: 'org.slack.operator.getOperation',
  OrgSlackOperatorListInboxWriters: 'org.slack.operator.listInboxWriters',
} as const
