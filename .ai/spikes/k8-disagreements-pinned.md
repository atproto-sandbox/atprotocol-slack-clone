| collection | family | class | count | lexicon verdict | hand verdict | example |
|---|---|---|---|---|---|---|
| acceptance | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| acceptance | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| acceptance | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: acceptance key must match its workspace | record key is not the canonical derived key |
| acceptance | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| acceptance | space type of reference | hand-stricter/SEMANTIC | 1 | accept | reject: acceptance key must match its workspace | workspace field names a channel space, not a workspace space |
| acceptance | space-ref | hand-stricter/SEMANTIC | 1 | accept | reject: acceptance key must match its workspace | workspace: valid space ref of another space type |
| acceptance | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid acceptance timestamp | createdAt: leap second :60 |
| acceptance | extra field | hand-stricter/SHAPE | 2 | accept | reject: acceptance record has unknown fields | unknown extra field 'note' |
| acceptance | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| acceptance | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| admin | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| admin | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| admin | author | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | authority collection written by a non-authority account |
| admin | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: roster key must equal the subject hash | record key is not the canonical derived key |
| admin | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| admin | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid roster state | updatedAt: leap second :60 |
| admin | did | hand-stricter/SHAPE | 3 | accept | reject: roster key must equal the subject hash | subject: id of 513 chars |
| admin | extra field | hand-stricter/SHAPE | 2 | accept | reject: roster record has unknown fields | unknown extra field 'note' |
| admin | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| admin | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/updatedAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | updatedAt: -00:00 offset |
| admin | did | lexicon-stricter/SHAPE | 3 | reject: Record/subject must be a valid did | accept | subject: method contains a digit |
| channel.message | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| channel.message | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| channel.message | at-uri | hand-stricter/SEMANTIC | 5 | accept | reject: parent must be a canonical message URI in this channel | parent: record URI in another space |
| channel.message | derived key | hand-stricter/SEMANTIC | 2 | accept | reject: message key must be a TID | record key is not the canonical derived key |
| channel.message | known-message reference | hand-stricter/SEMANTIC | 1 | accept | reject: parent message is not in this channel | parent is a well-formed message URI that is not in the channel |
| channel.message | nested reply | hand-stricter/SEMANTIC | 1 | accept | reject: nested replies are not supported | parent is itself a reply |
| channel.message | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: nested replies are not supported | message: nested parent |
| channel.message | same-space reference | hand-stricter/SEMANTIC | 2 | accept | reject: parent must be a canonical message URI in this channel | parent is in another channel |
| channel.message | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| channel.message | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid message timestamp | createdAt: leap second :60 |
| channel.message | extra field | hand-stricter/SHAPE | 2 | accept | reject: message has unknown fields | unknown extra field 'note' |
| channel.message | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| channel.message | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| channel.message | records.test.ts | lexicon-stricter/SHAPE | 1 | reject: Record/text must not be longer than 10000 characters | accept | message: 10000 emoji |
| channel.message | text length | lexicon-stricter/SHAPE | 10 | reject: Record/text must not be longer than 10000 characters | accept | text: e-acute U+00E9 (2 B) x5001 (lexicon byte limit+1): "éééééé"… len=5001u/5001cp/5001g/10002B |
| channel.reaction | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| channel.reaction | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| channel.reaction | at-uri | hand-stricter/SEMANTIC | 5 | accept | reject: reaction target is not a message in this channel | subject: record URI in another space |
| channel.reaction | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: reaction key is not canonical | record key is not the canonical derived key |
| channel.reaction | known-message reference | hand-stricter/SEMANTIC | 1 | accept | reject: reaction target is not a message in this channel | reaction target is not a known message |
| channel.reaction | same-space reference | hand-stricter/SEMANTIC | 1 | accept | reject: reaction target is not a message in this channel | reaction target is a message in another channel |
| channel.reaction | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| channel.reaction | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid reaction fields | createdAt: leap second :60 |
| channel.reaction | extra field | hand-stricter/SHAPE | 2 | accept | reject: reaction has unknown fields | unknown extra field 'note' |
| channel.reaction | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| channel.reaction | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| channel.reaction | text length | lexicon-stricter/SHAPE | 9 | reject: Record/emoji must not be longer than 32 characters | accept | emoji: e-acute U+00E9 (2 B) x17 (lexicon byte limit+1): "éééééé"… len=17u/17cp/17g/34B |
| channel.roster | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| channel.roster | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| channel.roster | author | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | authority collection written by a non-authority account |
| channel.roster | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: roster key must equal the subject hash | record key is not the canonical derived key |
| channel.roster | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| channel.roster | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid roster state | updatedAt: leap second :60 |
| channel.roster | did | hand-stricter/SHAPE | 3 | accept | reject: roster key must equal the subject hash | subject: id of 513 chars |
| channel.roster | extra field | hand-stricter/SHAPE | 2 | accept | reject: roster record has unknown fields | unknown extra field 'note' |
| channel.roster | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| channel.roster | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/updatedAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | updatedAt: -00:00 offset |
| channel.roster | did | lexicon-stricter/SHAPE | 3 | reject: Record/subject must be a valid did | accept | subject: method contains a digit |
| directory | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| directory | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| directory | author | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | authority collection written by a non-authority account |
| directory | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: directory key must equal skey | record key is not the canonical derived key |
| directory | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | directory in a channel space |
| directory | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| directory | extra field | hand-stricter/SHAPE | 2 | accept | reject: directory record has unknown fields | unknown extra field 'note' |
| directory | knownValues | hand-stricter/SHAPE | 4 | accept | reject: invalid channel visibility | visibility = "bogus" |
| directory | skey syntax | hand-stricter/SHAPE | 9 | accept | reject: directory key must equal skey | skey: 64x e-acute (128 B, 64 chars) |
| directory | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| directory | text length | lexicon-stricter/SHAPE | 10 | reject: Record/name must not be longer than 80 characters | accept | name: e-acute U+00E9 (2 B) x41 (lexicon byte limit+1): "éééééé"… len=41u/41cp/41g/82B |
| dm.declaration | datetime | hand-stricter/SHAPE | 1 | accept | reject: invalid DM declaration timestamp | createdAt: no timezone |
| dm.declaration | extra field | hand-stricter/SHAPE | 1 | accept | reject: DM declaration has unknown fields | unknown extra field 'mode' |
| dm.declaration | records.test.ts | hand-stricter/SHAPE | 1 | accept | reject: DM declaration has unknown fields | declaration: extra field |
| dm.header | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| dm.header | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| dm.header | author | hand-stricter/SEMANTIC | 1 | accept | reject: DM header must be authored by the half owner | header authored by someone other than the half owner |
| dm.header | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: DM header conversation key must equal the half key | header convKey differs from the half's key |
| dm.header | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: DM header key must be self | record key is not the canonical derived key |
| dm.header | participants | hand-stricter/SEMANTIC | 1 | accept | reject: DM header participants must include the half owner | participants omit the half owner |
| dm.header | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM header conversation key must equal the half key | dm.header: convKey differs from half |
| dm.header | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM header key must be self | dm.header: rkey not self |
| dm.header | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM header must be authored by the half owner | dm.header: member author |
| dm.header | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM header must be scoped to a conversation half | dm.header: half key not a TID |
| dm.header | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM header participants must include the half owner | dm.header: participants omit the owner |
| dm.header | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| dm.header | array | hand-stricter/SHAPE | 3 | accept | reject: DM header participants must be canonical | participants: unsorted pair |
| dm.header | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid DM header timestamp | createdAt: leap second :60 |
| dm.header | extra field | hand-stricter/SHAPE | 2 | accept | reject: DM header has unknown fields | unknown extra field 'note' |
| dm.header | records.test.ts | hand-stricter/SHAPE | 1 | accept | reject: DM header has unknown fields | dm.header: extra field |
| dm.header | records.test.ts | hand-stricter/SHAPE | 1 | accept | reject: DM header participants must be canonical | dm.header: participants reversed |
| dm.header | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| dm.header | array | lexicon-stricter/SHAPE | 1 | reject: Record/participants/2 must be a valid did | accept | participants: sorted, one DID whose method has a digit |
| dm.header | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| dm.header | tid | lexicon-stricter/SHAPE | 2 | reject: Record/convKey must be a valid TID | accept | convKey: first char k |
| dm.message | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| dm.message | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| dm.message | at-uri | hand-stricter/SEMANTIC | 4 | accept | reject: parent must be a canonical DM message URI | parent: same space, wrong collection segment |
| dm.message | at-uri | hand-stricter/SEMANTIC | 1 | accept | reject: parent must be a message in this conversation | parent: record URI in another space |
| dm.message | author | hand-stricter/SEMANTIC | 1 | accept | reject: DM message must be authored by the half owner | message authored by someone other than the half owner |
| dm.message | derived key | hand-stricter/SEMANTIC | 2 | accept | reject: DM message key must be a TID | record key is not the canonical derived key |
| dm.message | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM message key must be a TID | dm.message: rkey not a TID |
| dm.message | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM message must be authored by the half owner | dm.message: member author |
| dm.message | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM message must be scoped to a conversation half | dm.message: half key not a TID |
| dm.message | records.test.ts | hand-stricter/SEMANTIC | 2 | accept | reject: parent must be a canonical DM message URI | dm.message: parent rkey not a TID |
| dm.message | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: parent must be a message from a conversation participant | dm.message: parent owner not in participants |
| dm.message | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: parent must be a message in this conversation | dm.message: parent in another conversation |
| dm.message | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: parent must not be the message itself | dm.message: parent is itself |
| dm.message | same-conversation reference | hand-stricter/SEMANTIC | 1 | accept | reject: parent must be a canonical DM message URI | parent is from a non-participant |
| dm.message | same-conversation reference | hand-stricter/SEMANTIC | 1 | accept | reject: parent must be a message in this conversation | parent is in another conversation |
| dm.message | same-conversation reference | hand-stricter/SEMANTIC | 1 | accept | reject: parent must not be the message itself | parent is the message itself |
| dm.message | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| dm.message | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid DM message timestamp | createdAt: leap second :60 |
| dm.message | extra field | hand-stricter/SHAPE | 2 | accept | reject: DM message has unknown fields | unknown extra field 'note' |
| dm.message | records.test.ts | hand-stricter/SHAPE | 1 | accept | reject: DM message has unknown fields | dm.message: extra field |
| dm.message | records.test.ts | hand-stricter/SHAPE | 2 | accept | reject: DM message text must contain 1 to 10000 Unicode code points | dm.message: empty text |
| dm.message | text length | hand-stricter/SHAPE | 8 | accept | reject: DM message text must contain 1 to 10000 Unicode code points | text: e+U+0301 (1 grapheme, 2 cp) x5001 (hand limit+1): "ééé"… len=10002u/10002cp/5001g/15003B |
| dm.message | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| dm.message | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| dm.reaction | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| dm.reaction | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| dm.reaction | at-uri | hand-stricter/SEMANTIC | 5 | accept | reject: reaction target is not a DM message in this conversation | subject: record URI in another space |
| dm.reaction | author | hand-stricter/SEMANTIC | 1 | accept | reject: DM reaction must be authored by the half owner | reaction authored by someone other than the half owner |
| dm.reaction | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: reaction key is not canonical | record key is not the canonical derived key |
| dm.reaction | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM reaction must be authored by the half owner | dm.reaction: member author |
| dm.reaction | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM reaction must be scoped to a conversation half | dm.reaction: half key not a TID |
| dm.reaction | records.test.ts | hand-stricter/SEMANTIC | 2 | accept | reject: reaction key is not canonical | dm.reaction: key built for another author |
| dm.reaction | records.test.ts | hand-stricter/SEMANTIC | 2 | accept | reject: reaction target is not a DM message in this conversation | dm.reaction: subject rkey not a TID |
| dm.reaction | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: reaction target must be a message from a conversation participant | dm.reaction: participants omit target owner |
| dm.reaction | same-conversation reference | hand-stricter/SEMANTIC | 2 | accept | reject: reaction target is not a DM message in this conversation | target is in another conversation |
| dm.reaction | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| dm.reaction | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid reaction fields | createdAt: leap second :60 |
| dm.reaction | extra field | hand-stricter/SHAPE | 2 | accept | reject: DM reaction has unknown fields | unknown extra field 'note' |
| dm.reaction | records.test.ts | hand-stricter/SHAPE | 1 | accept | reject: DM reaction has unknown fields | dm.reaction: extra field |
| dm.reaction | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| dm.reaction | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| dm.reaction | text length | lexicon-stricter/SHAPE | 9 | reject: Record/emoji must not be longer than 32 characters | accept | emoji: e-acute U+00E9 (2 B) x17 (lexicon byte limit+1): "éééééé"… len=17u/17cp/17g/34B |
| dm.request | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| dm.request | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| dm.request | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: DM request key must equal its conversation key | record key is not the canonical derived key |
| dm.request | participants | hand-stricter/SEMANTIC | 2 | accept | reject: DM request participants must include the sender and the inbox owner | participants omit the sender |
| dm.request | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | dm.request: channel space |
| dm.request | records.test.ts | hand-stricter/SEMANTIC | 2 | accept | reject: DM request key must equal its conversation key | dm.request: rkey differs from convKey |
| dm.request | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: DM request must be scoped to a DM inbox space | dm.request: inbox skey not self |
| dm.request | records.test.ts | hand-stricter/SEMANTIC | 2 | accept | reject: DM request participants must include the sender and the inbox owner | dm.request: participants omit the owner |
| dm.request | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| dm.request | array | hand-stricter/SHAPE | 3 | accept | reject: DM request participants must be canonical | participants: unsorted pair |
| dm.request | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid DM request timestamp | createdAt: leap second :60 |
| dm.request | extra field | hand-stricter/SHAPE | 2 | accept | reject: DM request has unknown fields | unknown extra field 'note' |
| dm.request | records.test.ts | hand-stricter/SHAPE | 1 | accept | reject: DM request has unknown fields | dm.request: extra field |
| dm.request | records.test.ts | hand-stricter/SHAPE | 2 | accept | reject: DM request participants must be canonical | dm.request: participants reversed |
| dm.request | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| dm.request | array | lexicon-stricter/SHAPE | 1 | reject: Record/participants/2 must be a valid did | accept | participants: sorted, one DID whose method has a digit |
| dm.request | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| dm.request | tid | lexicon-stricter/SHAPE | 2 | reject: Record/convKey must be a valid TID | accept | convKey: first char k |
| joinDecision | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| joinDecision | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| joinDecision | at-uri | hand-stricter/SEMANTIC | 5 | accept | reject: join decision key must match a canonical request in this inbox | request: record URI in another space |
| joinDecision | author | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | authority collection written by a non-authority account |
| joinDecision | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: join decision key must match a canonical request in this inbox | record key is not the canonical derived key |
| joinDecision | same-space reference | hand-stricter/SEMANTIC | 2 | accept | reject: join decision key must match a canonical request in this inbox | decision names a request authored by the authority |
| joinDecision | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| joinDecision | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid join decision fields | updatedAt: leap second :60 |
| joinDecision | extra field | hand-stricter/SHAPE | 2 | accept | reject: join decision has unknown fields | unknown extra field 'note' |
| joinDecision | knownValues | hand-stricter/SHAPE | 4 | accept | reject: invalid join decision fields | decision = "bogus" |
| joinDecision | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| joinDecision | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/updatedAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | updatedAt: -00:00 offset |
| joinDecision | tid | lexicon-stricter/SHAPE | 2 | reject: Record/requestId must be a valid TID | accept | requestId: first char k |
| joinRequest | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| joinRequest | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| joinRequest | derived key | hand-stricter/SEMANTIC | 2 | accept | reject: join request key is not canonical | record key is not the canonical derived key |
| joinRequest | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| joinRequest | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid join request fields | createdAt: leap second :60 |
| joinRequest | extra field | hand-stricter/SHAPE | 2 | accept | reject: join request has unknown fields | unknown extra field 'note' |
| joinRequest | skey syntax | hand-stricter/SHAPE | 9 | accept | reject: invalid join request fields | channelSkey: 64x e-acute (128 B, 64 chars) |
| joinRequest | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| joinRequest | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| joinRequest | tid | lexicon-stricter/SHAPE | 2 | reject: Record/requestId must be a valid TID | accept | requestId: first char k |
| workspace.profile | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| workspace.profile | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| workspace.profile | author | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | authority collection written by a non-authority account |
| workspace.profile | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: invalid workspace profile | record key is not the canonical derived key |
| workspace.profile | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | profile: member author |
| workspace.profile | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: invalid workspace profile | profile: key other |
| workspace.profile | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| workspace.profile | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid workspace profile | createdAt: leap second :60 |
| workspace.profile | extra field | hand-stricter/SHAPE | 2 | accept | reject: workspace profile has unknown fields | unknown extra field 'note' |
| workspace.profile | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| workspace.profile | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | createdAt: -00:00 offset |
| workspace.profile | text length | lexicon-stricter/SHAPE | 10 | reject: Record/name must not be longer than 80 characters | accept | name: e-acute U+00E9 (2 B) x41 (lexicon byte limit+1): "éééééé"… len=41u/41cp/41g/82B |
| workspace.roster | $type | hand-stricter/ENVELOPE | 1 | accept | reject: record type does not match its collection | $type is 'lex:<nsid>' |
| workspace.roster | prototype | hand-stricter/ENVELOPE | 1 | accept | reject: record must be an object | class instance with the record's fields (JS only) |
| workspace.roster | author | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | authority collection written by a non-authority account |
| workspace.roster | derived key | hand-stricter/SEMANTIC | 1 | accept | reject: roster key must equal the subject hash | record key is not the canonical derived key |
| workspace.roster | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: authority record has the wrong author | roster: member author |
| workspace.roster | records.test.ts | hand-stricter/SEMANTIC | 1 | accept | reject: roster key must equal the subject hash | roster: wrong key |
| workspace.roster | space type | hand-stricter/SEMANTIC | 1 | accept | reject: collection does not belong to this space type | collection written into a space of another type |
| workspace.roster | datetime | hand-stricter/SHAPE | 5 | accept | reject: invalid roster state | updatedAt: leap second :60 |
| workspace.roster | did | hand-stricter/SHAPE | 3 | accept | reject: roster key must equal the subject hash | subject: id of 513 chars |
| workspace.roster | extra field | hand-stricter/SHAPE | 2 | accept | reject: roster record has unknown fields | unknown extra field 'note' |
| workspace.roster | $type | lexicon-stricter/ENVELOPE | 2 | reject: Record/$type must be a string | accept | no $type, not injected before lexicon check |
| workspace.roster | datetime | lexicon-stricter/SHAPE | 1 | reject: Record/updatedAt must be an valid atproto datetime (both RFC-3339 and ISO-8601) | accept | updatedAt: -00:00 offset |
| workspace.roster | did | lexicon-stricter/SHAPE | 3 | reject: Record/subject must be a valid did | accept | subject: method contains a digit |