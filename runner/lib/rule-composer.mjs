import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts/modules");
const moduleFiles = [
  "00-evidence-boundary.md",
  "10-card-product-policy.md",
  "20-topic-and-type-policy.md",
  "30-output-quality.md"
];

export function composeRuleModules({ extra = "" } = {}) {
  const modules = moduleFiles.map((file) => readFileSync(path.join(moduleDirectory, file), "utf8").trim());
  return [...modules, extra.trim()].filter(Boolean).join("\n\n") + "\n";
}

export function ruleModuleNames() {
  return [...moduleFiles];
}
