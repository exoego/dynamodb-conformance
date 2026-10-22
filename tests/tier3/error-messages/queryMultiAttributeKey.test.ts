import {
  CreateTableCommand,
  DynamoDBServiceException,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { uniqueTableName, waitUntilActive, deleteTable } from '../../../src/helpers.js'

// Exact AWS strings for Query key conditions on a global secondary index whose
// key is one HASH attribute and four RANGE attributes (multi-attribute keys),
// pinned against real AWS (eu-west-2, October 2026).
// tests/tier2/multiAttributeKeys/query.test.ts covers which conditions run.
//
// The message names the RANGE attribute that lacks an equality and the
// attribute whose condition needed it.
//
// The table is created here rather than from a shared def: TestTableDef models
// one RANGE attribute per index.
describe('Query - multi-attribute GSI key exact error messages', { tags: ['query', 'gsi', 'data-plane', 'negative-path'] }, () => {
  const tableName = uniqueTableName('multiKeyGsiMsg')
  const indexName = 'gsi'
  const needsEquality = (missing: string, present: string) =>
    `RANGE key attributes ${missing} must have equality conditions specified in the query because a condition is present on key attribute ${present}`

  const values: Record<string, AttributeValue> = {
    ':h': { S: 'o1' }, ':a': { S: 'T' }, ':b': { S: 'live' }, ':c': { S: 'a' },
  }

  beforeAll(async () => {
    await ddb.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: ['pk', 'h', 'a', 'b', 'c', 'd'].map((n) => ({ AttributeName: n, AttributeType: 'S' })),
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [{
        IndexName: indexName,
        KeySchema: [
          { AttributeName: 'h', KeyType: 'HASH' },
          { AttributeName: 'a', KeyType: 'RANGE' },
          { AttributeName: 'b', KeyType: 'RANGE' },
          { AttributeName: 'c', KeyType: 'RANGE' },
          { AttributeName: 'd', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      }],
    }))
    await waitUntilActive(tableName)
  })

  afterAll(async () => {
    await deleteTable(tableName)
  })

  /** Query the index and hand back the exception it raises. */
  async function rejection(KeyConditionExpression: string) {
    const used = Object.fromEntries(Object.entries(values).filter(([k]) => KeyConditionExpression.includes(k)))
    try {
      await ddb.send(new QueryCommand({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression,
        ExpressionAttributeValues: used,
      }))
      expect.unreachable('should have thrown')
      throw new Error('unreachable')
    } catch (err) {
      if (err instanceof DynamoDBServiceException) return err
      throw err
    }
  }

  async function expectMessage(KeyConditionExpression: string, message: string) {
    const err = await rejection(KeyConditionExpression)
    expect(err.name).toBe('ValidationException')
    expect(err.message).toBe(message)
  }

  it('a gap in the RANGE attributes - exact message', async () => {
    await expectMessage('h = :h AND a = :a AND c = :c', needsEquality('b', 'c'))
  })

  it('a range condition before the last attribute named - exact message', async () => {
    await expectMessage('h = :h AND a = :a AND b > :b AND c = :c', needsEquality('b', 'c'))
  })

  it('skipping the first RANGE attribute - exact message', async () => {
    await expectMessage('h = :h AND b = :b', needsEquality('a', 'b'))
  })
})
