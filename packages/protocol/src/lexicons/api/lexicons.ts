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
  ComAtprotoIdentityGetRecommendedDidCredentials: {
    lexicon: 1,
    id: 'com.atproto.identity.getRecommendedDidCredentials',
    defs: {
      main: {
        type: 'query',
        description:
          'Describe the credentials that should be included in the DID doc of an account that is migrating to this service.',
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {
              rotationKeys: {
                description:
                  'Recommended rotation keys for PLC dids. Should be undefined (or ignored) for did:webs.',
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              alsoKnownAs: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              verificationMethods: {
                type: 'unknown',
              },
              services: {
                type: 'unknown',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoIdentityRequestPlcOperationSignature: {
    lexicon: 1,
    id: 'com.atproto.identity.requestPlcOperationSignature',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Request an email with a code to in order to request a signed PLC operation. Requires Auth.',
      },
    },
  },
  ComAtprotoIdentityResolveHandle: {
    lexicon: 1,
    id: 'com.atproto.identity.resolveHandle',
    defs: {
      main: {
        type: 'query',
        description:
          'Resolves an atproto handle (hostname) to a DID. Does not necessarily bi-directionally verify against the the DID document.',
        parameters: {
          type: 'params',
          required: ['handle'],
          properties: {
            handle: {
              type: 'string',
              format: 'handle',
              description: 'The handle to resolve.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['did'],
            properties: {
              did: {
                type: 'string',
                format: 'did',
              },
            },
          },
        },
        errors: [
          {
            name: 'HandleNotFound',
            description:
              'The resolution process confirmed that the handle does not resolve to any DID.',
          },
        ],
      },
    },
  },
  ComAtprotoIdentitySignPlcOperation: {
    lexicon: 1,
    id: 'com.atproto.identity.signPlcOperation',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Signs a PLC operation to update some value(s) in the requesting DID's document.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {
              token: {
                description:
                  'A token received through com.atproto.identity.requestPlcOperationSignature',
                type: 'string',
              },
              rotationKeys: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              alsoKnownAs: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              verificationMethods: {
                type: 'unknown',
              },
              services: {
                type: 'unknown',
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
                type: 'unknown',
                description: 'A signed DID PLC operation.',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoIdentitySubmitPlcOperation: {
    lexicon: 1,
    id: 'com.atproto.identity.submitPlcOperation',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Validates a PLC operation to ensure that it doesn't violate a service's constraints or get the identity into a bad state, then submits it to the PLC registry",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['operation'],
            properties: {
              operation: {
                type: 'unknown',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoLabelDefs: {
    lexicon: 1,
    id: 'com.atproto.label.defs',
    defs: {
      label: {
        type: 'object',
        description:
          'Metadata tag on an atproto resource (eg, repo or record).',
        required: ['src', 'uri', 'val', 'cts'],
        properties: {
          ver: {
            type: 'integer',
            description: 'The AT Protocol version of the label object.',
          },
          src: {
            type: 'string',
            format: 'did',
            description: 'DID of the actor who created this label.',
          },
          uri: {
            type: 'string',
            format: 'uri',
            description:
              'AT URI of the record, repository (account), or other resource that this label applies to.',
          },
          cid: {
            type: 'string',
            format: 'cid',
            description:
              "Optionally, CID specifying the specific version of 'uri' resource this label applies to.",
          },
          val: {
            type: 'string',
            maxLength: 128,
            description:
              'The short string name of the value or type of this label.',
          },
          neg: {
            type: 'boolean',
            description:
              'If true, this is a negation label, overwriting a previous label.',
          },
          cts: {
            type: 'string',
            format: 'datetime',
            description: 'Timestamp when this label was created.',
          },
          exp: {
            type: 'string',
            format: 'datetime',
            description:
              'Timestamp at which this label expires (no longer applies).',
          },
          sig: {
            type: 'bytes',
            description: 'Signature of dag-cbor encoded label.',
          },
        },
      },
      selfLabels: {
        type: 'object',
        description:
          'Metadata tags on an atproto record, published by the author within the record.',
        required: ['values'],
        properties: {
          values: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:com.atproto.label.defs#selfLabel',
            },
            maxLength: 10,
          },
        },
      },
      selfLabel: {
        type: 'object',
        description:
          'Metadata tag on an atproto record, published by the author within the record. Note that schemas should use #selfLabels, not #selfLabel.',
        required: ['val'],
        properties: {
          val: {
            type: 'string',
            maxLength: 128,
            description:
              'The short string name of the value or type of this label.',
          },
        },
      },
      labelValueDefinition: {
        type: 'object',
        description:
          'Declares a label value and its expected interpretations and behaviors.',
        required: ['identifier', 'severity', 'blurs', 'locales'],
        properties: {
          identifier: {
            type: 'string',
            description:
              "The value of the label being defined. Must only include lowercase ascii and the '-' character ([a-z-]+).",
            maxLength: 100,
            maxGraphemes: 100,
          },
          severity: {
            type: 'string',
            description:
              "How should a client visually convey this label? 'inform' means neutral and informational; 'alert' means negative and warning; 'none' means show nothing.",
            knownValues: ['inform', 'alert', 'none'],
          },
          blurs: {
            type: 'string',
            description:
              "What should this label hide in the UI, if applied? 'content' hides all of the target; 'media' hides the images/video/audio; 'none' hides nothing.",
            knownValues: ['content', 'media', 'none'],
          },
          defaultSetting: {
            type: 'string',
            description: 'The default setting for this label.',
            knownValues: ['ignore', 'warn', 'hide'],
            default: 'warn',
          },
          adultOnly: {
            type: 'boolean',
            description:
              'Does the user need to have adult content enabled in order to configure this label?',
          },
          locales: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:com.atproto.label.defs#labelValueDefinitionStrings',
            },
          },
        },
      },
      labelValueDefinitionStrings: {
        type: 'object',
        description:
          'Strings which describe the label in the UI, localized into a specific language.',
        required: ['lang', 'name', 'description'],
        properties: {
          lang: {
            type: 'string',
            description:
              'The code of the language these strings are written in.',
            format: 'language',
          },
          name: {
            type: 'string',
            description: 'A short human-readable name for the label.',
            maxGraphemes: 64,
            maxLength: 640,
          },
          description: {
            type: 'string',
            description:
              'A longer description of what the label means and why it might be applied.',
            maxGraphemes: 10000,
            maxLength: 100000,
          },
        },
      },
      labelValue: {
        type: 'string',
        knownValues: [
          '!hide',
          '!warn',
          '!no-unauthenticated',
          'porn',
          'sexual',
          'nudity',
          'graphic-media',
          'bot',
        ],
      },
    },
  },
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
  ComAtprotoRepoApplyWrites: {
    lexicon: 1,
    id: 'com.atproto.repo.applyWrites',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Apply a batch transaction of repository creates, updates, and deletes. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repo', 'writes'],
            properties: {
              repo: {
                type: 'string',
                format: 'at-identifier',
                description:
                  'The handle or DID of the repo (aka, current account).',
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
                    'lex:com.atproto.repo.applyWrites#create',
                    'lex:com.atproto.repo.applyWrites#update',
                    'lex:com.atproto.repo.applyWrites#delete',
                  ],
                  closed: true,
                },
              },
              swapCommit: {
                type: 'string',
                description:
                  'If provided, the entire operation will fail if the current repo commit CID does not match this value. Used to prevent conflicting repo mutations.',
                format: 'cid',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: [],
            properties: {
              commit: {
                type: 'ref',
                ref: 'lex:com.atproto.repo.defs#commitMeta',
              },
              results: {
                type: 'array',
                items: {
                  type: 'union',
                  refs: [
                    'lex:com.atproto.repo.applyWrites#createResult',
                    'lex:com.atproto.repo.applyWrites#updateResult',
                    'lex:com.atproto.repo.applyWrites#deleteResult',
                  ],
                  closed: true,
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'InvalidSwap',
            description:
              "Indicates that the 'swapCommit' parameter did not match current commit.",
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
            maxLength: 512,
            format: 'record-key',
            description:
              'NOTE: maxLength is redundant with record-key format. Keeping it temporarily to ensure backwards compatibility.',
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
  ComAtprotoRepoCreateRecord: {
    lexicon: 1,
    id: 'com.atproto.repo.createRecord',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Create a single new repository record. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repo', 'collection', 'record'],
            properties: {
              repo: {
                type: 'string',
                format: 'at-identifier',
                description:
                  'The handle or DID of the repo (aka, current account).',
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
              swapCommit: {
                type: 'string',
                format: 'cid',
                description:
                  'Compare and swap with the previous commit by CID.',
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
              commit: {
                type: 'ref',
                ref: 'lex:com.atproto.repo.defs#commitMeta',
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
            name: 'InvalidSwap',
            description:
              "Indicates that 'swapCommit' didn't match current repo commit.",
          },
        ],
      },
    },
  },
  ComAtprotoRepoDefs: {
    lexicon: 1,
    id: 'com.atproto.repo.defs',
    defs: {
      commitMeta: {
        type: 'object',
        required: ['cid', 'rev'],
        properties: {
          cid: {
            type: 'string',
            format: 'cid',
          },
          rev: {
            type: 'string',
            format: 'tid',
          },
        },
      },
    },
  },
  ComAtprotoRepoDeleteRecord: {
    lexicon: 1,
    id: 'com.atproto.repo.deleteRecord',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Delete a repository record, or ensure it doesn't exist. Requires auth, implemented by PDS.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repo', 'collection', 'rkey'],
            properties: {
              repo: {
                type: 'string',
                format: 'at-identifier',
                description:
                  'The handle or DID of the repo (aka, current account).',
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
              swapRecord: {
                type: 'string',
                format: 'cid',
                description:
                  'Compare and swap with the previous record by CID.',
              },
              swapCommit: {
                type: 'string',
                format: 'cid',
                description:
                  'Compare and swap with the previous commit by CID.',
              },
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
                ref: 'lex:com.atproto.repo.defs#commitMeta',
              },
            },
          },
        },
        errors: [
          {
            name: 'InvalidSwap',
          },
        ],
      },
    },
  },
  ComAtprotoRepoDescribeRepo: {
    lexicon: 1,
    id: 'com.atproto.repo.describeRepo',
    defs: {
      main: {
        type: 'query',
        description:
          'Get information about an account and repository, including the list of collections. Does not require auth.',
        parameters: {
          type: 'params',
          required: ['repo'],
          properties: {
            repo: {
              type: 'string',
              format: 'at-identifier',
              description: 'The handle or DID of the repo.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: [
              'handle',
              'did',
              'didDoc',
              'collections',
              'handleIsCorrect',
            ],
            properties: {
              handle: {
                type: 'string',
                format: 'handle',
              },
              did: {
                type: 'string',
                format: 'did',
              },
              didDoc: {
                type: 'unknown',
                description: 'The complete DID document for this account.',
              },
              collections: {
                type: 'array',
                description:
                  'List of all the collections (NSIDs) for which this repo contains at least one record.',
                items: {
                  type: 'string',
                  format: 'nsid',
                },
              },
              handleIsCorrect: {
                type: 'boolean',
                description:
                  'Indicates if handle is currently valid (resolves bi-directionally)',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoRepoGetRecord: {
    lexicon: 1,
    id: 'com.atproto.repo.getRecord',
    defs: {
      main: {
        type: 'query',
        description:
          'Get a single record from a repository. Does not require auth.',
        parameters: {
          type: 'params',
          required: ['repo', 'collection', 'rkey'],
          properties: {
            repo: {
              type: 'string',
              format: 'at-identifier',
              description: 'The handle or DID of the repo.',
            },
            collection: {
              type: 'string',
              format: 'nsid',
              description: 'The NSID of the record collection.',
            },
            rkey: {
              type: 'string',
              description: 'The Record Key.',
              format: 'record-key',
            },
            cid: {
              type: 'string',
              format: 'cid',
              description:
                'The CID of the version of the record. If not specified, then return the most recent version.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['uri', 'value'],
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
        ],
      },
    },
  },
  ComAtprotoRepoImportRepo: {
    lexicon: 1,
    id: 'com.atproto.repo.importRepo',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Import a repo in the form of a CAR file. Requires Content-Length HTTP header to be set.',
        input: {
          encoding: 'application/vnd.ipld.car',
        },
      },
    },
  },
  ComAtprotoRepoListMissingBlobs: {
    lexicon: 1,
    id: 'com.atproto.repo.listMissingBlobs',
    defs: {
      main: {
        type: 'query',
        description:
          'Returns a list of missing blobs for the requesting account. Intended to be used in the account migration flow.',
        parameters: {
          type: 'params',
          properties: {
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
            required: ['blobs'],
            properties: {
              cursor: {
                type: 'string',
              },
              blobs: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:com.atproto.repo.listMissingBlobs#recordBlob',
                },
              },
            },
          },
        },
      },
      recordBlob: {
        type: 'object',
        required: ['cid', 'recordUri'],
        properties: {
          cid: {
            type: 'string',
            format: 'cid',
          },
          recordUri: {
            type: 'string',
            format: 'at-uri',
          },
        },
      },
    },
  },
  ComAtprotoRepoListRecords: {
    lexicon: 1,
    id: 'com.atproto.repo.listRecords',
    defs: {
      main: {
        type: 'query',
        description:
          'List a range of records in a repository, matching a specific collection. Does not require auth.',
        parameters: {
          type: 'params',
          required: ['repo', 'collection'],
          properties: {
            repo: {
              type: 'string',
              format: 'at-identifier',
              description: 'The handle or DID of the repo.',
            },
            collection: {
              type: 'string',
              format: 'nsid',
              description: 'The NSID of the record type.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
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
                  ref: 'lex:com.atproto.repo.listRecords#record',
                },
              },
            },
          },
        },
      },
      record: {
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
  },
  ComAtprotoRepoPutRecord: {
    lexicon: 1,
    id: 'com.atproto.repo.putRecord',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Write a repository record, creating or updating it as needed. Requires auth, implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['repo', 'collection', 'rkey', 'record'],
            nullable: ['swapRecord'],
            properties: {
              repo: {
                type: 'string',
                format: 'at-identifier',
                description:
                  'The handle or DID of the repo (aka, current account).',
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
              swapRecord: {
                type: 'string',
                format: 'cid',
                description:
                  'Compare and swap with the previous record by CID. WARNING: nullable and optional field; may cause problems with golang implementation',
              },
              swapCommit: {
                type: 'string',
                format: 'cid',
                description:
                  'Compare and swap with the previous commit by CID.',
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
              commit: {
                type: 'ref',
                ref: 'lex:com.atproto.repo.defs#commitMeta',
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
            name: 'InvalidSwap',
          },
        ],
      },
    },
  },
  ComAtprotoRepoStrongRef: {
    lexicon: 1,
    id: 'com.atproto.repo.strongRef',
    description: 'A URI with a content-hash fingerprint.',
    defs: {
      main: {
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
        },
      },
    },
  },
  ComAtprotoRepoUploadBlob: {
    lexicon: 1,
    id: 'com.atproto.repo.uploadBlob',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Upload a new blob, to be referenced from a repository record. The blob will be deleted if it is not referenced within a time window (eg, minutes). Blob restrictions (mimetype, size, etc) are enforced when the reference is created. Requires auth, implemented by PDS.',
        input: {
          encoding: '*/*',
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['blob'],
            properties: {
              blob: {
                type: 'blob',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoServerActivateAccount: {
    lexicon: 1,
    id: 'com.atproto.server.activateAccount',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Activates a currently deactivated account. Used to finalize account migration after the account's repo is imported and identity is setup.",
      },
    },
  },
  ComAtprotoServerCheckAccountStatus: {
    lexicon: 1,
    id: 'com.atproto.server.checkAccountStatus',
    defs: {
      main: {
        type: 'query',
        description:
          'Returns the status of an account, especially as pertaining to import or recovery. Can be called many times over the course of an account migration. Requires auth and can only be called pertaining to oneself.',
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: [
              'activated',
              'validDid',
              'repoCommit',
              'repoRev',
              'repoBlocks',
              'indexedRecords',
              'privateStateValues',
              'expectedBlobs',
              'importedBlobs',
            ],
            properties: {
              activated: {
                type: 'boolean',
              },
              validDid: {
                type: 'boolean',
              },
              repoCommit: {
                type: 'string',
                format: 'cid',
              },
              repoRev: {
                type: 'string',
              },
              repoBlocks: {
                type: 'integer',
              },
              indexedRecords: {
                type: 'integer',
              },
              privateStateValues: {
                type: 'integer',
              },
              expectedBlobs: {
                type: 'integer',
              },
              importedBlobs: {
                type: 'integer',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoServerCreateAccount: {
    lexicon: 1,
    id: 'com.atproto.server.createAccount',
    defs: {
      main: {
        type: 'procedure',
        description: 'Create an account. Implemented by PDS.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['handle'],
            properties: {
              email: {
                type: 'string',
              },
              handle: {
                type: 'string',
                format: 'handle',
                description: 'Requested handle for the account.',
              },
              did: {
                type: 'string',
                format: 'did',
                description:
                  'Pre-existing atproto DID, being imported to a new account.',
              },
              inviteCode: {
                type: 'string',
              },
              verificationCode: {
                type: 'string',
              },
              verificationPhone: {
                type: 'string',
              },
              password: {
                type: 'string',
                description:
                  'Initial account password. May need to meet instance-specific password strength requirements.',
              },
              recoveryKey: {
                type: 'string',
                description:
                  'DID PLC rotation key (aka, recovery key) to be included in PLC creation operation.',
              },
              plcOp: {
                type: 'unknown',
                description:
                  'A signed DID PLC operation to be submitted as part of importing an existing account to this instance. NOTE: this optional field may be updated when full account migration is implemented.',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            description:
              'Account login session returned on successful account creation.',
            required: ['accessJwt', 'refreshJwt', 'handle', 'did'],
            properties: {
              accessJwt: {
                type: 'string',
              },
              refreshJwt: {
                type: 'string',
              },
              handle: {
                type: 'string',
                format: 'handle',
              },
              did: {
                type: 'string',
                format: 'did',
                description: 'The DID of the new account.',
              },
              didDoc: {
                type: 'unknown',
                description: 'Complete DID document.',
              },
            },
          },
        },
        errors: [
          {
            name: 'InvalidHandle',
          },
          {
            name: 'InvalidPassword',
          },
          {
            name: 'InvalidInviteCode',
          },
          {
            name: 'HandleNotAvailable',
          },
          {
            name: 'UnsupportedDomain',
          },
          {
            name: 'UnresolvableDid',
          },
          {
            name: 'IncompatibleDidDoc',
          },
        ],
      },
    },
  },
  ComAtprotoServerDeactivateAccount: {
    lexicon: 1,
    id: 'com.atproto.server.deactivateAccount',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Deactivates a currently active account. Stops serving of repo, and future writes to repo until reactivated. Used to finalize account migration with the old host after the account has been activated on the new host.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            properties: {
              deleteAfter: {
                type: 'string',
                format: 'datetime',
                description:
                  'A recommendation to server as to how long they should hold onto the deactivated account before deleting.',
              },
            },
          },
        },
      },
    },
  },
  ComAtprotoServerDeleteAccount: {
    lexicon: 1,
    id: 'com.atproto.server.deleteAccount',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Delete an actor's account with a token and password. Can only be called after requesting a deletion token. Requires auth.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['did', 'password', 'token'],
            properties: {
              did: {
                type: 'string',
                format: 'did',
              },
              password: {
                type: 'string',
              },
              token: {
                type: 'string',
              },
            },
          },
        },
        errors: [
          {
            name: 'ExpiredToken',
          },
          {
            name: 'InvalidToken',
          },
        ],
      },
    },
  },
  ComAtprotoServerDescribeServer: {
    lexicon: 1,
    id: 'com.atproto.server.describeServer',
    defs: {
      main: {
        type: 'query',
        description:
          "Describes the server's account creation requirements and capabilities. Implemented by PDS.",
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['did', 'availableUserDomains'],
            properties: {
              inviteCodeRequired: {
                type: 'boolean',
                description:
                  'If true, an invite code must be supplied to create an account on this instance.',
              },
              phoneVerificationRequired: {
                type: 'boolean',
                description:
                  'If true, a phone verification token must be supplied to create an account on this instance.',
              },
              blobUploadLimit: {
                type: 'integer',
                description:
                  'Maximum size of a blob that can be uploaded via com.atproto.repo.uploadBlob, in bytes.',
              },
              availableUserDomains: {
                type: 'array',
                description:
                  'List of domain suffixes that can be used in account handles.',
                items: {
                  type: 'string',
                },
              },
              links: {
                type: 'ref',
                description: 'URLs of service policy documents.',
                ref: 'lex:com.atproto.server.describeServer#links',
              },
              contact: {
                type: 'ref',
                description: 'Contact information',
                ref: 'lex:com.atproto.server.describeServer#contact',
              },
              did: {
                type: 'string',
                format: 'did',
              },
            },
          },
        },
      },
      links: {
        type: 'object',
        properties: {
          privacyPolicy: {
            type: 'string',
            format: 'uri',
          },
          termsOfService: {
            type: 'string',
            format: 'uri',
          },
        },
      },
      contact: {
        type: 'object',
        properties: {
          email: {
            type: 'string',
          },
        },
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
  ComAtprotoServerRefreshSession: {
    lexicon: 1,
    id: 'com.atproto.server.refreshSession',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Refresh an authentication session. Requires auth using the 'refreshJwt' (not the 'accessJwt').",
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['accessJwt', 'refreshJwt', 'handle', 'did'],
            properties: {
              accessJwt: {
                type: 'string',
              },
              refreshJwt: {
                type: 'string',
              },
              handle: {
                type: 'string',
                format: 'handle',
              },
              did: {
                type: 'string',
                format: 'did',
              },
              didDoc: {
                type: 'unknown',
              },
              email: {
                type: 'string',
              },
              emailConfirmed: {
                type: 'boolean',
              },
              emailAuthFactor: {
                type: 'boolean',
              },
              active: {
                type: 'boolean',
              },
              status: {
                type: 'string',
                description:
                  "Hosting status of the account. If not specified, then assume 'active'.",
                knownValues: ['takendown', 'suspended', 'deactivated'],
              },
            },
          },
        },
        errors: [
          {
            name: 'AccountTakedown',
          },
          {
            name: 'InvalidToken',
          },
          {
            name: 'ExpiredToken',
          },
        ],
      },
    },
  },
  ComAtprotoServerRequestAccountDelete: {
    lexicon: 1,
    id: 'com.atproto.server.requestAccountDelete',
    defs: {
      main: {
        type: 'procedure',
        description: 'Initiate a user account deletion via email.',
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
  ComAtprotoSyncGetBlob: {
    lexicon: 1,
    id: 'com.atproto.sync.getBlob',
    defs: {
      main: {
        type: 'query',
        description:
          'Get a blob associated with a given account. Returns the full blob as originally uploaded. Does not require auth; implemented by PDS.',
        parameters: {
          type: 'params',
          required: ['did', 'cid'],
          properties: {
            did: {
              type: 'string',
              format: 'did',
              description: 'The DID of the account.',
            },
            cid: {
              type: 'string',
              format: 'cid',
              description: 'The CID of the blob to fetch',
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
  ComAtprotoSyncGetLatestCommit: {
    lexicon: 1,
    id: 'com.atproto.sync.getLatestCommit',
    defs: {
      main: {
        type: 'query',
        description:
          'Get the current commit CID & revision of the specified repo. Does not require auth.',
        parameters: {
          type: 'params',
          required: ['did'],
          properties: {
            did: {
              type: 'string',
              format: 'did',
              description: 'The DID of the repo.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['cid', 'rev'],
            properties: {
              cid: {
                type: 'string',
                format: 'cid',
              },
              rev: {
                type: 'string',
                format: 'tid',
              },
            },
          },
        },
        errors: [
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
  ComAtprotoSyncGetRepo: {
    lexicon: 1,
    id: 'com.atproto.sync.getRepo',
    defs: {
      main: {
        type: 'query',
        description:
          "Download a repository export as CAR file. Optionally only a 'diff' since a previous revision. Does not require auth; implemented by PDS.",
        parameters: {
          type: 'params',
          required: ['did'],
          properties: {
            did: {
              type: 'string',
              format: 'did',
              description: 'The DID of the repo.',
            },
            since: {
              type: 'string',
              format: 'tid',
              description:
                "The revision ('rev') of the repo to create a diff from.",
            },
          },
        },
        output: {
          encoding: 'application/vnd.ipld.car',
        },
        errors: [
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
  ComAtprotoSyncGetRepoStatus: {
    lexicon: 1,
    id: 'com.atproto.sync.getRepoStatus',
    defs: {
      main: {
        type: 'query',
        description:
          'Get the hosting status for a repository, on this server. Expected to be implemented by PDS and Relay.',
        parameters: {
          type: 'params',
          required: ['did'],
          properties: {
            did: {
              type: 'string',
              format: 'did',
              description: 'The DID of the repo.',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['did', 'active'],
            properties: {
              did: {
                type: 'string',
                format: 'did',
              },
              active: {
                type: 'boolean',
              },
              status: {
                type: 'string',
                description:
                  'If active=false, this optional field indicates a possible reason for why the account is not active. If active=false and no status is supplied, then the host makes no claim for why the repository is no longer being hosted.',
                knownValues: [
                  'takendown',
                  'suspended',
                  'deleted',
                  'deactivated',
                  'desynchronized',
                  'throttled',
                ],
              },
              rev: {
                type: 'string',
                format: 'tid',
                description:
                  'Optional field, the current rev of the repo, if active=true',
              },
            },
          },
        },
        errors: [
          {
            name: 'RepoNotFound',
          },
        ],
      },
    },
  },
  ComAtprotoSyncListBlobs: {
    lexicon: 1,
    id: 'com.atproto.sync.listBlobs',
    defs: {
      main: {
        type: 'query',
        description:
          'List blob CIDs for an account, since some repo revision. Does not require auth; implemented by PDS.',
        parameters: {
          type: 'params',
          required: ['did'],
          properties: {
            did: {
              type: 'string',
              format: 'did',
              description: 'The DID of the repo.',
            },
            since: {
              type: 'string',
              format: 'tid',
              description: 'Optional revision of the repo to list blobs since.',
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
  GroupOpensocialCancelJoinRequest: {
    lexicon: 1,
    id: 'group.opensocial.cancelJoinRequest',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Withdraw the caller's pending join request. Requires service auth.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['group'],
            properties: {
              group: {
                type: 'string',
                format: 'did',
              },
            },
          },
        },
        errors: [
          {
            name: 'GroupNotFound',
          },
          {
            name: 'JoinRequestNotFound',
          },
        ],
      },
    },
  },
  GroupOpensocialCreateReport: {
    lexicon: 1,
    id: 'group.opensocial.createReport',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Report an account or record in a group, opening or reopening it in the moderation queue. The caller must be able to read the subject's space. Requires service auth.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['group', 'subject', 'reasonType'],
            properties: {
              group: {
                type: 'string',
                format: 'did',
              },
              subject: {
                type: 'string',
                format: 'uri',
                description: 'An account DID or record URI.',
              },
              cid: {
                type: 'string',
                format: 'cid',
                description: 'If set, a specific version of the record.',
              },
              reasonType: {
                type: 'string',
                knownValues: [
                  'spam',
                  'violation',
                  'misleading',
                  'nsfw',
                  'rude',
                  'other',
                ],
                description: 'For violation, cite the broken rule in rule.',
              },
              reason: {
                type: 'string',
                maxGraphemes: 2000,
                maxLength: 20000,
              },
              rule: {
                type: 'string',
                format: 'at-uri',
                description: 'The group rule the subject breaks.',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['id', 'createdAt'],
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: 512,
              },
              createdAt: {
                type: 'string',
                format: 'datetime',
              },
            },
          },
        },
        errors: [
          {
            name: 'GroupNotFound',
          },
          {
            name: 'InvalidSubject',
            description: "The subject isn't in this group.",
          },
        ],
      },
    },
  },
  GroupOpensocialDefs: {
    lexicon: 1,
    id: 'group.opensocial.defs',
    defs: {
      modSubjectView: {
        type: 'object',
        description: 'A subject in the moderation queue.',
        required: [
          'subject',
          'status',
          'createdAt',
          'updatedAt',
          'reportCount',
        ],
        properties: {
          subject: {
            type: 'string',
            format: 'uri',
            description: 'An account DID or record URI.',
          },
          cid: {
            type: 'string',
            format: 'cid',
            description: 'If set, a specific version of the record.',
          },
          status: {
            type: 'string',
            enum: ['open', 'escalated', 'resolved'],
          },
          createdAt: {
            type: 'string',
            format: 'datetime',
          },
          updatedAt: {
            type: 'string',
            format: 'datetime',
          },
          reportCount: {
            type: 'integer',
            minimum: 0,
          },
        },
      },
      moderationEvent: {
        type: 'object',
        description: "An event in a subject's moderation history.",
        required: ['id', 'createdAt', 'event'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
          },
          createdAt: {
            type: 'string',
            format: 'datetime',
          },
          createdBy: {
            type: 'string',
            format: 'did',
            description: 'May be withheld to protect reporters and moderators.',
          },
          event: {
            type: 'union',
            refs: [
              'lex:group.opensocial.defs#reportEvent',
              'lex:group.opensocial.defs#statusEvent',
              'lex:group.opensocial.defs#labelEvent',
              'lex:group.opensocial.defs#ejectEvent',
            ],
          },
        },
      },
      reportEvent: {
        type: 'object',
        description: 'A report was filed.',
        required: ['reasonType'],
        properties: {
          reasonType: {
            type: 'string',
            knownValues: [
              'spam',
              'violation',
              'misleading',
              'nsfw',
              'rude',
              'other',
            ],
          },
          reason: {
            type: 'string',
            maxGraphemes: 2000,
            maxLength: 20000,
          },
          rule: {
            type: 'string',
            format: 'at-uri',
          },
        },
      },
      statusEvent: {
        type: 'object',
        description:
          "A moderator changed the subject's status or added a note.",
        required: ['status'],
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'escalated', 'resolved'],
          },
          note: {
            type: 'string',
            maxGraphemes: 2000,
            maxLength: 20000,
          },
        },
      },
      labelEvent: {
        type: 'object',
        description: 'A label record was written or deleted.',
        required: ['uri', 'val'],
        properties: {
          uri: {
            type: 'string',
            format: 'at-uri',
            description: 'The label record.',
          },
          val: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          deleted: {
            type: 'boolean',
            default: false,
          },
        },
      },
      ejectEvent: {
        type: 'object',
        description: 'The subject was ejected from the group.',
        properties: {},
      },
      joinRequest: {
        type: 'object',
        description: 'A pending join request.',
        required: ['member', 'createdAt'],
        properties: {
          member: {
            type: 'string',
            format: 'did',
          },
          createdAt: {
            type: 'string',
            format: 'datetime',
          },
          message: {
            type: 'string',
            maxGraphemes: 2000,
            maxLength: 20000,
          },
        },
      },
    },
  },
  GroupOpensocialDenyJoinRequest: {
    lexicon: 1,
    id: 'group.opensocial.denyJoinRequest',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Deny a pending join request. To approve one, write the requester's membership instead. Requires auth as the group.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['member'],
            properties: {
              member: {
                type: 'string',
                format: 'did',
              },
            },
          },
        },
        errors: [
          {
            name: 'JoinRequestNotFound',
          },
        ],
      },
    },
  },
  GroupOpensocialGetModSubjectHistory: {
    lexicon: 1,
    id: 'group.opensocial.getModSubjectHistory',
    defs: {
      main: {
        type: 'query',
        description:
          "Get a subject's moderation history, oldest first. Requires auth as the group.",
        parameters: {
          type: 'params',
          required: ['subject'],
          properties: {
            subject: {
              type: 'string',
              format: 'uri',
              description: 'An account DID or record URI.',
            },
            cid: {
              type: 'string',
              format: 'cid',
              description: 'If set, only this version of the record.',
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
            required: ['events'],
            properties: {
              cursor: {
                type: 'string',
              },
              events: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:group.opensocial.defs#moderationEvent',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'InvalidSubject',
            description: "The subject isn't in this group.",
          },
          {
            name: 'InvalidCursor',
          },
        ],
      },
    },
  },
  GroupOpensocialLeaveGroup: {
    lexicon: 1,
    id: 'group.opensocial.leaveGroup',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Leave a group, deleting the caller's membership, which the group authored. Requires service auth.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['group'],
            properties: {
              group: {
                type: 'string',
                format: 'did',
              },
            },
          },
        },
        errors: [
          {
            name: 'GroupNotFound',
          },
        ],
      },
    },
  },
  GroupOpensocialListJoinRequests: {
    lexicon: 1,
    id: 'group.opensocial.listJoinRequests',
    defs: {
      main: {
        type: 'query',
        description:
          "List pending join requests, which the host stores privately. Approve one by writing the requester's membership. Requires auth as the group.",
        parameters: {
          type: 'params',
          properties: {
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
            required: ['requests'],
            properties: {
              cursor: {
                type: 'string',
              },
              requests: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:group.opensocial.defs#joinRequest',
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
    },
  },
  GroupOpensocialListModSubjects: {
    lexicon: 1,
    id: 'group.opensocial.listModSubjects',
    defs: {
      main: {
        type: 'query',
        description:
          'List subjects in the moderation queue. Requires auth as the group.',
        parameters: {
          type: 'params',
          properties: {
            status: {
              type: 'string',
              enum: ['open', 'escalated', 'resolved'],
              default: 'open',
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
            required: ['subjects'],
            properties: {
              cursor: {
                type: 'string',
              },
              subjects: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:group.opensocial.defs#modSubjectView',
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
    },
  },
  GroupOpensocialPolicy: {
    lexicon: 1,
    id: 'group.opensocial.policy',
    defs: {
      main: {
        type: 'object',
        description:
          "Space policy for group spaces: each role's access and scopes in the space, whether it is public, and whether it is listed in the space index. The host always publishes it in the space as a com.atproto.space.policy record.",
        required: ['grants'],
        properties: {
          publicRead: {
            type: 'boolean',
            default: false,
            description: 'If true, anyone may read the space.',
          },
          unlisted: {
            type: 'boolean',
            default: false,
            description:
              "If true, the host leaves the space out of the group's space index.",
          },
          grants: {
            type: 'array',
            maxLength: 100,
            description: 'At most one entry per role.',
            items: {
              type: 'ref',
              ref: 'lex:group.opensocial.policy#grant',
            },
          },
        },
      },
      grant: {
        type: 'object',
        description:
          "A role's grants in one space. read and write apply to members acting as themselves; scopes apply to acting as the group.",
        required: ['role'],
        properties: {
          role: {
            type: 'string',
            format: 'record-key',
            description: "A role record's key.",
          },
          read: {
            type: 'boolean',
            default: false,
            description: 'If true, members with this role may read the space.',
          },
          write: {
            type: 'boolean',
            default: false,
            description:
              "If true, members with this role are in the space's writer set, so their own records sync to readers.",
          },
          scopes: {
            type: 'array',
            maxLength: 100,
            description:
              'OAuth scopes for acting as the group in this space, one per item.',
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 2000,
            },
          },
        },
      },
    },
  },
  GroupOpensocialRequestJoin: {
    lexicon: 1,
    id: 'group.opensocial.requestJoin',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Request to join a group, optionally redeeming an invite. Admits the caller right away when the join policy is open or with a valid invite, and otherwise queues a request. Requires service auth.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['group'],
            properties: {
              group: {
                type: 'string',
                format: 'did',
              },
              invite: {
                type: 'string',
                format: 'at-uri',
                description: "An invite in the caller's invites space.",
              },
              message: {
                type: 'string',
                maxGraphemes: 2000,
                maxLength: 20000,
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['status'],
            properties: {
              status: {
                type: 'string',
                knownValues: ['pending', 'admitted'],
              },
              request: {
                type: 'ref',
                ref: 'lex:group.opensocial.defs#joinRequest',
                description: 'Present when pending.',
              },
              membership: {
                type: 'ref',
                ref: 'lex:com.atproto.repo.strongRef#main',
                description: 'Present when admitted.',
              },
            },
          },
        },
        errors: [
          {
            name: 'GroupNotFound',
          },
          {
            name: 'InvalidInvite',
          },
          {
            name: 'JoinClosed',
            description: 'The group is invite-only.',
          },
        ],
      },
    },
  },
  GroupOpensocialResolveModSubject: {
    lexicon: 1,
    id: 'group.opensocial.resolveModSubject',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Resolve or escalate a subject. Setting the current status again just adds the note. Requires auth as the group.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['subject', 'status'],
            properties: {
              subject: {
                type: 'string',
                format: 'uri',
                description: 'An account DID or record URI.',
              },
              cid: {
                type: 'string',
                format: 'cid',
                description: 'If set, a specific version of the record.',
              },
              status: {
                type: 'string',
                enum: ['resolved', 'escalated'],
              },
              note: {
                type: 'string',
                maxGraphemes: 2000,
                maxLength: 20000,
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'ref',
            ref: 'lex:group.opensocial.defs#modSubjectView',
          },
        },
        errors: [
          {
            name: 'InvalidSubject',
            description: "The subject isn't in this group.",
          },
          {
            name: 'SubjectNotFound',
            description: 'The subject has never been reported.',
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
          "Provisions Flock workspace modality spaces (new.flock.workspace/self, new.flock.inbox/self, and general new.flock.channel) inside an opensocial.group account using the operator's shared group-DID grant.",
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['name', 'operationId'],
            properties: {
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 640,
                maxGraphemes: 64,
              },
              operationId: {
                type: 'string',
                format: 'tid',
              },
              authority: {
                type: 'string',
                format: 'did',
                description:
                  'The opensocial.group DID created or reauthorized through startAuthorityFlow.',
              },
              joinPolicy: {
                type: 'string',
                knownValues: ['open', 'approval', 'invite'],
              },
              publicMeta: {
                type: 'boolean',
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
              groupDid: {
                type: 'string',
                format: 'did',
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
                  'aborted_actor_revoked',
                ],
              },
              completedSteps: {
                type: 'array',
                items: {
                  type: 'string',
                  maxLength: 128,
                },
              },
              takenOverBy: {
                type: 'string',
                format: 'did',
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
              'The operator holds no usable shared session for this group DID: start the authority flow, then retry with the same operation id.',
          },
          {
            name: 'OperationIdConflict',
          },
          {
            name: 'WorkspaceExists',
          },
          {
            name: 'Paused',
          },
          {
            name: 'Busy',
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
              'decideGroupJoinRequest',
              'leaveChannel',
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
          member: {
            type: 'string',
            format: 'did',
          },
          roles: {
            type: 'array',
            items: {
              type: 'string',
              format: 'record-key',
            },
            minLength: 1,
            maxLength: 64,
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
          expiresAt: {
            type: 'string',
            format: 'datetime',
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
              'aborted_actor_revoked',
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
          takenOverBy: {
            type: 'string',
            format: 'did',
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
  NewFlockOperatorGetSpaceNotifyTarget: {
    lexicon: 1,
    id: 'new.flock.operator.getSpaceNotifyTarget',
    defs: {
      main: {
        type: 'procedure',
        description:
          "Issue a stateless per-caller PDS webhook notification target for the caller's personal group.opensocial.invites/self space after verifying a valid space credential and RFC 9421 key possession proof.",
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
                ref: 'lex:new.flock.operator.getSpaceNotifyTarget#credentialProof',
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
            refreshRegistrations: {
              type: 'boolean',
              description:
                'When true, refreshes change-notice registrations across all active spaces of the workspace before reporting stalled work.',
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
          "Issues a single-use, two-minute ticket for the caller to create a new opensocial.group account (prompt=create) or reauthorize the operator's shared group-DID session as an active effective human admin.",
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
                maxLength: 640,
                maxGraphemes: 64,
                description:
                  'The group display name, for purpose createWorkspace.',
              },
              authority: {
                type: 'string',
                format: 'did',
                description:
                  'Existing group DID to reauthorize or complete workspace provisioning on.',
              },
              joinPolicy: {
                type: 'string',
                knownValues: ['open', 'approval', 'invite'],
              },
              publicMeta: {
                type: 'boolean',
              },
              creationKey: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
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
  ComAtprotoIdentityGetRecommendedDidCredentials:
    'com.atproto.identity.getRecommendedDidCredentials',
  ComAtprotoIdentityRequestPlcOperationSignature:
    'com.atproto.identity.requestPlcOperationSignature',
  ComAtprotoIdentityResolveHandle: 'com.atproto.identity.resolveHandle',
  ComAtprotoIdentitySignPlcOperation: 'com.atproto.identity.signPlcOperation',
  ComAtprotoIdentitySubmitPlcOperation:
    'com.atproto.identity.submitPlcOperation',
  ComAtprotoLabelDefs: 'com.atproto.label.defs',
  ComAtprotoManagedspaceCheckAccess: 'com.atproto.managedspace.checkAccess',
  ComAtprotoManagedspacePolicy: 'com.atproto.managedspace.policy',
  ComAtprotoMemberspaceDefs: 'com.atproto.memberspace.defs',
  ComAtprotoMemberspaceListMembers: 'com.atproto.memberspace.listMembers',
  ComAtprotoMemberspacePolicy: 'com.atproto.memberspace.policy',
  ComAtprotoMemberspacePutMembers: 'com.atproto.memberspace.putMembers',
  ComAtprotoMemberspaceRemoveMembers: 'com.atproto.memberspace.removeMembers',
  ComAtprotoPersonalspacePolicy: 'com.atproto.personalspace.policy',
  ComAtprotoRepoApplyWrites: 'com.atproto.repo.applyWrites',
  ComAtprotoRepoCreateRecord: 'com.atproto.repo.createRecord',
  ComAtprotoRepoDefs: 'com.atproto.repo.defs',
  ComAtprotoRepoDeleteRecord: 'com.atproto.repo.deleteRecord',
  ComAtprotoRepoDescribeRepo: 'com.atproto.repo.describeRepo',
  ComAtprotoRepoGetRecord: 'com.atproto.repo.getRecord',
  ComAtprotoRepoImportRepo: 'com.atproto.repo.importRepo',
  ComAtprotoRepoListMissingBlobs: 'com.atproto.repo.listMissingBlobs',
  ComAtprotoRepoListRecords: 'com.atproto.repo.listRecords',
  ComAtprotoRepoPutRecord: 'com.atproto.repo.putRecord',
  ComAtprotoRepoStrongRef: 'com.atproto.repo.strongRef',
  ComAtprotoRepoUploadBlob: 'com.atproto.repo.uploadBlob',
  ComAtprotoServerActivateAccount: 'com.atproto.server.activateAccount',
  ComAtprotoServerCheckAccountStatus: 'com.atproto.server.checkAccountStatus',
  ComAtprotoServerCreateAccount: 'com.atproto.server.createAccount',
  ComAtprotoServerDeactivateAccount: 'com.atproto.server.deactivateAccount',
  ComAtprotoServerDeleteAccount: 'com.atproto.server.deleteAccount',
  ComAtprotoServerDescribeServer: 'com.atproto.server.describeServer',
  ComAtprotoServerGetServiceAuth: 'com.atproto.server.getServiceAuth',
  ComAtprotoServerRefreshSession: 'com.atproto.server.refreshSession',
  ComAtprotoServerRequestAccountDelete:
    'com.atproto.server.requestAccountDelete',
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
  ComAtprotoSyncGetBlob: 'com.atproto.sync.getBlob',
  ComAtprotoSyncGetLatestCommit: 'com.atproto.sync.getLatestCommit',
  ComAtprotoSyncGetRepo: 'com.atproto.sync.getRepo',
  ComAtprotoSyncGetRepoStatus: 'com.atproto.sync.getRepoStatus',
  ComAtprotoSyncListBlobs: 'com.atproto.sync.listBlobs',
  GroupOpensocialCancelJoinRequest: 'group.opensocial.cancelJoinRequest',
  GroupOpensocialCreateReport: 'group.opensocial.createReport',
  GroupOpensocialDefs: 'group.opensocial.defs',
  GroupOpensocialDenyJoinRequest: 'group.opensocial.denyJoinRequest',
  GroupOpensocialGetModSubjectHistory: 'group.opensocial.getModSubjectHistory',
  GroupOpensocialLeaveGroup: 'group.opensocial.leaveGroup',
  GroupOpensocialListJoinRequests: 'group.opensocial.listJoinRequests',
  GroupOpensocialListModSubjects: 'group.opensocial.listModSubjects',
  GroupOpensocialPolicy: 'group.opensocial.policy',
  GroupOpensocialRequestJoin: 'group.opensocial.requestJoin',
  GroupOpensocialResolveModSubject: 'group.opensocial.resolveModSubject',
  NewFlockOperatorCreateWorkspace: 'new.flock.operator.createWorkspace',
  NewFlockOperatorExecute: 'new.flock.operator.execute',
  NewFlockOperatorGetChanges: 'new.flock.operator.getChanges',
  NewFlockOperatorGetDmNotifyTarget: 'new.flock.operator.getDmNotifyTarget',
  NewFlockOperatorGetOperation: 'new.flock.operator.getOperation',
  NewFlockOperatorGetSpaceNotifyTarget:
    'new.flock.operator.getSpaceNotifyTarget',
  NewFlockOperatorListStalledOperations:
    'new.flock.operator.listStalledOperations',
  NewFlockOperatorStartAuthorityFlow: 'new.flock.operator.startAuthorityFlow',
} as const
