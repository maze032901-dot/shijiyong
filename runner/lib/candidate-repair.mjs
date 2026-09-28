function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

// Repair only the exact wrapper error where a model appends the three top-level
// arrays as an untitled topic. A topic with additional data is not disposable.
function hoistMisnestedArrays(candidate, repairs) {
  if (!Array.isArray(candidate.topics)
    || candidate.cards !== undefined
    || candidate.collections !== undefined
    || candidate.candidate_conflicts !== undefined) return;
  const misplaced = candidate.topics.filter((topic) => object(topic)
    && onlyKeys(topic, new Set(['cards', 'collections', 'candidate_conflicts']))
    && Array.isArray(topic.cards) && topic.cards.length > 0
    && Array.isArray(topic.collections)
    && Array.isArray(topic.candidate_conflicts));
  if (misplaced.length !== 1) return;
  const wrapper = misplaced[0];
  candidate.topics = candidate.topics.filter((topic) => topic !== wrapper);
  candidate.cards = wrapper.cards;
  candidate.collections = wrapper.collections;
  candidate.candidate_conflicts = wrapper.candidate_conflicts;
  repairs.push({ code: 'hoisted_misnested_candidate_arrays', message: '将误放在无标题主题内的卡片与集合数组移回顶层。' });
}

function unitEvidenceIds(unit) {
  return [...new Set([
    unit?.image?.evidence_id,
    ...(Array.isArray(unit?.ocr) ? unit.ocr.map((item) => item?.evidence_id) : []),
    ...(Array.isArray(unit?.asr) ? unit.asr.map((item) => item?.evidence_id) : [])
  ].filter(Boolean))];
}

/**
 * Deterministic, auditable repairs before the normal publication gates. The
 * caller retains the raw model response. Ambiguous or unknown citations are
 * left untouched so the ordinary citation validator can reject them.
 */
export function repairModelCandidate({ candidate, evidenceDocument, evidenceUnits }) {
  if (!object(candidate)) return { candidate, repairs: [] };
  const repaired = structuredClone(candidate);
  const repairs = [];
  hoistMisnestedArrays(repaired, repairs);

  const evidenceIds = new Set((evidenceDocument?.items || []).map((item) => item?.id));
  const unitById = new Map((evidenceUnits?.units || []).map((unit) => [unit.unit_id, unit]));
  for (const card of Array.isArray(repaired.cards) ? repaired.cards : []) {
    for (const citation of Array.isArray(card?.citations) ? card.citations : []) {
      const id = citation?.evidence_id;
      if (typeof id !== 'string' || evidenceIds.has(id)) continue;
      const unit = unitById.get(id);
      if (!unit) continue;
      const itemIds = unitEvidenceIds(unit);
      if (itemIds.length !== 1 || !evidenceIds.has(itemIds[0])) continue;
      citation.evidence_id = itemIds[0];
      repairs.push({ code: 'mapped_single_item_unit_citation', from: id, to: itemIds[0] });
    }
  }
  return { candidate: repaired, repairs };
}
