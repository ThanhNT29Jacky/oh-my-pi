/**
 * OTLP telemetry export bootstrap.
 *
 * omp's agent core (`@oh-my-pi/pi-agent-core`) emits OpenTelemetry GenAI
 * spans through the global `@opentelemetry/api` tracer, and exposes run-level
 * callbacks for metrics/log pipelines. This module resolves the standard
 * `OTEL_*` env contract (endpoint, exporter selection, protocol,
 * `OTEL_SDK_DISABLED`) and, only when at least one signal has an OTLP endpoint,
 * loads `./telemetry-export-otlp` to register the trace/log/metric providers —
 * keeping the OTel SDK + exporter module graph (~100ms) out of default startup.
 *
 * `http/protobuf` (default) and `http/json` are supported per signal; any other
 * `OTEL_EXPORTER_OTLP*_PROTOCOL` (e.g. `grpc`) declines the signal rather than
 * misrouting payloads.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

/** Whether the model registered under a provider id and requested model id has known pricing. */
export type TelemetryModelPricingResolver = (providerId: string, modelId: string) => boolean;

/** OTLP wire format a signal exports with. */
export type OtlpProtocol = "http/protobuf" | "http/json";

/**
 * Per-signal OTLP export protocol resolved from the `OTEL_*` env contract;
 * `undefined` means the signal is not exported.
 */
export interface TelemetrySignalConfig {
	readonly trace: OtlpProtocol | undefined;
	readonly log: OtlpProtocol | undefined;
	readonly metric: OtlpProtocol | undefined;
}

type TelemetrySignal = "trace" | "log" | "metric";

/** Loaded OTLP implementation module; `undefined` until a signal registers. */
interface OtlpExportModule {
	registerProviders(signalConfig: TelemetrySignalConfig): Promise<void>;
	isTelemetryExportEnabled(): boolean;
	createTelemetryExportConfig(
		config: AgentTelemetryConfig | undefined,
		modelPricingResolver?: TelemetryModelPricingResolver,
	): AgentTelemetryConfig | undefined;
	flushTelemetryExport(): Promise<void>;
}

let otlp: OtlpExportModule | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Whether {@link initTelemetryExport} registered any real OTLP signal provider.
 * The CLI uses this to decide whether to switch on the agent loop's telemetry
 * hooks; metrics and structured logs need those callbacks even when traces are
 * disabled.
 */
export function isTelemetryExportEnabled(): boolean {
	return otlp?.isTelemetryExportEnabled() ?? false;
}

/**
 * Merge OTLP metrics/log hooks into an existing agent telemetry config.
 *
 * The caller still owns content-capture policy and custom attributes, and its
 * own `costEstimator` wins. Without one, `modelPricingResolver` makes chat
 * telemetry report each request's provider-computed cost. Beyond that, this
 * only appends host-level metrics/log forwarding for the providers registered
 * by {@link initTelemetryExport}; a passthrough when export is disabled.
 */
export function createTelemetryExportConfig(
	config: AgentTelemetryConfig | undefined,
	modelPricingResolver?: TelemetryModelPricingResolver,
): AgentTelemetryConfig | undefined {
	return otlp ? otlp.createTelemetryExportConfig(config, modelPricingResolver) : config;
}

/**
 * Register global trace/log/meter providers when enabled and OTLP endpoints are
 * configured through env. Idempotent, and a no-op when disabled, no signal has
 * an endpoint, or the OTEL kill-switch is engaged.
 *
 * @param exportEnabled `telemetry.otlpExportEnabled`; required so every caller
 *   decides whether the user's opt-out applies.
 */
export async function initTelemetryExport(exportEnabled: boolean): Promise<void> {
	if (initPromise) return initPromise;

	if (!exportEnabled || process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return;

	const signalConfig = resolveSignalConfig();
	if (!signalConfig.trace && !signalConfig.log && !signalConfig.metric) return;

	initPromise = (async () => {
		// Branch-only: the OTel SDK + OTLP exporter graph loads only when an endpoint is configured.
		const impl: OtlpExportModule = await import("./telemetry-export-otlp");
		await impl.registerProviders(signalConfig);
		otlp = impl;
	})();
	return initPromise;
}

/**
 * Flush buffered spans, log records, and metrics. No-op when export is disabled.
 * Hosts embedding the agent can call this at natural boundaries (e.g. the end
 * of a turn) so telemetry surfaces promptly rather than on the batch interval.
 */
export async function flushTelemetryExport(): Promise<void> {
	if (otlp) await otlp.flushTelemetryExport();
}

function resolveSignalConfig(): TelemetrySignalConfig {
	return {
		trace: signalProtocol(
			"trace",
			process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_TRACES_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		log: signalProtocol(
			"log",
			process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_LOGS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
		metric: signalProtocol(
			"metric",
			process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
			process.env.OTEL_METRICS_EXPORTER,
			process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
		),
	};
}

function signalProtocol(
	signal: TelemetrySignal,
	endpoint: string | undefined,
	exporterSelection: string | undefined,
	protocolSelection: string | undefined,
): OtlpProtocol | undefined {
	if (exporterSelection) {
		let hasSelection = false;
		let hasOtlp = false;
		for (const entry of exporterSelection.split(",")) {
			const selection = entry.trim().toLowerCase();
			if (!selection) continue;
			hasSelection = true;
			if (selection === "none") return undefined;
			if (selection === "otlp") hasOtlp = true;
		}
		if (hasSelection && !hasOtlp) return undefined;
	}
	if (!endpoint) return undefined;

	// Spec default for an unset protocol is http/protobuf.
	const protocol = protocolSelection?.trim().toLowerCase() || "http/protobuf";
	if (protocol !== "http/protobuf" && protocol !== "http/json") {
		logger.warn(`OTEL ${signal} export disabled: OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is unsupported`, {
			supported: "http/protobuf, http/json",
		});
		return undefined;
	}
	return protocol;
}
