function key(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

const allowedIntents = new Set(["function_entry", "method_options", "experience_judgement", "prompt_use", "concept_learning", "visual_reference", "general_retrieval"]);

function assertPresentationMatchesCard(card, presentation) {
  if (!presentation || !allowedIntents.has(presentation.intent)) throw new Error("卡面校准的 intent 不合法。");
  const fields = Array.isArray(presentation.featured_field_labels) ? presentation.featured_field_labels : null;
  const paths = Array.isArray(presentation.featured_path_titles) ? presentation.featured_path_titles : null;
  if (!fields || !paths || fields.length + paths.length === 0 || fields.length + paths.length > 8) {
    throw new Error("卡面校准必须选择 1–8 个字段或路径。");
  }
  const ownFields = new Set((card.content_fields || []).map((item) => item.label));
  const ownPaths = new Set((card.paths || []).map((item) => item.title));
  const unknown = [...fields.filter((item) => !ownFields.has(item)), ...paths.filter((item) => !ownPaths.has(item))];
  if (unknown.length) throw new Error("卡面校准引用了不存在的字段或路径：" + unknown.join("、"));
}

/** Applies separately stored human display choices without changing model evidence or facts. */
export function applyPresentationCalibration(fixture, calibration) {
  const selected = (calibration.overrides || []).filter((item) => item.fixture_id === fixture.fixture_id);
  if (!selected.length) return fixture;
  const next = structuredClone(fixture);
  selected.forEach((override) => {
    const card = next.cards.find((item) => key(item.title) === key(override.card_title));
    if (!card) throw new Error("卡面校准找不到卡片：" + override.card_title);
    assertPresentationMatchesCard(card, override.presentation);
    card.presentation = override.presentation;
  });
  return next;
}
