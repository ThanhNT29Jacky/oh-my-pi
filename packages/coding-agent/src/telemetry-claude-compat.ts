/**
 * Claude Code compatible OTLP telemetry (`OMP_OTEL_CLAUDE_CODE_COMPAT=1`).
 *
 * Collectors and dashboards built for Claude Code key on its metric names
 * (`claude_code.token.usage`, ...), log events (`claude_code.api_request`, ...)
 * and standard attributes (`user.email`, `session.id`, ...). This recorder maps
 * the agent loop's telemetry hooks onto that schema, so omp shows up next to
 * Claude Code. Schema: https://code.claude.com/docs/en/monitoring-usage
 *
 * Not covered, because the agent loop exposes no matching hook: `tool_decision`
 * events, `lines_of_code`, `commit` and `pull_request` counters.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentRunSummary, ChatUsageEvent, TelemetryHookContext } from "@oh-my-pi/pi-agent-core";
import { type Attributes, type Counter, type Meter, type Span, SpanStatusCode } from "@opentelemetry/api";
import { type LogAttributes, type Logger as OtelLogger, SeverityNumber } from "@opentelemetry/api-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/** Whether `OMP_OTEL_CLAUDE_CODE_COMPAT` asks for Claude Code compatible telemetry. */
export function isClaudeCodeCompatEnabled(): boolean {
	const raw = process.env.OMP_OTEL_CLAUDE_CODE_COMPAT?.trim().toLowerCase();
	return raw === "1" || raw === "true";
}

/** The slice of Claude Code's `.claude.json` that identifies the signed-in account. */
const ClaudeState = type({
	"userID?": "string",
	"oauthAccount?": {
		"organizationUuid?": "string",
		"accountUuid?": "string",
		"emailAddress?": "string",
	},
});

/**
 * Account identity Claude Code stamps on every metric and event, read from its
 * own state file (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`).
 * Missing, unreadable, or malformed state yields no identity attributes.
 */
function readClaudeIdentity(): Attributes {
	const configDir = process.env.CLAUDE_CONFIG_DIR;
	const file = configDir ? path.join(configDir, ".claude.json") : path.join(os.homedir(), ".claude.json");
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	const state = ClaudeState(raw);
	if (state instanceof type.errors) return {};
	const out: Attributes = {};
	if (state.userID) out["user.id"] = state.userID;
	if (state.oauthAccount?.organizationUuid) out["organization.id"] = state.oauthAccount.organizationUuid;
	if (state.oauthAccount?.accountUuid) out["user.account_uuid"] = state.oauthAccount.accountUuid;
	if (state.oauthAccount?.emailAddress) out["user.email"] = state.oauthAccount.emailAddress;
	return out;
}

/** Spans from the SDK tracer carry status and parent; no-op spans do not. */
function isReadableSpan(span: Span): span is Span & ReadableSpan {
	return "status" in span && "parentSpanContext" in span;
}

/** Claude Code only talks to Anthropic, so only its models are reported; other providers' runs are skipped. */
const ANTHROPIC_PROVIDER = "anthropic";

export class ClaudeCodeCompatRecorder {
	readonly #sessionCount: Counter<Attributes>;
	readonly #tokenUsage: Counter<Attributes>;
	readonly #costUsage: Counter<Attributes>;
	readonly #activeTime: Counter<Attributes>;
	readonly #logger: OtelLogger | undefined;
	readonly #standard: Attributes;
	readonly #startTimes = new WeakMap<Span, number>();
	#anthropic = false;
	#promptId: string | undefined;
	#sequence = 0;

