import {
  Filter,
  BoosterConfig,
  Logger,
  InvalidParameterError,
  EventFilter,
  EventEnvelope,
  EventSearchResponse,
  EventInterface,
  UUID,
} from '@boostercloud/framework-types'
import { DynamoDB } from 'aws-sdk'
import { DocumentClient } from 'aws-sdk/lib/dynamodb/document_client'
import ExpressionAttributeValueMap = DocumentClient.ExpressionAttributeValueMap
import ExpressionAttributeNameMap = DocumentClient.ExpressionAttributeNameMap
import { eventsStoreAttributes } from '../constants'
import { partitionKeyForEvent } from './partition-keys'

export async function searchEvents(
  dynamoDB: DynamoDB.DocumentClient,
  config: BoosterConfig,
  logger: Logger,
  filters: EventFilter
): Promise<Array<EventSearchResponse>> {
  logger.debug('Initiating an events search. Filters: ', filters)
  const timeFilterQuery = buildSearchEventsTimeQuery(filters.from, filters.to)
  let eventEnvelopes: Array<EventEnvelope> = []
  if ('entity' in filters) {
    if (filters.entityID) {
      eventEnvelopes = await searchEventsByEntityAndID(
        dynamoDB,
        config,
        logger,
        filters.entity,
        filters.entityID,
        timeFilterQuery
      )
    } else {
      eventEnvelopes = await searchEventsByEntity(dynamoDB, config, logger, filters.entity, timeFilterQuery)
    }
  } else if ('type' in filters) {
    eventEnvelopes = await searchEventsByType(dynamoDB, config, logger, filters.type, timeFilterQuery)
  } else {
    throw new Error('Invalid search event query. It is neither an search by "entity" nor a search by "type"')
  }

  logger.debug('Events search result: ', eventEnvelopes)

  const eventSearchResults: Array<EventSearchResponse> = eventEnvelopes
    .map((eventEnvelope) => {
      return {
        type: eventEnvelope.typeName,
        entity: eventEnvelope.entityTypeName,
        entityID: eventEnvelope.entityID,
        requestID: eventEnvelope.requestID,
        user: eventEnvelope.currentUser,
        createdAt: eventEnvelope.createdAt,
        value: eventEnvelope.value as EventInterface,
      }
    })
    .sort()
    .reverse()
  return eventSearchResults
}

interface TimeQueryData {
  expression: string
  attributeValues: Record<string, string>
}

function buildSearchEventsTimeQuery(from?: string, to?: string): TimeQueryData {
  let timeQueryData: TimeQueryData = {
    expression: '',
    attributeValues: {},
  }
  if (from && to) {
    timeQueryData = {
      expression: ` AND ${eventsStoreAttributes.sortKey} BETWEEN :fromTime AND :toTime`,
      attributeValues: {
        ':fromTime': from,
        ':toTime': to,
      },
    }
  } else if (from) {
    timeQueryData = {
      expression: ` AND ${eventsStoreAttributes.sortKey} >= :fromTime`,
      attributeValues: { ':fromTime': from },
    }
  } else if (to) {
    timeQueryData = {
      expression: ` AND ${eventsStoreAttributes.sortKey} <= :toTime`,
      attributeValues: { ':toTime': to },
    }
  }
  return timeQueryData
}

async function searchEventsByEntityAndID(
  dynamoDB: DynamoDB.DocumentClient,
  config: BoosterConfig,
  logger: Logger,
  entity: string,
  entityID: UUID,
  timeQuery: TimeQueryData
): Promise<Array<EventEnvelope>> {
  // TODO: Manage pagination
  const params: DocumentClient.QueryInput = {
    TableName: config.resourceNames.eventsStore,
    ConsistentRead: true,
    ScanIndexForward: false, // Descending order (newer timestamps first)
    KeyConditionExpression: `${eventsStoreAttributes.partitionKey} = :partitionKey ${timeQuery.expression}`,
    ExpressionAttributeValues: {
      ...timeQuery.attributeValues,
      ':partitionKey': partitionKeyForEvent(entity, entityID),
    },
  }

  logger.debug('Searching events by entity and entity ID. Query params: ', params)
  const result = await dynamoDB.query(params).promise()
  return (result.Items as Array<EventEnvelope>) ?? []
}

interface EventStoreKeys {
  [eventsStoreAttributes.partitionKey]: string
  [eventsStoreAttributes.sortKey]: string
}

