import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso } from "./utils.mjs";

function json(value) {
  return JSON.stringify(value ?? null);
}

export function persistRun({ databasePath, fixture, inputRecord, runId, validation, replaceSourceCards = false }) {
  if (replaceSourceCards && !fixture.cards?.length) {
    throw new Error("来源替换至少需要一张经过校验的卡片，拒绝清空来源。");
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      evidence_scope TEXT NOT NULL,
      status TEXT NOT NULL,
      note_path TEXT NOT NULL,
      markdown_sha256 TEXT NOT NULL,
      raw_markdown TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id),
      fixture_id TEXT NOT NULL,
      type TEXT NOT NULL,
      subtype TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      content_fields_json TEXT NOT NULL,
      paths_json TEXT NOT NULL,
      resources_json TEXT NOT NULL,
      citations_json TEXT NOT NULL,
      missing_json TEXT NOT NULL,
      identity_conflicts_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_topics (
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      topic_id TEXT NOT NULL REFERENCES topics(id),
      PRIMARY KEY (card_id, topic_id)
    );
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_members (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (collection_id, card_id)
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      fixture_id TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES sources(id),
      input_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      validation_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const beforeCardCount = db.prepare("SELECT COUNT(*) AS count FROM cards").get().count;
  const timestamp = nowIso();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO sources (id, kind, title, evidence_scope, status, note_path, markdown_sha256, raw_markdown, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, evidence_scope = excluded.evidence_scope,
        status = excluded.status, note_path = excluded.note_path, markdown_sha256 = excluded.markdown_sha256,
        raw_markdown = excluded.raw_markdown, updated_at = excluded.updated_at
    `).run(
      fixture.source.id,
      fixture.source.kind,
      fixture.source.title,
      fixture.source.evidence_scope,
      fixture.source.status,
      fixture.source.note_path,
      inputRecord.markdown_sha256,
      inputRecord.raw_markdown,
      timestamp
    );

    fixture.topics.forEach((topic) => {
      db.prepare(`
        INSERT INTO topics (id, title, aliases_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, aliases_json = excluded.aliases_json, updated_at = excluded.updated_at
      `).run(topic.id, topic.title, json(topic.aliases || []), timestamp);
    });

    fixture.cards.forEach((card) => {
      const owner = db.prepare("SELECT source_id FROM cards WHERE id = ?").get(card.id);
      if (owner && owner.source_id !== fixture.source.id) {
        throw new Error(`卡片 ID ${card.id} 已属于其他来源，拒绝跨来源覆盖。`);
      }
      db.prepare(`
        INSERT INTO cards (id, source_id, fixture_id, type, subtype, title, status, content_fields_json, paths_json, resources_json, citations_json, missing_json, identity_conflicts_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_id = excluded.source_id, fixture_id = excluded.fixture_id, type = excluded.type, subtype = excluded.subtype,
          title = excluded.title, status = excluded.status, content_fields_json = excluded.content_fields_json,
          paths_json = excluded.paths_json, resources_json = excluded.resources_json, citations_json = excluded.citations_json,
          missing_json = excluded.missing_json, identity_conflicts_json = excluded.identity_conflicts_json, updated_at = excluded.updated_at
      `).run(
        card.id, fixture.source.id, fixture.fixture_id, card.type, card.subtype || null, card.title, card.status,
        json(card.content_fields || []), json(card.paths || []), json(card.resources || []), json(card.citations || []),
        json(card.missing || []), json(card.identity_conflicts || []), timestamp
      );
      db.prepare("DELETE FROM card_topics WHERE card_id = ?").run(card.id);
      card.topic_ids.forEach((topicId) => {
        db.prepare("INSERT INTO card_topics (card_id, topic_id) VALUES (?, ?)").run(card.id, topicId);
      });
    });

    fixture.collections.forEach((collection) => {
      const owner = db.prepare("SELECT source_id FROM collections WHERE id = ?").get(collection.id);
      if (owner && owner.source_id !== fixture.source.id) {
        throw new Error(`卡组 ID ${collection.id} 已属于其他来源，拒绝跨来源覆盖。`);
      }
      db.prepare(`
        INSERT INTO collections (id, source_id, kind, title, description, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, kind = excluded.kind, title = excluded.title,
          description = excluded.description, updated_at = excluded.updated_at
      `).run(collection.id, fixture.source.id, collection.kind, collection.title, collection.description || null, timestamp);
      db.prepare("DELETE FROM collection_members WHERE collection_id = ?").run(collection.id);
      (collection.member_card_ids || []).forEach((cardId, position) => {
        db.prepare("INSERT INTO collection_members (collection_id, card_id, position) VALUES (?, ?, ?)")
          .run(collection.id, cardId, position);
      });
    });

    if (replaceSourceCards) {
      const collectionIds = fixture.collections.map((collection) => collection.id);
      if (collectionIds.length) {
        db.prepare(`DELETE FROM collections WHERE source_id = ? AND id NOT IN (${collectionIds.map(() => '?').join(', ')})`)
          .run(fixture.source.id, ...collectionIds);
      } else {
        db.prepare("DELETE FROM collections WHERE source_id = ?").run(fixture.source.id);
      }
      const cardIds = fixture.cards.map((card) => card.id);
      db.prepare(`DELETE FROM cards WHERE source_id = ? AND id NOT IN (${cardIds.map(() => '?').join(', ')})`)
        .run(fixture.source.id, ...cardIds);
    }

    db.prepare(`
      INSERT INTO runs (run_id, fixture_id, source_id, input_sha256, status, validation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET fixture_id = excluded.fixture_id, source_id = excluded.source_id,
        input_sha256 = excluded.input_sha256, status = excluded.status, validation_json = excluded.validation_json
    `).run(runId, fixture.fixture_id, fixture.source.id, inputRecord.markdown_sha256, "passed", json(validation), timestamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  const afterCardCount = db.prepare("SELECT COUNT(*) AS count FROM cards").get().count;
  const runCount = db.prepare("SELECT COUNT(*) AS count FROM runs").get().count;
  db.close();

  return { before_card_count: beforeCardCount, after_card_count: afterCardCount, total_run_count: runCount };
}
