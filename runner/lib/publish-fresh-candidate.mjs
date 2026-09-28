import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { normaliseModelCandidate } from "./model-candidate-normalizer.mjs";
import { freshInputRecord, freshReferenceFixture } from "./fresh-evidence-candidate.mjs";
import { normaliseTopics } from "./topic-normalizer.mjs";
import { persistRun } from "./storage.mjs";
import { readJson, safePathSegment, sha256, shortHash } from "./utils.mjs";
import { GENERATION_RULES_VERSION } from "./generation-policy.mjs";
import { CARD_DRAFT_VERSION } from "./card-draft-contract.mjs";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function eventIdFromEvidence(evidence) {
  const metadata = evidence.items?.find((item) => item.kind === "metadata");
  if (!metadata?.text) return null;
  try {
    const parsed = JSON.parse(metadata.text);
    return text(parsed.event_id) || null;
  } catch {
    return null;
  }
}

/**
 * Cited visual items are evidence. An uncited same-source image is only a
 * preview, never a citation for an ASR-only claim.
 */
function cardMedia({ root, sourceId, evidence, evidencePath, rawCard, verifyLocal = false }) {
  const evidenceById = new Map((evidence.items || []).map((item) => [item.id, item]));
  const citedIds = (rawCard?.citations || [])
    .map((citation) => text(citation?.evidence_id))
    .filter((id) => evidenceById.has(id));
  const eventId = eventIdFromEvidence(evidence);
  const eventDirectory = evidencePath ? path.dirname(path.resolve(evidencePath)) : null;
  const available = (item) => {
    if (!item?.locator?.local_path) return false;
    if (!verifyLocal) return true; // Historical v3 publications keep their old behavior.
    if (!eventDirectory) return false;
    const target = path.resolve(eventDirectory, item.locator.local_path);
    if (!target.startsWith(eventDirectory + path.sep)) return false;
    try { return fs.statSync(target).isFile(); } catch { return false; }
  };
  const citedVisual = (item) => {
    if (!item || (item.kind !== "ocr" &&
      !(item.kind === "asset" && ["video_frame", "image"].includes(item.locator?.asset_kind)))) return null;
    if (available(item)) return item;
    if (!verifyLocal || item.kind !== "ocr") return null;
    const imageRefs = [...new Set([text(item.locator?.source_image_ref),
      text(item.locator?.image_evidence_id)].filter(Boolean))];
    if (imageRefs.length !== 1) return null; // Conflicting or absent links are not guessed.
    const asset = evidenceById.get(imageRefs[0]);
    return asset?.kind === "asset" && ["video_frame", "image"].includes(asset.locator?.asset_kind)
      && available(asset) ? asset : null;
  };
  const visualItems = [...new Map(citedIds
    .map((id) => citedVisual(evidenceById.get(id)))
    .filter(Boolean)
    .map((item) => [item.id, item])).values()];
  const preview = (evidence.items || []).find((item) => item.kind === "asset" &&
    available(item) && ["video_frame", "image"].includes(item.locator?.asset_kind)) ||
    (evidence.items || []).find((item) => item.kind === "ocr" && available(item));
  const images = visualItems.length ? visualItems : (preview ? [preview] : []);
  const video = evidenceById.get("asset-video");
  const mediaUrl = (id) => `/published-media/${encodeURIComponent(sourceId)}/${encodeURIComponent(id)}`;
  return {
    kind: evidence.media?.kind || "unknown",
    coverUrl: images[0] ? mediaUrl(images[0].id) : null,
    coverRole: visualItems.length ? "evidence" : (preview ? "preview" : null),
    videoUrl: available(video) ? mediaUrl("asset-video") : null,
    imageUrls: images.map((item) => mediaUrl(item.id)),
    imageIds: images.map((item) => item.id),
    eventId
  };
}

function pathFromArgument(root, value) {
  return path.resolve(root, value || "");
}

function readBundle(runDirectory) {
  const candidatePath = path.join(runDirectory, "candidate.json");
  const evidencePath = path.join(runDirectory, "evidence.json");
  if (!fs.existsSync(candidatePath) || !fs.existsSync(evidencePath)) {
    throw new Error("运行目录必须同时包含 candidate.json 和 evidence.json。" );
  }
  return {
    candidate: readJson(candidatePath),
    evidence: readJson(evidencePath),
    candidatePath,
    evidencePath
  };
}

function writePublicationAtomic(target, publication) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(publication, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw cleanupError; }
    throw error;
  }
}

