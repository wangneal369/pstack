import { setTimeout as delay } from "node:timers/promises";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  GhGitHubReader,
  WatcherQueryError,
  discoverStack,
  resolveContext,
} from "./github.ts";
import {
  runQueued,
  runSimple,
  statusQueryVerdict,
  verdictFactory,
  type WatchClock,
} from "./policy.ts";
import { renderJson, renderPretty } from "./render.ts";
import type * as T from "./types.ts";
import { nonEmpty, parsePrNumber } from "./types.ts";

export interface CliOptions {
  readonly owner: string | null;
  readonly repo: string | null;
  readonly pr: T.PrNumber | null;
  readonly mode: T.WatchMode;
  readonly stackPrs: readonly T.PrNumber[];
  readonly statusOnly: boolean;
  readonly pretty: boolean;
  readonly polling: T.PollingOptions;
}

class CliExit extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = "CliExit";
    this.exitCode = exitCode;
  }
}

const HELP_TEXT = `Usage: watch-pr [options]

Watch one pull request, a connected stack, or an immutable queued stack.
JSON (NDJSON while polling) is the default; --pretty renders human text.

Options:
  --owner <owner>             GitHub repository owner
  --repo <repo>               GitHub repository name
  --pr <number>               pull request number
  --stack                     watch the connected open stack (default: false)
  --queued-stack              watch the captured stack until all PRs merge (default: false)
  --stack-prs <n,...>         frozen bottom-to-top queue (queued mode only)
  --interval <seconds>        poll interval (default: 60)
  --sweep-interval <seconds>  whole-stack sweep interval (default: 300)
  --timeout <seconds>         deadline; 0 disables it (default: 0)
  --max-query-errors <count>  consecutive query-error budget (default: 5)
  --status-only               print one status table and exit 0 (default: false)
  --allow-draft               do not treat a draft as a merge gate (default: false)
  --pretty                    render human text instead of JSON (default: false)
  -h, --help                  display help for command
`;

function failUsage(
  io: Pick<CliRuntime, "stderr">,
  message: string
): never {
  const formatted = message.startsWith("error:") ? message : `error: ${message}`;
  io.stderr(`${formatted}\n`);
  throw new CliExit(64, formatted);
}

function invalidOption(
  io: Pick<CliRuntime, "stderr">,
  optionLabel: string,
  value: string,
  reason: string
): never {
  failUsage(
    io,
    `option '${optionLabel}' argument '${value}' is invalid. ${reason}`
  );
}

function positiveNumber(
  value: string,
  optionLabel: string,
  io: Pick<CliRuntime, "stderr">
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    invalidOption(io, optionLabel, value, "must be greater than zero");
  return parsed;
}

function nonNegativeNumber(
  value: string,
  optionLabel: string,
  io: Pick<CliRuntime, "stderr">
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    invalidOption(io, optionLabel, value, "must be zero or greater");
  return parsed;
}

function positiveInteger(
  value: string,
  optionLabel: string,
  io: Pick<CliRuntime, "stderr">
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    invalidOption(io, optionLabel, value, "must be a positive integer");
  return parsed;
}

