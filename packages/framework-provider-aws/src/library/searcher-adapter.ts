import {
  Filter,
  BoosterConfig,
  Logger,
  InvalidParameterError,
  EventFilter,
  EventEnvelope,
  EventSearchResponse,
  EventInterface,
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
  if (!filters.kind) {
    throw new Error('Missing field "kind" in EventsFilter when searching events')
  }
  let params: DocumentClient.QueryInput = {
    TableName: config.resourceNames.eventsStore,
    ConsistentRead: true,
    ScanIndexForward: false, // Descending order (newer timestamps first)
  }
  let timeFilterQuery = ''
  const timeFilterAttributeValues: Record<string, string> = {}
  if (filters.from) {
    timeFilterQuery = `${eventsStoreAttributes.sortKey} >= :fromTime`
    timeFilterAttributeValues[':fromTime'] = filters.from
  }
  if (filters.to) {
    if (timeFilterQuery.length > 0) timeFilterQuery += ' AND '
    timeFilterQuery = `${eventsStoreAttributes.sortKey} <= :toTime`
    timeFilterAttributeValues[':toTime'] = filters.to
  }

  switch (filters.kind) {
    case 'entity':
      params = {
        ...params,
        KeyConditionExpression: `${eventsStoreAttributes.partitionKey} = :partitionKey AND ${timeFilterQuery}`,
        ExpressionAttributeValues: {
          ...timeFilterAttributeValues,
          ':partitionKey': partitionKeyForEvent(filters.entity, filters.entityID),
        },
      }
      break
    case 'type':
      break
  }

  logger.debug('Running events search with the following params: \n', params)

  const result = await dynamoDB.query(params).promise()
  const eventEnvelopes = (result.Items as Array<EventEnvelope>) ?? []

  logger.debug('Events search result: ', eventEnvelopes)

  const eventSearchResults: Array<EventSearchResponse> = eventEnvelopes.map((eventEnvelope) => {
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
  return eventSearchResults
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
