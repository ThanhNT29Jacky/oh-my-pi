/**
 * Probe for `OMP_OTEL_CLAUDE_CODE_COMPAT=1`: drives the telemetry hooks the way
 * the agent loop does and checks what reaches a JSON collector. Runs in a
 * subprocess because initialization registers process-global providers.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatUsageEvent, TelemetryHookContext } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	createTelemetryExportConfig,
	flushTelemetryExport,
	initTelemetryExport,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-claude-compat-"));
fs.writeFileSync(
	path.join(claudeDir, ".claude.json"),
	JSON.stringify({
		userID: "anon-user",
		oauthAccount: { organizationUuid: "org-1", accountUuid: "acct-1", emailAddress: "dev@example.com" },
	}),
);

const received: Record<string, unknown[]> = {};
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const pathname = new URL(req.url).pathname;
		(received[pathname] ??= []).push(await req.json());
		return new Response("{}", { headers: { "content-type": "application/json" } });
	},
});

process.env.OMP_OTEL_CLAUDE_CODE_COMPAT = "1";
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://localhost:${server.port}`;
process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";

await initTelemetryExport(true);
const config = createTelemetryExportConfig({});
const tracer = trace.getTracer("probe");

/** One prompt with a chat and a failing tool call, as the agent loop would run it for `provider`. */
async function runScenario(provider: string, modelId: string): Promise<void> {
	// Only `provider` is read by the compat hooks; a full Model is not needed here.
	const model = { provider } as Model;
	const base = { model, agent: undefined, conversationId: undefined } as const;

	const root = tracer.startSpan("invoke_agent");
	config?.onSpanStart?.({ ...base, kind: "invoke_agent", span: root });

	const chat = tracer.startSpan("chat");
	config?.onSpanStart?.({ ...base, kind: "chat", span: chat });
	const usage: ChatUsageEvent = {
		span: chat,
		operation: "chat",
		agent: undefined,
		conversationId: undefined,
		stepNumber: 0,
		model: modelId,
		provider,
		serviceTier: undefined,
		usage: {
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			cachedInputTokens: 40,
			cacheWriteTokens: undefined,
			reasoningOutputTokens: undefined,
		},
		cost: { usd: 0.01, inputUsd: 0.004, outputUsd: 0.006 },
		attributes: undefined,
		headers: { "request-id": "req_probe" },
	};
	await config?.onChatUsage?.(usage);
	chat.end();

	const tool = tracer.startSpan("execute_tool");
	const toolCtx: TelemetryHookContext = {
		kind: "execute_tool",
		model: undefined,
		agent: undefined,
		conversationId: undefined,
		span: tool,
		toolName: "bash",
		toolCallId: "call_1",
	};
	config?.onSpanStart?.(toolCtx);
	tool.setStatus({ code: SpanStatusCode.ERROR });
	tool.end();
	config?.onSpanEnd?.(toolCtx);
	root.end();
}

await runScenario("anthropic", "claude-haiku-5-5");
// Claude Code only talks to Anthropic: a run on another provider must add no events or tokens.
await runScenario("openai", "gpt-5.5");

await flushTelemetryExport();
await server.stop(true);

type Attr = { key: string; value: Record<string, string | number> };
const attrs = (list: Attr[]) => Object.fromEntries(list.map(a => [a.key, Object.values(a.value)[0]]));

const logsBody = received["/v1/logs"]?.[0] as {
	resourceLogs: { resource: { attributes: Attr[] }; scopeLogs: { logRecords: { body: { stringValue: string }; attributes: Attr[] }[] }[] }[];
};
const metricsBody = received["/v1/metrics"]?.[0] as {
	resourceMetrics: { scopeMetrics: { metrics: { name: string; sum: { dataPoints: { attributes: Attr[]; asInt?: string; asDouble?: number }[] } }[] }[] }[];
};
const records = Object.fromEntries(
	logsBody.resourceLogs[0].scopeLogs[0].logRecords.map(r => [r.body.stringValue, attrs(r.attributes)]),
);
const metricPoints = metricsBody.resourceMetrics[0].scopeMetrics[0].metrics.flatMap(m =>
	m.sum.dataPoints.map(p => {
		const a = attrs(p.attributes);
		return { name: m.name, type: a.type, model: a.model, value: Number(p.asInt ?? p.asDouble) };
	}),
);
const inputTokens = metricPoints.find(p => p.name === "claude_code.token.usage" && p.type === "input");

const checks = {
	serviceName: attrs(logsBody.resourceLogs[0].resource.attributes)["service.name"] === "claude-code",
	events: Object.keys(records).sort().join(",") === "claude_code.api_request,claude_code.tool_result,claude_code.user_prompt",
	identity: records["claude_code.api_request"]?.["user.email"] === "dev@example.com",
	promptId: records["claude_code.tool_result"]?.["prompt.id"] === records["claude_code.user_prompt"]?.["prompt.id"],
	toolFailed: records["claude_code.tool_result"]?.success === "false" && records["claude_code.tool_result"]?.tool_name === "Bash",
	requestId: records["claude_code.api_request"]?.request_id === "req_probe",
	inputExcludesCache: inputTokens?.value === 60 && inputTokens?.model === "claude-haiku-5-5",
	sessionCount: metricPoints.some(p => p.name === "claude_code.session.count" && p.value === 1),
	noOmpMetrics: !metricPoints.some(p => p.name.startsWith("omp.") || p.name.startsWith("gen_ai.")),
	noTraces: received["/v1/traces"] === undefined,
	onlyAnthropicEvents: logsBody.resourceLogs[0].scopeLogs[0].logRecords.length === 3,
	onlyAnthropicTokens: metricPoints
		.filter(p => p.name === "claude_code.token.usage")
		.every(p => p.model === "claude-haiku-5-5"),
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
console.log(failed.length === 0 ? "PROBE: CLAUDE_COMPAT" : `PROBE: FAILED ${failed.join(",")}`);
if (failed.length > 0) console.log(JSON.stringify({ records, metricPoints }, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
