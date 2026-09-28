import fs from "node:fs";
import path from "node:path";
import { buildInputRecord } from "./markdown-adapter.mjs";
import { validateCandidate } from "./candidate-validator.mjs";
import { persistRun } from "./storage.mjs";
import { renderPreview } from "./renderer.mjs";
import { nowIso, readJson, safePathSegment, writeJson } from "./utils.mjs";

export function runFixture({ root, fixturePath, databasePath, previewPath, runId, candidateOverride, artifactRoot }) {
  const fixture = candidateOverride || readJson(fixturePath);
  const id = runId || safePathSegment(fixture.fixture_id + "_" + nowIso());
  const runDirectory = path.join(artifactRoot || path.join(root, "runtime", "runs"), fixture.fixture_id, id);
  fs.mkdirSync(runDirectory, { recursive: true });

  const inputRecord = buildInputRecord({ root, source: fixture.source });
  const validation = validateCandidate({ root, fixture, inputRecord });
  writeJson(path.join(runDirectory, "input-record.json"), inputRecord);
  writeJson(path.join(runDirectory, "evidence-package.json"), { source_id: fixture.source.id, evidence: inputRecord.evidence });
  writeJson(path.join(runDirectory, "candidate.json"), fixture);
  writeJson(path.join(runDirectory, "validation.json"), validation);

  if (validation.status !== "passed") {
    writeJson(path.join(runDirectory, "final-items.json"), { status: "rejected", reason: "候选卡未通过校验，因此没有写入数据库。" });
    return { status: "rejected", fixture_id: fixture.fixture_id, run_id: id, run_directory: runDirectory, validation };
  }

  const storage = persistRun({ databasePath, fixture, inputRecord, runId: id, validation });
  const finalItems = {
    status: "saved",
    fixture_id: fixture.fixture_id,
    source: fixture.source,
    topics: fixture.topics,
    cards: fixture.cards,
    collections: fixture.collections,
    storage
  };
  writeJson(path.join(runDirectory, "final-items.json"), finalItems);
  renderPreview({ fixture, inputRecord, outputPath: previewPath });

  return {
    status: "saved",
    fixture_id: fixture.fixture_id,
    run_id: id,
    run_directory: runDirectory,
    preview_path: previewPath,
    validation,
    storage
  };
}
