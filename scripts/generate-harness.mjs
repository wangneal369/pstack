#!/usr/bin/env node
// Zero-dependency cross-agent harness tree generator for upstream pstack (+ optional curated mattpocock/skills).
// Leaves upstream pstack/skills/ completely untouched so git pull / upstream rebase stays conflict-free.
//
// Usage:
//   node scripts/generate-harness.mjs --target <codex|pi|claude-code|generic|all> [--out <dir>] [--with-skills <path>]

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["codex", "pi", "claude-code", "generic"];

// Skills that explicitly reference Cursor paths, subagent fields, or model slugs and benefit from
// an inline pointer to the target harness adapter at the top of the body.
const ADAPTER_POINTER_SKILLS = new Set([
  "poteto-mode",
  "setup-pstack",
  "arena",
  "interrogate",
  "swarm",
  "reflect",
  "recall",
  "create-verification-skill",
  "maintain-verification-skill",
  "create-formal-verification-skill",
  "maintain-formal-verification-skill",
  "automate-me",
  "poteto-help",
]);

// Curated conflict-free subset from mattpocock/skills that complements pstack cleanly.
// Skills in FORCE_MANUAL_SKILLS get `disable-model-invocation: true` so they never cause
// over-asking freezes during routine coding tasks.
const CURATED_MATT_SKILLS = [
  "engineering/diagnosing-bugs",
  "engineering/retro",
  "engineering/codebase-design",
  "engineering/domain-modeling",
  "engineering/grill-with-docs",
  "engineering/to-spec",
  "engineering/to-tickets",
  "engineering/code-review",
  "engineering/triage",
  "engineering/wizard",
  "productivity/grill-me",
  "productivity/grilling",
  "productivity/writing-for-agents",
];

const FORCE_MANUAL_SKILLS = new Set(["grilling"]);

function parseCliArgs(argv) {
  let target = "all";
  let outRoot = join(ROOT, "dist");
  let withSkills = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target" && argv[i + 1]) {
      target = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      outRoot = resolve(argv[++i]);
    } else if (arg === "--with-skills" && argv[i + 1]) {
      withSkills = resolve(argv[++i]);
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/generate-harness.mjs --target <codex|pi|claude-code|generic|all> [--out <dir>] [--with-skills <mattpocock-skills-dir>]"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(64);
    }
  }

  const list = target === "all" ? TARGETS : [target];
  for (const t of list) {
    if (!TARGETS.includes(t)) {
      console.error(`Unsupported target '${t}'. Expected one of: ${TARGETS.join(", ")}, all`);
      process.exit(64);
    }
  }
  return { targets: list, outRoot, withSkills };
}

function injectAfterFrontmatter(markdown, snippet) {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return `${snippet}\n\n${markdown}`;
  const head = match[0];
  const rest = markdown.slice(head.length).replace(/^\r?\n*/, "");
  return `${head}\n${snippet}\n\n${rest}`;
}

function ensureDisableModelInvocation(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return markdown;
  if (/^disable-model-invocation:\s*true\b/m.test(match[1])) return markdown;
  const updatedFrontmatter = `---\n${match[1].trimEnd()}\ndisable-model-invocation: true\n---`;
  return updatedFrontmatter + markdown.slice(match[0].length);
}

function writeCodexAgents(targetDir) {
  const agentsDir = join(targetDir, "codex-agents");
  mkdirSync(agentsDir, { recursive: true });

  writeFileSync(
    join(agentsDir, "poteto-agent.toml"),
    `# Install into ~/.codex/agents/poteto-agent.toml (or .codex/agents/poteto-agent.toml)
name = "poteto-agent"
description = "Delegate subagent for code-writing and helper tasks spawned during a poteto-mode run."
instructions = """
Read the parent kickoff's worker.md path before anything else, then read skills/poteto-mode/SKILL.md and docs/harness/codex.md in full before editing code.
Navigate to any leaf principle-* skill when you apply that principle.
Never pass Cursor model slugs or Cursor-only tool fields.
"""
`,
    "utf8"
  );

  writeFileSync(
    join(agentsDir, "comment-sicko.toml"),
    `# Install into ~/.codex/agents/comment-sicko.toml (or .codex/agents/comment-sicko.toml)
name = "comment-sicko"
description = "Read-only comment reviewer that identifies slop comments and MUST KILL refactor targets."
sandbox_mode = "read-only"
instructions = """
Read agents/comment-sicko.md in full and follow its rules strictly. Report only; never write application code.
"""
`,
    "utf8"
  );
}

