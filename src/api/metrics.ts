import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client'

// Issue #274: Prometheus metrics for SSE stream connection count and message
// throughput. A dedicated Registry (rather than the global default one)
// keeps this module's metrics isolated and easy to reset between tests.
export const metricsRegistry = new Registry()

collectDefaultMetrics({ register: metricsRegistry })

/** Current number of open SSE stream connections on this process. */
export const sseConnectionsGauge = new Gauge({
  name: 'ourdao_sse_connections',
  help: 'Number of currently open SSE stream connections',
  registers: [metricsRegistry],
})

/** Total number of SSE messages written to any client, by event type. */
export const sseMessagesTotal = new Counter({
  name: 'ourdao_sse_messages_total',
  help: 'Total number of SSE messages written to stream clients',
  labelNames: ['event_type'] as const,
  registers: [metricsRegistry],
})

/** Total number of SSE connections opened, ever (monotonic — unlike the gauge). */
export const sseConnectionsTotal = new Counter({
  name: 'ourdao_sse_connections_total',
  help: 'Total number of SSE stream connections opened',
  registers: [metricsRegistry],
})
