import {
  ScanCommand,
  DynamoDBServiceException,
} from '@aws-sdk/client-dynamodb'
import { ddb } from '../../../src/client.js'
import { declareTables, hashTableDef } from '../../../src/helpers.js'

declareTables(hashTableDef)

describe('Scan — validation ordering', { tags: ['scan', 'data-plane', 'negative-path'] }, () => {
  it('rejects Segment without TotalSegments', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          Segment: 0,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain('Segment')
      expect(err.message).toContain('TotalSegments')
    }
  })

  it('rejects Segment >= TotalSegments', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          Segment: 5,
          TotalSegments: 5,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain('Segment')
      expect(err.message).toContain('TotalSegments')
    }
  })

  it('rejects TotalSegments without Segment', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          TotalSegments: 4,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      expect(err.message).toContain('Segment')
      expect(err.message).toContain('TotalSegments')
    }
  })

  it('rejects a negative Segment', async () => {
    try {
      await ddb.send(
        new ScanCommand({
          TableName: hashTableDef.name,
          Segment: -1,
          TotalSegments: 4,
        }),
      )
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(DynamoDBServiceException)
      const err = e as DynamoDBServiceException
      expect(err.name).toBe('ValidationException')
      // The rollout that reached Scan in September 2026 answers
      // `Value at 'Segment'` where older regions say `Value '-1' at 'segment'`.
      // Which one a region gives is not this tier's business: the exact
      // wording is pinned in the error-messages tier under registry row
      // scan-segment-negative-message. Matching the quoted member name
      // case-insensitively spans both, and keeps TotalSegments from
      // satisfying it.
      expect(err.message).toMatch(/at 'segment'/i)
      expect(err.message).toContain('greater than or equal to 0')
    }
  })
})