async function searchEventsByEntity(
  dynamoDB: DynamoDB.DocumentClient,
  config: BoosterConfig,
  logger: Logger,
  entity: string,
  timeQuery: TimeQueryData
): Promise<Array<EventEnvelope>> {
  // TODO: manage pagination
  // Fist query the index
  const params: DocumentClient.QueryInput = {
    TableName: config.resourceNames.eventsStore,
    IndexName: eventsStoreAttributes.indexByEntity.name(config),
    ConsistentRead: true,
    ScanIndexForward: false, // Descending order (newer timestamps first)
    KeyConditionExpression: `${eventsStoreAttributes.indexByEntity.partitionKey} = :partitionKey ${timeQuery.expression}`,
    ExpressionAttributeValues: {
      ...timeQuery.attributeValues,
      ':partitionKey': entity,
    },
  }

  logger.debug('Searching events by entity. Index query params: ', params)
  const partialResult = await dynamoDB.query(params).promise()
  const indexRecords = (partialResult.Items as Array<EventStoreKeys>) ?? []
  console.log(indexRecords)

  // Now query the table to get all data
  const paramss: DocumentClient.BatchGetItemInput = {
    RequestItems: {
      [config.resourceNames.eventsStore]: {
        ConsistentRead: true,
        Keys: indexRecords.map((record) => {
          return {
            [eventsStoreAttributes.partitionKey]: record[eventsStoreAttributes.partitionKey],
            [eventsStoreAttributes.sortKey]: record[eventsStoreAttributes.sortKey],
          }
        }),
      },
    },
  }

  logger.debug('Searching events by entity. Final query params: ', params)
  const result = await dynamoDB.batchGet(paramss).promise()
  return (result.Responses?.[config.resourceNames.eventsStore] as Array<EventEnvelope>) ?? []
}

async function searchEventsByType(
  dynamoDB: DynamoDB.DocumentClient,
  config: BoosterConfig,
  logger: Logger,
  type: string,
  timeQuery: TimeQueryData
): Promise<Array<EventEnvelope>> {
  return Promise.resolve([])
}

export async function searchReadModel(
  dynamoDB: DynamoDB.DocumentClient,
  config: BoosterConfig,
  logger: Logger,
  readModelName: string,
  filters: Record<string, Filter<any>>
): Promise<Array<any>> {
  let params: DocumentClient.ScanInput = {
    TableName: config.resourceNames.forReadModel(readModelName),
    ConsistentRead: true,
  }
  if (filters && Object.keys(filters).length > 0) {
    params = {
      ...params,
      FilterExpression: buildFilterExpression(filters),
      ExpressionAttributeNames: buildExpressionAttributeNames(filters),
      ExpressionAttributeValues: buildExpressionAttributeValues(filters),
    }
  }
  logger.debug('Running search with the following params: \n', params)

  const result = await dynamoDB.scan(params).promise()

  logger.debug('Search result: ', result.Items)

  return result.Items ?? []
}

function buildFilterExpression(filters: Record<string, Filter<any>>): string {
  return Object.entries(filters)
    .map(([propName, filter]) => buildOperation(propName, filter))
    .join(' AND ')
}

function buildOperation(propName: string, filter: Filter<any>): string {
  const holder = placeholderBuilderFor(propName)
  switch (filter.operation) {
    case '=':
      return `#${propName} = ${holder(0)}`
    case '!=':
      return `#${propName} <> ${holder(0)}`
    case '<':
      return `#${propName} < ${holder(0)}`
    case '>':
      return `#${propName} > ${holder(0)}`
    case '>=':
      return `#${propName} >= ${holder(0)}`
    case '<=':
      return `#${propName} <= ${holder(0)}`
    case 'in':
      return `#${propName} IN (${filter.values.map((value, index) => holder(index)).join(',')})`
    case 'between':
      return `#${propName} BETWEEN ${holder(0)} AND ${holder(1)}`
    case 'contains':
      return `contains(#${propName}, ${holder(0)})`
    case 'not-contains':
      return `NOT contains(#${propName}, ${holder(0)})`
    case 'begins-with':
      return `begins_with(#${propName}, ${holder(0)})`
    default:
      throw new InvalidParameterError(`Operator "${filter.operation}" is not supported`)
  }
}

function placeholderBuilderFor(propName: string): (valueIndex: number) => string {
  return (valueIndex: number) => `:${propName}_${valueIndex}`
}

function buildExpressionAttributeNames(filters: Record<string, Filter<any>>): ExpressionAttributeNameMap {
  const attributeNames: ExpressionAttributeNameMap = {}
  for (const propName in filters) {
    attributeNames[`#${propName}`] = propName
  }
  return attributeNames
}

function buildExpressionAttributeValues(filters: Record<string, Filter<any>>): ExpressionAttributeValueMap {
  const attributeValues: ExpressionAttributeValueMap = {}
  for (const propName in filters) {
    const filter = filters[propName]
    const holder = placeholderBuilderFor(propName)
    filter.values.forEach((value, index) => {
      attributeValues[holder(index)] = value
    })
  }
  return attributeValues
}