function writePiSubagents(targetDir) {
  const subagentsDir = join(targetDir, "pi-subagents");
  mkdirSync(subagentsDir, { recursive: true });

  writeFileSync(
    join(subagentsDir, "poteto-agent.md"),
    `---
name: poteto-agent
description: Delegate subagent for code-writing and helper tasks spawned during a /skill:poteto-mode run.
tools: read,write,edit,bash
---

Read the \`worker.md\` path given in your kickoff before anything else, then read \`skills/poteto-mode/SKILL.md\` and \`docs/harness/pi.md\` in full before doing any work. Navigate to leaf \`principle-*\` skills whenever you apply them.
`,
    "utf8"
  );

  writeFileSync(
    join(subagentsDir, "comment-sicko.md"),
    `---
name: comment-sicko
description: Read-only comment reviewer that hunts unnecessary comments and marks MUST KILL refactor targets.
tools: read,bash
---

Read \`agents/comment-sicko.md\` in full and follow its exact output format and keep-list exceptions. Do not edit application code.
`,
    "utf8"
  );
}

function generateTarget(target, outRoot, withSkills) {
  const targetDir = join(outRoot, target);
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // 1. Copy upstream pstack skills, agents, and harness doc
  cpSync(join(ROOT, "skills"), join(targetDir, "skills"), { recursive: true });
  cpSync(join(ROOT, "agents"), join(targetDir, "agents"), { recursive: true });
  mkdirSync(join(targetDir, "docs", "harness"), { recursive: true });

  const adapterSrc = join(ROOT, "docs", "harness", `${target}.md`);
  if (!existsSync(adapterSrc)) {
    throw new Error(`Missing harness adapter doc: ${adapterSrc}`);
  }
  cpSync(adapterSrc, join(targetDir, "docs", "harness", `${target}.md`));

  // 2. Inject lightweight adapter pointer into Cursor-sensitive skills
  const pointer = `> **Harness adapter (${target})**: Read \`../../docs/harness/${target}.md\` once per session and map Cursor tool names, model slugs, and paths before running steps in this skill.`;
  for (const skillName of ADAPTER_POINTER_SKILLS) {
    const skillMd = join(targetDir, "skills", skillName, "SKILL.md");
    if (existsSync(skillMd)) {
      const original = readFileSync(skillMd, "utf8");
      writeFileSync(skillMd, injectAfterFrontmatter(original, pointer), "utf8");
    }
  }

  // 3. Emit host-native subagent definitions & zero-dependency Node watch-pr fallback
  if (target === "codex") writeCodexAgents(targetDir);
  if (target === "pi") writePiSubagents(targetDir);

  const nodeWatchSrc = join(ROOT, "scripts", "watch-pr-node");
  const nodeWatchDst = join(targetDir, "skills", "poteto-mode", "scripts", "watch-pr");
  if (existsSync(nodeWatchSrc) && existsSync(nodeWatchDst)) {
    cpSync(join(nodeWatchSrc, "cli-node.ts"), join(nodeWatchDst, "cli-node.ts"));
    cpSync(join(nodeWatchSrc, "watch-pr.ts"), join(nodeWatchDst, "watch-pr.ts"));
  }

  // 4. Optionally merge curated conflict-free mattpocock/skills
  let bundledMatt = 0;
  if (withSkills) {
    const mattRoot = existsSync(join(withSkills, "skills"))
      ? join(withSkills, "skills")
      : withSkills;
    for (const rel of CURATED_MATT_SKILLS) {
      const src = join(mattRoot, rel);
      const name = rel.split("/").pop();
      const dst = join(targetDir, "skills", name);
      if (!existsSync(src)) {
        console.warn(`WARN: skipped missing skill ${src}`);
        continue;
      }
      if (existsSync(dst)) {
        console.warn(`WARN: skipped colliding skill name '${name}'`);
        continue;
      }
      cpSync(src, dst, { recursive: true });
      if (FORCE_MANUAL_SKILLS.has(name)) {
        const mdPath = join(dst, "SKILL.md");
        writeFileSync(mdPath, ensureDisableModelInvocation(readFileSync(mdPath, "utf8")), "utf8");
      }
      bundledMatt++;
    }
  }

  console.log(
    `Generated ${target} harness tree -> ${targetDir}${bundledMatt ? ` (+${bundledMatt} curated skills)` : ""}`
  );
}

const { targets, outRoot, withSkills } = parseCliArgs(process.argv.slice(2));
for (const target of targets) {
  generateTarget(target, outRoot, withSkills);
}
