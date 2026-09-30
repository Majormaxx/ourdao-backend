// Issue #288: OpenTelemetry tracing bootstrap for the indexer's event
// processing loop (src/indexer/poller.ts, src/indexer/handlers.ts).
//
// Import this module and call `initTelemetry()` once, before anything else
// runs, at the top of a process entry point (src/worker.ts, src/index.ts) —
// the standard OpenTelemetry Node.js bootstrap ordering. `@opentelemetry/api`
// itself has a global no-op TracerProvider built in, so `trace.getTracer(...)`
// calls elsewhere in the codebase are always safe to make even if
// `initTelemetry()` is never called (OTEL_ENABLED unset/false, the default) —
// they just produce spans that go nowhere instead of failing.
import { trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { config } from './config.js'

const TRACER_NAME = 'ourdao-indexer'

let provider: NodeTracerProvider | null = null

/** Registers a real OTLP-exporting TracerProvider when OTEL_ENABLED=true;
 *  a no-op otherwise. Idempotent — a second call is a no-op (there's only
 *  ever one global provider). */
export function initTelemetry(): void {
  if (!config.otel.enabled || provider !== null) return

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.otel.serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: config.otel.exporterOtlpEndpoint })),
    ],
  })
  provider.register()
  console.log(`[telemetry] OpenTelemetry tracing enabled, exporting to ${config.otel.exporterOtlpEndpoint}`)
}

/** Flushes any buffered spans and shuts the provider down. Call during
 *  graceful shutdown alongside pool.end() etc. No-op if tracing was never
 *  enabled. */
export async function shutdownTelemetry(): Promise<void> {
  if (provider === null) return
  await provider.shutdown()
  provider = null
}

/** The tracer every indexer span in this codebase is created from. Safe to
 *  call at any time, enabled or not — see the module doc comment above. */
export function getTracer() {
  return trace.getTracer(TRACER_NAME)
}
