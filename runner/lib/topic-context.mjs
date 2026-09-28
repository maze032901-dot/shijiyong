import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadTopicContext(root) {
  try {
    const catalog = JSON.parse(await readFile(path.join(root, "app", "public", "topic-catalog.json"), "utf8"));
    // Front-end presentation fields stay in the shared catalog but do not use model tokens.
    return {
      schema_version: catalog.schema_version,
      version: catalog.version,
      description: catalog.description,
      policy: catalog.policy,
      topics: catalog.topics.map(({ id, title, aliases, examples }) => ({ id, title, aliases, examples }))
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function validateTopicContext(context) {
  if (!context || typeof context !== "object" || !Array.isArray(context.topics)) return false;
  return context.topics.every((topic) => typeof topic?.id === "string" && typeof topic?.title === "string");
}
