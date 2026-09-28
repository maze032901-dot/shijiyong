function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function key(value) {
  return text(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function containsPhrase(haystack, needle) {
  const haystackKey = key(haystack);
  const needleKey = key(needle);
  return Boolean(needleKey) && needleKey.length >= 2 && haystackKey.includes(needleKey);
}

function taxonomyEntries(taxonomy) {
  return (Array.isArray(taxonomy?.topics) ? taxonomy.topics : [])
    .filter((topic) => object(topic) && text(topic.id) && text(topic.title))
    .map((topic) => ({
      id: text(topic.id),
      title: text(topic.title),
      aliases: Array.isArray(topic.aliases) ? topic.aliases.map(text).filter(Boolean) : [],
      matchTerms: Array.isArray(topic.match_terms) ? topic.match_terms.map(text).filter(Boolean) : [],
      status: text(topic.status) || "proposed",
      note: text(topic.note)
    }));
}

function scoreEntry(entry, corpus, rawTitle) {
  const names = [entry.title, ...entry.aliases];
  const exactName = names.find((name) => key(name) === key(rawTitle));
  if (exactName) return { score: 1000, matchKind: "exact", matchedTerms: [exactName] };

  const aliasMatches = names.filter((name) => containsPhrase(rawTitle, name) || containsPhrase(name, rawTitle));
  if (aliasMatches.length) {
    return { score: 700 + Math.max(...aliasMatches.map((name) => key(name).length)), matchKind: "alias", matchedTerms: aliasMatches };
  }

  const termMatches = entry.matchTerms.filter((term) => containsPhrase(corpus, term));
  if (!termMatches.length) return { score: 0, matchKind: "none", matchedTerms: [] };
  return {
    score: termMatches.reduce((total, term) => total + Math.min(key(term).length, 20), 0),
    matchKind: "term",
    matchedTerms: termMatches
  };
}

/**
 * Maps a model-generated Topic to a controlled taxonomy without changing the
 * raw model output. Exact/alias matches to active entries can be reused;
 * proposed entries are suggestions that require review; unknown topics stay
 * provisional so a single source cannot create a misleading permanent group.
 */
export function normaliseTopic({ rawTopic, cardTitles = [], taxonomy }) {
  const rawTitle = text(rawTopic?.title ?? rawTopic);
  if (!rawTitle) {
    return {
      raw_title: "",
      display_title: "待整理",
      status: "provisional",
      canonical_topic_id: null,
      canonical_title: null,
      match_kind: "none",
      matched_terms: [],
      suggestions: []
    };
  }

  const entries = taxonomyEntries(taxonomy);
  const corpus = [rawTitle, ...cardTitles.map(text).filter(Boolean)].join(" ");
  const ranked = entries
    .map((entry) => ({ entry, ...scoreEntry(entry, corpus, rawTitle) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.title.localeCompare(right.entry.title, "zh-CN"));

  const activeMatch = ranked.find((item) => item.entry.status === "active" && ["exact", "alias"].includes(item.matchKind));
  if (activeMatch) {
    return {
      raw_title: rawTitle,
      display_title: activeMatch.entry.title,
      status: "matched",
      canonical_topic_id: activeMatch.entry.id,
      canonical_title: activeMatch.entry.title,
      match_kind: activeMatch.matchKind,
      matched_terms: activeMatch.matchedTerms,
      suggestions: []
    };
  }

  const suggestions = ranked
    .filter((item) => item.entry.status === "proposed")
    .slice(0, 3)
    .map((item) => ({
      topic_id: item.entry.id,
      title: item.entry.title,
      match_kind: item.matchKind,
      matched_terms: item.matchedTerms,
      note: item.entry.note || "待人工确认后启用"
    }));
  if (suggestions.length) {
    return {
      raw_title: rawTitle,
      display_title: suggestions[0].title,
      status: "needs_review",
      canonical_topic_id: null,
      canonical_title: null,
      match_kind: suggestions[0].match_kind,
      matched_terms: suggestions[0].matched_terms,
      suggestions
    };
  }

  return {
    raw_title: rawTitle,
    display_title: rawTitle,
    status: "provisional",
    canonical_topic_id: null,
    canonical_title: null,
    match_kind: "none",
    matched_terms: [],
    suggestions: []
  };
}

export function normaliseTopics({ topics = [], cards = [], taxonomy }) {
  const cardTitles = cards.map((card) => text(card?.title)).filter(Boolean);
  return topics.map((topic) => normaliseTopic({ rawTopic: topic, cardTitles, taxonomy }));
}
