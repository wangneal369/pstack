#!/usr/bin/env node
// Zero-dependency Node 22.6+ / 24+ entrypoint for pstack's watch-pr (no Bun or commander required).
// Usage: node watch-pr.ts [--owner <o> --repo <r>] [--pr <n>] [--stack | --queued-stack --stack-prs <n,...>] [--status-only] [--pretty]
import { main } from "./cli-node.ts";

process.exitCode = await main(process.argv.slice(2));
