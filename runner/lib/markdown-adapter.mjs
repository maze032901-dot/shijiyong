import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./utils.mjs";

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { values: {}, body: markdown };

  const values = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const separator = line.indexOf(":");
    if (separator > 0) {
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      values[key] = rawValue.replace(/^\"|\"$/g, "");
    }
  });
  return { values, body: markdown.slice(match[0].length) };
}

function extractHeading(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function existingRelativePath(root, absolutePath) {
  if (!fs.existsSync(absolutePath)) return null;
  const relativePath = path.relative(root, absolutePath);
  return relativePath.startsWith("..") ? null : relativePath;
}

function extractAttachmentPaths(markdown, notePath, root) {
  const markdownReferences = [...markdown.matchAll(/!?(?:\[[^\]]*\]\()([^\)]+)(?:\))/g)]
    .map((match) => match[1])
    .filter((reference) => !/^https?:\/\//i.test(reference));
  const obsidianReferences = [...markdown.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)]
    .map((match) => match[1].trim());
  const vaultRoot = path.dirname(path.dirname(notePath));
  const paths = new Set();

  [...markdownReferences, ...obsidianReferences].forEach((reference) => {
    const candidates = [
      path.resolve(path.dirname(notePath), reference),
      path.join(vaultRoot, "附件", path.basename(reference))
    ];
    candidates.forEach((candidate) => {
      const relativePath = existingRelativePath(root, candidate);
      if (relativePath) paths.add(relativePath);
    });
  });
  return [...paths].sort();
}

function declaredAttachmentPaths(source, root) {
  const paths = new Set();
  (source.attachment_paths || []).forEach((relativePath) => {
    const absolutePath = path.resolve(root, relativePath);
    const existingPath = existingRelativePath(root, absolutePath);
    if (!existingPath) {
      throw new Error("来源声明的附件不存在：" + relativePath);
    }
    paths.add(existingPath);
  });
  return [...paths];
}

export function buildInputRecord({ root, source }) {
  if (!source.note_path) {
    throw new Error("来源没有 note_path，当前无 AI Runner 只能读取已保存笔记。");
  }

  const notePath = path.join(root, source.note_path);
  if (!fs.existsSync(notePath)) {
    throw new Error("来源笔记不存在：" + source.note_path);
  }

  const markdown = fs.readFileSync(notePath, "utf8");
  const { values: frontmatter, body } = parseFrontmatter(markdown);
  const heading = extractHeading(body);
  const attachmentPaths = [...new Set([
    ...extractAttachmentPaths(markdown, notePath, root),
    ...declaredAttachmentPaths(source, root)
  ])].sort();
  const evidence = [
    {
      id: "evidence_" + source.id + "_note",
      kind: "note_text",
      source_id: source.id,
      locator: source.note_path,
      text: markdown,
      sha256: sha256(markdown)
    }
  ];

  attachmentPaths.forEach((attachmentPath, index) => {
    const attachment = fs.readFileSync(path.join(root, attachmentPath));
    evidence.push({
      id: "evidence_" + source.id + "_attachment_" + (index + 1),
      kind: "attachment_image",
      source_id: source.id,
      locator: attachmentPath,
      sha256: sha256(attachment)
    });
  });

  return {
    input_id: "input_" + source.id,
    source_id: source.id,
    source_kind: source.kind,
    source_status: source.status,
    evidence_scope: source.evidence_scope,
    note_path: source.note_path,
    title_from_note: heading || frontmatter.title || source.title,
    frontmatter,
    attachment_paths: attachmentPaths,
    raw_markdown: markdown,
    markdown_sha256: sha256(markdown),
    evidence
  };
}
