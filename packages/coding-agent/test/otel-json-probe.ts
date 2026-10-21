/**
 * Positive-path probe for `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`: every signal
 * must reach the collector as JSON, not protobuf. Runs in a subprocess because
 * initialization registers process-global providers.
 */

import { flushTelemetryExport, initTelemetryExport } from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { logger } from "@oh-my-pi/pi-utils";
import { metrics, trace } from "@opentelemetry/api";

const contentTypes = new Map<string, string>();

const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const body = await req.arrayBuffer();
		if (req.method === "POST" && body.byteLength > 0) {
			contentTypes.set(new URL(req.url).pathname, req.headers.get("content-type") ?? "");
		}
		return new Response('{"partialSuccess":{}}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
});

process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`;
process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

await initTelemetryExport(true);
trace.getTracer("@oh-my-pi/pi-agent-core").startSpan("json-probe").end();
logger.error("json probe");
metrics.getMeter("@oh-my-pi/pi-coding-agent").createCounter("json_probe").add(1);
await flushTelemetryExport();
await server.stop(true);

const paths = ["/v1/traces", "/v1/logs", "/v1/metrics"];
const ok = paths.every(path => contentTypes.get(path)?.startsWith("application/json"));
console.log(ok ? "PROBE: JSON" : `PROBE: UNEXPECTED ${JSON.stringify([...contentTypes])}`);
process.exit(ok ? 0 : 1);
