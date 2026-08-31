import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastify from 'fastify'
import { registerSchemas } from './group.ts'
import { GROUP_RULE_MATCH_VALUES } from '../../models/groups.ts'

/**
 * Task 2116: the `GroupRule` schema's `match` enum has to agree, member-for-member, with the
 * `GroupRuleMatch` union in `models/groups.ts` -- that union gained `CLASSIFICATION` but the ajv
 * `enum` here was never updated to match, so any `PUT /_api/groups/:groupId` body containing a
 * `CLASSIFICATION` rule failed validation with a 400. `GROUP_RULE_MATCH_VALUES` is now the single
 * source both sides read from, but this test reads the *registered* schema back out of Fastify
 * (rather than re-importing the same constant the schema itself imports) so it actually fails if the
 * schema registration ever stops using it -- e.g. someone restates the enum as a literal array again.
 */
test('the GroupRule schema match enum agrees with GroupRuleMatch member-for-member', async () => {
  const app = fastify()
  await registerSchemas(app)
  await app.ready()

  const groupRuleSchema = app.getSchema('GroupRule') as any

  assert.deepEqual(
    [...groupRuleSchema.properties.match.enum].sort(),
    [...GROUP_RULE_MATCH_VALUES].sort()
  )

  await app.close()
})

test('the GroupRule schema declares classifications as an array of uuid strings', async () => {
  const app = fastify()
  await registerSchemas(app)
  await app.ready()

  const groupRuleSchema = app.getSchema('GroupRule') as any

  assert.equal(groupRuleSchema.properties.classifications.type, 'array')
  assert.deepEqual(groupRuleSchema.properties.classifications.items, {
    type: 'string',
    format: 'uuid'
  })

  await app.close()
})
