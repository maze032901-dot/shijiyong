import fs from "node:fs/promises";
import path from "node:path";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sourceKind(value) {
  if (value === "douyin_post") return "video";
  if (value === "gallery") return "note";
  return value || "other";
}

function status(value) {
  if (value === "unavailable") return "source_unavailable";
  if (value === "ready") return "ready";
  return "partial";
}

function selectedContent(card, content, paths) {
  const selected = [];
  for (const label of card.presentation?.featured_field_labels || []) {
    const field = content.find((item) => item.label === label);
    if (field) selected.push(field);
  }
  for (const title of card.presentation?.featured_path_titles || []) {
    const route = paths.find((item) => item.title === title);
    if (route) selected.push({ label: route.title, value: "", kind: "path" });
  }
  if (selected.length) return selected;
  return content.slice(0, 2);
}

export function normalizePublishedBundle(bundle, { resourceLabels = {} } = {}) {
  const fixture = bundle.fixture || bundle;
  const rawSource = fixture.source || {};
  const source = {
    id: `source_douyin_${rawSource.id || bundle.source_id || "unknown"}`,
    title: rawSource.title || "抖音收藏",
    author: rawSource.author || null,
    kind: sourceKind(rawSource.kind),
    originKind: "douyin",
    originalUrl: rawSource.source_url || rawSource.originalUrl || null,
    savedCopyUrl: rawSource.saved_copy_url || rawSource.savedCopyUrl || null,
    savedAt: rawSource.captured_at || rawSource.saved_at || bundle.published_at || null
  };
  const topics = (fixture.topics || []).map((topic) => ({
    id: topic.id,
    title: topic.title,
    aliases: topic.aliases || [],
    normalizationStatus: topic.normalization_status || "matched",
    rawTitle: topic.raw_title || topic.title,
    suggestion: topic.suggestion || null,
    cardIds: []
  }));
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  const collectionByCardId = new Map();
  for (const collection of fixture.collections || []) {
    if (collection.kind !== 'source_collection') continue;
    for (const cardId of collection.member_card_ids || []) {
      collectionByCardId.set(cardId, { id: collection.id, title: collection.title });
    }
  }
  const cards = (fixture.cards || []).map((card) => {
    const content = (card.content_fields || []).map((field) => ({
      label: field.label,
      value: field.value,
      kind: field.kind,
      claimKind: field.claim_kind,
      ...(Array.isArray(field.segments) ? { segments: field.segments } : {})
    }));
    const paths = (card.paths || []).map((item) => ({ title: item.title, steps: item.steps, status: item.status }));
    const cardTopics = (card.topic_ids || []).map((id) => topicMap.get(id)).filter(Boolean);
    const normalized = {
      id: card.id,
      type: card.type,
      subtype: card.subtype ?? null,
      title: card.title,
      collection: collectionByCardId.get(card.id) || null,
      topics: cardTopics.map((topic) => ({ id: topic.id, title: topic.title })),
      status: status(card.status),
      content,
      paths,
      resources: (card.resources || []).map((resource) => ({
        type: resource.type,
        label: resource.label || resourceLabels[resource.type] || "查看资源",
        url: resource.url ?? null,
        availability: resource.availability,
        note: resource.note ?? null
      })),
      actions: card.actions || [],
      relatedCardIds: card.related_card_ids || [],
      evidenceIds: card.evidence_ids || [],
      imageIds: card.image_ids || [],
      sources: [source],
      missing: card.missing || [],
      media: card.media || bundle.media || null,
      origin: "published_candidate",
      presentation: card.presentation || null,
      topicReview: cardTopics.map((topic) => ({
        topicId: topic.id,
        status: topic.normalizationStatus,
        rawTitle: topic.rawTitle,
        suggestion: topic.suggestion
      }))
    };
    normalized.generationRulesVersion = bundle.generation_rules_version || null;
    normalized.topicBinding = bundle.compiler_origin === 'hermes/card-draft/v1' ? 'catalog' : null;
    normalized.featuredContent = selectedContent(card, content, paths);
    for (const topic of cardTopics) topic.cardIds.push(card.id);
    return normalized;
  });
  return {
    topics,
    cards,
    awemeIds: rawSource.id ? [String(rawSource.id)] : []
  };
}

export async function loadPublishedLibrary({ directory, resourceLabels = {} }) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { topics: [], cards: [], awemeIds: [] };
    throw error;
  }
  const bundles = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
    try {
      bundles.push(JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8")));
    } catch {
      // A partially written publication is ignored; the source evidence remains.
    }
  }
  return bundles.reduce((library, bundle) => {
    const normalized = normalizePublishedBundle(bundle, { resourceLabels });
    library.topics.push(...normalized.topics);
    library.cards.push(...normalized.cards);
    library.awemeIds.push(...normalized.awemeIds);
    return library;
  }, { topics: [], cards: [], awemeIds: [] });
}
