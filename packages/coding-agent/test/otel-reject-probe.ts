/**
 * A collector that rejects exports (e.g. 401) must not make
 * `flushTelemetryExport` throw: telemetry is best-effort and callers such as
 * print mode's terminal-failure path don't guard it. Runs in a subprocess
 * because initialization registers process-global providers.
 */

import { flushTelemetryExport, initTelemetryExport } from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { trace } from "@opentelemetry/api";

const server = Bun.serve({ port: 0, fetch: () => new Response("Unauthorized", { status: 401 }) });

process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`;
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

await initTelemetryExport(true);
trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("reject-probe").end();

let outcome = "PROBE: FLUSH_RESOLVED";
try {
	await flushTelemetryExport();
} catch (err) {
	outcome = `PROBE: FLUSH_THREW ${String(err)}`;
}
await server.stop(true);
console.log(outcome);
process.exit(outcome === "PROBE: FLUSH_RESOLVED" ? 0 : 1);