function prNumber(
  value: string,
  optionLabel: string,
  io: Pick<CliRuntime, "stderr">
): T.PrNumber {
  const stripped = value.replace(/^#/, "");
  if (stripped.trim() === "")
    invalidOption(io, optionLabel, value, "must be a positive integer");
  try {
    return parsePrNumber(Number(stripped));
  } catch {
    invalidOption(io, optionLabel, value, "must be a positive integer");
  }
}

function stackPrList(
  value: string,
  io: Pick<CliRuntime, "stderr">
): T.NonEmpty<T.PrNumber> {
  const numbers = value
    .split(",")
    .map((part) => prNumber(part.trim(), "--stack-prs <n,...>", io));
  if (new Set(numbers).size !== numbers.length)
    invalidOption(io, "--stack-prs <n,...>", value, "contains a duplicate PR");
  const parsed = nonEmpty(numbers);
  if (parsed === null)
    invalidOption(io, "--stack-prs <n,...>", value, "cannot be empty");
  return parsed;
}

const NUMERIC_VALUE_OPTIONS = new Set([
  "--pr",
  "--interval",
  "--sweep-interval",
  "--timeout",
  "--max-query-errors",
]);

function normalizeNegativeNumericArgs(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      out.push(...argv.slice(i));
      break;
    }
    const next = argv[i + 1];
    if (
      NUMERIC_VALUE_OPTIONS.has(arg) &&
      next !== undefined &&
      /^-(?:\d|\.\d)/.test(next)
    ) {
      out.push(`${arg}=${next}`);
      i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function parseArgs(
  argv: readonly string[],
  io: Pick<CliRuntime, "stdout" | "stderr">
): CliOptions {
  let parsed;
  try {
    parsed = parseNodeArgs({
      args: normalizeNegativeNumericArgs(argv),
      strict: true,
      allowPositionals: false,
      options: {
        owner: { type: "string" },
        repo: { type: "string" },
        pr: { type: "string" },
        stack: { type: "boolean", default: false },
        "queued-stack": { type: "boolean", default: false },
        "stack-prs": { type: "string" },
        interval: { type: "string" },
        "sweep-interval": { type: "string" },
        timeout: { type: "string" },
        "max-query-errors": { type: "string" },
        "status-only": { type: "boolean", default: false },
        "allow-draft": { type: "boolean", default: false },
        pretty: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    failUsage(io, error instanceof Error ? error.message : String(error));
  }

  const values = parsed.values;
  if (values.help) {
    io.stdout(HELP_TEXT);
    throw new CliExit(0, "help");
  }

  const stack = values.stack ?? false;
  const queuedStack = values["queued-stack"] ?? false;
  if (stack && queuedStack) {
    failUsage(io, "option '--stack' cannot be used with option '--queued-stack'");
  }
  if (values["stack-prs"] !== undefined && !queuedStack) {
    failUsage(io, "--stack-prs requires --queued-stack");
  }

  const pr =
    values.pr === undefined ? null : prNumber(values.pr, "--pr <number>", io);
  const stackPrs =
    values["stack-prs"] === undefined
      ? []
      : stackPrList(values["stack-prs"], io);
  const interval =
    values.interval === undefined
      ? 60
      : positiveNumber(values.interval, "--interval <seconds>", io);
  const sweepInterval =
    values["sweep-interval"] === undefined
      ? 300
      : positiveNumber(
          values["sweep-interval"],
          "--sweep-interval <seconds>",
          io
        );
  const timeout =
    values.timeout === undefined
      ? 0
      : nonNegativeNumber(values.timeout, "--timeout <seconds>", io);
  const maxQueryErrors =
    values["max-query-errors"] === undefined
      ? 5
      : positiveInteger(
          values["max-query-errors"],
          "--max-query-errors <count>",
          io
        );

  return {
    owner: values.owner ?? null,
    repo: values.repo ?? null,
    pr,
    mode: queuedStack ? "queued-stack" : stack ? "stack" : "single",
    stackPrs,
    statusOnly: values["status-only"] ?? false,
    pretty: values.pretty ?? false,
    polling: {
      interval,
      sweepInterval,
      timeout,
      maxQueryErrors,
      allowDraft: values["allow-draft"] ?? false,
    },
  };
}

export interface CliRuntime {
  readonly reader: T.GitHubReader;
  readonly clock: WatchClock;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

function realRuntime(): CliRuntime {
  return {
    reader: new GhGitHubReader(),
    clock: {
      now: () => performance.now() / 1_000,
      observedAt: () => new Date().toISOString(),
      sleep: async (seconds) => {
        await delay(seconds * 1_000);
      },
    },
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  };
}

export async function main(
  argv: readonly string[],
  runtime: CliRuntime = realRuntime()
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv, runtime);
  } catch (error) {
    if (!(error instanceof CliExit)) throw error;
    return error.exitCode;
  }
  const render = options.pretty ? renderPretty : renderJson;
  const emit = (verdict: T.ProgressVerdict): void =>
    runtime.stdout(render(verdict));
  let contexts: T.NonEmpty<T.PrContext>;
  try {
    const seed = await resolveContext({
      reader: runtime.reader,
      owner: options.owner,
      repo: options.repo,
      pr: options.pr ?? options.stackPrs[0] ?? null,
    });
    contexts =
      nonEmpty(options.stackPrs.map((number) => ({ ...seed, number }))) ??
      (options.mode === "single"
        ? [seed]
        : await discoverStack(runtime.reader, seed));
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;
    const verdict = statusQueryVerdict(
      verdictFactory(runtime.clock, options.mode),
      1,
      error.failure
    );
    runtime.stdout(render(verdict));
    return verdict.exitCode;
  }
  const dependencies = { reader: runtime.reader, clock: runtime.clock, emit };
  const verdict =
    options.mode === "queued-stack" && !options.statusOnly
      ? await runQueued({ dependencies, contexts, options: options.polling })
      : await runSimple({
          dependencies,
          contexts,
          mode: options.mode,
          statusOnly: options.statusOnly,
          options: options.polling,
        });
  runtime.stdout(render(verdict));
  return verdict.exitCode;
}