	constructor(meter: Meter, logger: OtelLogger | undefined) {
		this.#logger = logger;
		this.#standard = {
			"session.id": randomUUID(),
			...readClaudeIdentity(),
			"terminal.type": process.env.TERM_PROGRAM ?? "omp",
		};
		this.#sessionCount = meter.createCounter("claude_code.session.count", {
			description: "Count of CLI sessions started",
		});
		this.#tokenUsage = meter.createCounter("claude_code.token.usage", {
			description: "Number of tokens used",
			unit: "tokens",
		});
		this.#costUsage = meter.createCounter("claude_code.cost.usage", {
			description: "Cost of the Claude Code session",
			unit: "USD",
		});
		this.#activeTime = meter.createCounter("claude_code.active_time.total", {
			description: "Total active time",
			unit: "s",
		});
		this.#sessionCount.add(1, { ...this.#standard, start_type: "fresh" });
	}

	/** Start of a user prompt (a root `invoke_agent`); other spans only record their start time. */
	onSpanStart(ctx: TelemetryHookContext): void {
		this.#startTimes.set(ctx.span, Date.now());
		// Tool spans carry no model, so the run's provider is tracked from its agent and chat spans.
		if ((ctx.kind === "invoke_agent" || ctx.kind === "chat") && ctx.model) {
			this.#anthropic = ctx.model.provider === ANTHROPIC_PROVIDER;
		}
		if (ctx.kind !== "invoke_agent" || !this.#anthropic) return;
		// A parented invoke_agent is a subagent run, not a user prompt.
		if (isReadableSpan(ctx.span) && ctx.span.parentSpanContext) return;
		this.#promptId = randomUUID();
		this.#emit("user_prompt", { prompt: "<REDACTED>" });
	}

	onSpanEnd(ctx: TelemetryHookContext): void {
		if (ctx.kind !== "execute_tool" || !this.#anthropic) return;
		const failed = isReadableSpan(ctx.span) && ctx.span.status.code === SpanStatusCode.ERROR;
		const toolName = ctx.toolName ?? "unknown";
		this.#emit("tool_result", {
			// Claude Code names tools in PascalCase (`Read`, `Bash`); omp's are lowercase.
			tool_name: toolName.charAt(0).toUpperCase() + toolName.slice(1),
			tool_use_id: ctx.toolCallId,
			success: failed ? "false" : "true",
			duration_ms: this.#elapsed(ctx.span),
			decision_type: "accept",
			decision_source: "config",
		});
	}

	recordChatUsage(event: ChatUsageEvent): void {
		if (event.provider !== ANTHROPIC_PROVIDER) return;
		const { usage } = event;
		const cacheRead = usage.cachedInputTokens ?? 0;
		const cacheCreation = usage.cacheWriteTokens ?? 0;
		// omp follows the GenAI convention (input includes cache); Claude Code's `input` excludes it.
		const input = Math.max(0, usage.inputTokens - cacheRead - cacheCreation);
		const base: Attributes = { ...this.#standard, model: event.model, query_source: "main" };
		this.#addTokens(input, "input", base);
		this.#addTokens(usage.outputTokens, "output", base);
		this.#addTokens(cacheRead, "cacheRead", base);
		this.#addTokens(cacheCreation, "cacheCreation", base);

		const costUsd = event.cost && "usd" in event.cost ? event.cost.usd : 0;
		if (costUsd > 0) this.#costUsage.add(costUsd, base);

		this.#emit("api_request", {
			model: event.model,
			cost_usd: costUsd,
			cost_usd_micros: Math.round(costUsd * 1_000_000),
			duration_ms: this.#elapsed(event.span),
			input_tokens: input,
			output_tokens: usage.outputTokens,
			cache_read_tokens: cacheRead,
			cache_creation_tokens: cacheCreation,
			request_id: event.headers?.["request-id"] ?? event.headers?.["x-request-id"],
			speed: "normal",
			query_source: "repl_main_thread",
		});
	}

	recordRun(summary: AgentRunSummary): void {
		if (!this.#anthropic) return;
		const seconds = (summary.chats.totalLatencyMs + summary.tools.totalLatencyMs) / 1000;
		if (seconds > 0) this.#activeTime.add(seconds, { ...this.#standard, type: "cli" });
	}

	#addTokens(value: number, tokenType: string, base: Attributes): void {
		if (value > 0) this.#tokenUsage.add(value, { ...base, type: tokenType });
	}

	#elapsed(span: Span): number {
		const start = this.#startTimes.get(span);
		return start === undefined ? 0 : Date.now() - start;
	}

	#emit(name: string, fields: Record<string, string | number | undefined>): void {
		if (!this.#logger) return;
		const now = new Date();
		const attributes: LogAttributes = {
			...this.#standard,
			"event.name": name,
			"event.timestamp": now.toISOString(),
			"event.sequence": this.#sequence++,
		};
		if (this.#promptId) attributes["prompt.id"] = this.#promptId;
		for (const key in fields) {
			const value = fields[key];
			if (value !== undefined) attributes[key] = value;
		}
		this.#logger.emit({
			timestamp: now,
			observedTimestamp: now,
			severityNumber: SeverityNumber.INFO,
			severityText: "INFO",
			body: `claude_code.${name}`,
			attributes,
		});
	}
}
