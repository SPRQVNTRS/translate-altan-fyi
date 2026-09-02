// =============================================================================
// Metric Event Type Definitions
// =============================================================================
// Typed payload shapes for known metric event types.
// The DB stores eventType as text and payload as jsonb — these types enforce
// structure at the application layer while remaining extensible.

// =============================================================================
// Traffic Metrics (Matomo)
// =============================================================================

export interface TrafficPageviewPayload {
  url: string;
  title?: string;
  referrer?: string;
  visits: number;
  pageviews: number;
  uniquePageviews: number;
  avgTimeOnPage?: number;
}

export interface TrafficSummaryPayload {
  visits: number;
  pageviews: number;
  uniqueVisitors: number;
  bounceRate: number;
  avgSessionDuration: number;
  period: string;
}

// =============================================================================
// Server Log Counts
// =============================================================================

export interface ServerStatusPayload {
  count: number;
  period: string;
  breakdown?: Record<string, number>;
}

export interface ServerStatusSummaryPayload {
  total: number;
  period: string;
  byStatusCode: Record<string, number>;
}

// =============================================================================
// Event Type Registry
// =============================================================================

/** Known metric event types with typed payloads */
export type MetricEventType =
  | 'traffic.pageview'
  | 'traffic.summary'
  | 'server.status_2xx'
  | 'server.status_3xx'
  | 'server.status_4xx'
  | 'server.status_5xx'
  | 'server.status_summary';

/** Maps each known event type to its payload interface */
export interface MetricPayloadMap {
  'traffic.pageview': TrafficPageviewPayload;
  'traffic.summary': TrafficSummaryPayload;
  'server.status_2xx': ServerStatusPayload;
  'server.status_3xx': ServerStatusPayload;
  'server.status_4xx': ServerStatusPayload;
  'server.status_5xx': ServerStatusPayload;
  'server.status_summary': ServerStatusSummaryPayload;
}

/**
 * A typed metric event that narrows the payload based on event type.
 * Use for type-safe event handling in application code.
 */
export interface TypedMetricEvent<T extends MetricEventType = MetricEventType> {
  eventType: T;
  payload: MetricPayloadMap[T];
  source?: string;
  timestamp?: Date;
}

/**
 * Accepts known event types with autocomplete, but also allows arbitrary strings
 * for extensibility. Use this for function parameters and Zod schemas.
 */
export type MetricEventTypeInput = MetricEventType | (string & {});

/**
 * Type guard to check if an event type is a known typed event
 */
export function isKnownEventType(eventType: string): eventType is MetricEventType {
  const known: Set<string> = new Set<string>([
    'traffic.pageview',
    'traffic.summary',
    'server.status_2xx',
    'server.status_3xx',
    'server.status_4xx',
    'server.status_5xx',
    'server.status_summary',
  ]);
  return known.has(eventType);
}