function archivePublication({ root, sourceId, previousText }) {
  const archivePath = path.join(root, "runtime", "card-library", "history", safePathSegment(sourceId), `${sha256(previousText)}.json`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  try { fs.writeFileSync(archivePath, previousText, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST" || fs.readFileSync(archivePath, "utf8") !== previousText) throw error;
  }
  return archivePath;
}

function topicDecision({ fixture, taxonomy, acceptSuggestions }) {
  const normalizations = normaliseTopics({ topics: fixture.topics, cards: fixture.cards, taxonomy });
  const topicIdMap = new Map();
  const topics = normalizations.map((item, index) => {
    const rawTopic = fixture.topics[index];
    const suggestion = item.suggestions?.[0];
    const accepted = item.status === "matched" || (acceptSuggestions && item.status === "needs_review" && suggestion);
    const id = accepted
      ? (item.canonical_topic_id || suggestion.topic_id)
      : `topic_provisional_${shortHash(item.raw_title || rawTopic.title)}`;
    const title = accepted
      ? (item.canonical_title || suggestion.title)
      : item.raw_title;
    topicIdMap.set(rawTopic.id, id);
    return {
      id,
      title,
      aliases: Array.isArray(rawTopic.aliases) ? rawTopic.aliases : [],
      normalization_status: accepted ? "matched" : (item.status === "needs_review" ? "needs_review" : "provisional"),
      raw_title: item.raw_title,
      ...(suggestion ? { suggestion } : {})
    };
  });
  return { topics, topicIdMap, normalizations };
}

function catalogTopicDecision({ fixture, candidate, catalog }) {
  const known = new Map((catalog.topics || []).map((topic) => [topic.id, topic]));
  const declared = new Map((candidate.topics || []).map((topic) => [text(topic.title), topic]));
  const topicIdMap = new Map();
  const normalizations = [];
  const topics = fixture.topics.map((rawTopic) => {
    const raw = declared.get(text(rawTopic.title));
    if (!raw) throw new Error(`编译候选缺少主题声明：${rawTopic.title}`);
    const canonical = raw.catalog_id ? known.get(raw.catalog_id) : null;
    if (raw.catalog_id && (!canonical || canonical.title !== rawTopic.title)) {
      throw new Error(`主题目录 ID 与标题不一致：${raw.catalog_id} / ${rawTopic.title}`);
    }
    const id = canonical?.id || `topic_provisional_${shortHash(rawTopic.title)}`;
    topicIdMap.set(rawTopic.id, id);
    normalizations.push({ raw_title: rawTopic.title, status: canonical ? "matched" : "provisional",
      canonical_topic_id: canonical?.id || null, canonical_title: canonical?.title || null,
      ...(raw.proposed_reason ? { proposed_reason: raw.proposed_reason } : {}) });
    return { id, title: canonical?.title || rawTopic.title, aliases: canonical?.aliases || [],
      normalization_status: canonical ? "matched" : "provisional", raw_title: rawTopic.title };
  });
  return { topics, topicIdMap, normalizations };
}

export function publishFixture({ root, runDirectory, databasePath, acceptSuggestions = false,
  replaceExisting = false, writePublication = writePublicationAtomic }) {
  const bundle = readBundle(runDirectory);
  const inputRecord = freshInputRecord(bundle.evidence);
  inputRecord.markdown_sha256 = sha256(JSON.stringify(bundle.evidence));
  inputRecord.raw_markdown = JSON.stringify(bundle.evidence, null, 2);
  const referenceFixture = freshReferenceFixture(bundle.evidence);
  const normalised = normaliseModelCandidate({
    referenceFixture,
    inputRecord,
    candidate: bundle.candidate
  });
  if (normalised.status !== "normalised") {
    throw new Error("候选未通过结构校验，不能发布：" + (normalised.errors || []).map((item) => item.message).join("；"));
  }
  const isDraft = bundle.candidate.compiler_origin === CARD_DRAFT_VERSION;
  if (!isDraft) throw new Error('技术预览仅支持 hermes/card-draft/v1 候选协议');
  const decisions = catalogTopicDecision({ fixture: normalised.fixture, candidate: bundle.candidate,
    catalog: readJson(path.join(root, "app", "public", "topic-catalog.json")) });
  const rawCardsByTitle = new Map((bundle.candidate.cards || []).map((card) => [text(card.title), card]));
  const fixture = {
    ...normalised.fixture,
    fixture_id: "published_" + safePathSegment(bundle.evidence.source.id),
    source: {
      ...normalised.fixture.source,
      kind: normalised.fixture.source.kind === "douyin_post" ? "video" : normalised.fixture.source.kind,
      note_path: path.relative(root, bundle.evidencePath)
    },
    topics: decisions.topics,
    cards: normalised.fixture.cards.map((card) => {
      const rawCard = rawCardsByTitle.get(text(card.title));
      const citedIds = (rawCard?.citations || []).map((citation) => text(citation?.evidence_id)).filter(Boolean);
      const media = cardMedia({ root, sourceId: bundle.evidence.source.id, evidence: bundle.evidence, evidencePath: bundle.evidencePath,
        rawCard, verifyLocal: isDraft });
      return {
        ...card,
        topic_ids: card.topic_ids.map((topicId) => decisions.topicIdMap.get(topicId) || topicId),
        evidence_ids: citedIds,
        image_ids: media.imageIds,
        media
      };
    })
  };
  const publication = {
    schema_version: "hermes/published-card-bundle/v1",
    published_at: new Date().toISOString(),
    generation_rules_version: GENERATION_RULES_VERSION,
    ...(isDraft ? { compiler_origin: CARD_DRAFT_VERSION } : {}),
    source_id: bundle.evidence.source.id,
    candidate_run_directory: path.relative(root, runDirectory),
    candidate_path: path.relative(root, bundle.candidatePath),
    evidence_path: path.relative(root, bundle.evidencePath),
    topic_decisions: decisions.normalizations,
    accept_suggestions: Boolean(acceptSuggestions),
    fixture
  };
  const publicationDirectory = path.join(root, "runtime", "card-library", "published");
  const publicationPath = path.join(publicationDirectory, safePathSegment(bundle.evidence.source.id) + ".json");
  const previousText = fs.existsSync(publicationPath) ? fs.readFileSync(publicationPath, "utf8") : null;
  const previous = previousText === null ? null : JSON.parse(previousText);
  if (previous && previous.source_id !== bundle.evidence.source.id) {
    throw new Error("已有发布物的来源 ID 与目标路径不一致，拒绝覆盖。");
  }
  const differentRun = previous && path.resolve(root, previous.candidate_run_directory || "") !== path.resolve(runDirectory);
  if (isDraft && differentRun && !replaceExisting) {
    throw new Error("该来源已有不同版本；须明确审核并选择替换，不能自动覆盖。");
  }
  if (replaceExisting && !isDraft) throw new Error("显式来源替换仅支持已编译的草稿候选。");
  const archivePath = differentRun && replaceExisting
    ? archivePublication({ root, sourceId: bundle.evidence.source.id, previousText }) : null;
  if (archivePath) publication.previous_publication_archive = path.relative(root, archivePath);

  // Keep SQLite as the durable card-engine store as well. The JSON publication
  // retains presentation and topic-review metadata needed by the local UI.
  const storage = persistRun({
    databasePath,
    fixture,
    inputRecord,
    runId: "publish_" + safePathSegment(bundle.evidence.source.id) + "_" + shortHash(path.relative(root, runDirectory)),
    validation: { status: "passed", source: "fresh_candidate_publication" },
    replaceSourceCards: isDraft
  });
  writePublication(publicationPath, publication);
  return {
    publication_path: publicationPath,
    fixture,
    topic_decisions: decisions.normalizations,
    storage,
    archive_path: archivePath
  };
}

export function readPublishArguments(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  return {
    runDirectory: value("--run-dir"),
    databasePath: value("--database") || "runtime/card-engine.sqlite",
    acceptSuggestions: argv.includes("--accept-suggestions")
  };
}

export function runPublishCli({ argv = process.argv.slice(2), root = process.cwd() } = {}) {
  const args = readPublishArguments(argv);
  if (!args.runDirectory) {
    console.error("用法：node runner/promote-fresh-candidate.mjs --run-dir <fresh run directory> [--accept-suggestions]");
    return 1;
  }
  try {
    const result = publishFixture({
      root,
      runDirectory: pathFromArgument(root, args.runDirectory),
      databasePath: pathFromArgument(root, args.databasePath),
      acceptSuggestions: args.acceptSuggestions
    });
    console.log("已发布本地卡片：" + result.publication_path);
    console.log("卡片数：" + result.fixture.cards.length + "；主题数：" + result.fixture.topics.length);
    console.log("SQLite 卡片总数：" + result.storage.after_card_count);
    result.topic_decisions.forEach((item) => {
      const suggestion = item.suggestions?.[0];
      console.log("Topic：" + item.raw_title + " → " + (suggestion?.title || item.raw_title) + "（" + item.status + "）");
    });
    return 0;
  } catch (error) {
    console.error("发布失败：" + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runPublishCli();
}
