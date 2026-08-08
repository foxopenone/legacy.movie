import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DNA_FIELDS,
  addUserFavorite,
  getDnaRecord,
  getDnaRecordsByIds,
  getUserFavorites,
  ingestStoryDna,
  listDnaRecords,
  normalizeDna,
  parseJsonObject,
  removeUserFavorite,
  saveDnaRecord,
  stableDnaId
} from "../lib/storyDnaEngine.js";

function withTempStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "story-dna-"));
  const prefs = fs.mkdtempSync(path.join(os.tmpdir(), "story-dna-prefs-"));
  const previousStore = process.env.STORY_DNA_STORE_DIR;
  const previousPrefs = process.env.STORY_DNA_PREFS_DIR;
  process.env.STORY_DNA_STORE_DIR = dir;
  process.env.STORY_DNA_PREFS_DIR = prefs;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (previousStore === undefined) delete process.env.STORY_DNA_STORE_DIR;
      else process.env.STORY_DNA_STORE_DIR = previousStore;
      if (previousPrefs === undefined) delete process.env.STORY_DNA_PREFS_DIR;
      else process.env.STORY_DNA_PREFS_DIR = previousPrefs;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(prefs, { recursive: true, force: true });
    });
}

function fullDna(prefix = "x") {
  const dna = {};
  for (const field of DNA_FIELDS) dna[field] = `${prefix} ${field} sentence one. Sentence two.`;
  return dna;
}

test("parseJsonObject accepts raw and fenced JSON", () => {
  assert.equal(parseJsonObject('{"high_concept":"a"}').high_concept, "a");
  assert.equal(parseJsonObject('```json\n{"high_concept":"b"}\n```').high_concept, "b");
});

test("normalizeDna requires all 10 fields", () => {
  assert.throws(() => normalizeDna({ high_concept: "only one" }), /missing fields/);
  assert.equal(Object.keys(normalizeDna(fullDna("ok"))).length, 10);
});

test("stableDnaId formats source keys", () => {
  assert.equal(stableDnaId("tmdb", 603), "tmdb-603");
  assert.equal(stableDnaId("gutendex", 345), "gutendex-345");
});

test("id-only ingest extracts once and dedupes with auto favorite", async () => {
  await withTempStore(async () => {
    let extractCount = 0;
    const deps = {
      resolveTmdb: async () => ({
        title: "The Matrix",
        synopsis: "A hacker learns reality is a simulation.",
        source: { kind: "tmdb", tmdb_id: 603, gutendex_id: null, synopsis: "A hacker learns reality is a simulation." }
      }),
      extractDna: async () => {
        extractCount += 1;
        return fullDna("matrix");
      }
    };

    const first = await ingestStoryDna({ source: "tmdb", tmdb_id: 603, user_id: "user-a" }, deps);
    assert.equal(first.deduped, false);
    assert.equal(first.record.id, "tmdb-603");
    assert.equal(extractCount, 1);
    assert.deepEqual(first.favorite_ids, ["tmdb-603"]);

    const second = await ingestStoryDna({ source: "tmdb", tmdb_id: 603, user_id: "user-b" }, deps);
    assert.equal(second.deduped, true);
    assert.equal(extractCount, 1);
    assert.deepEqual(getUserFavorites("user-b").favorite_ids, ["tmdb-603"]);
    assert.equal(listDnaRecords().length, 1);
  });
});

test("manual ingest rejected", async () => {
  await withTempStore(async () => {
    await assert.rejects(
      () => ingestStoryDna({ title: "X", synopsis: "Y", user_id: "u1" }, { extractDna: async () => fullDna() }),
      /manual text ingest disabled/
    );
  });
});

test("favorites and batch ids", async () => {
  await withTempStore(async () => {
    saveDnaRecord({
      id: "tmdb-1",
      title: "One",
      source: { kind: "tmdb", tmdb_id: 1, synopsis: "s" },
      dna: fullDna("one"),
      created_by: "u1",
      created_at: "2026-08-01T00:00:00.000Z"
    });
    saveDnaRecord({
      id: "tmdb-2",
      title: "Two",
      source: { kind: "tmdb", tmdb_id: 2, synopsis: "s" },
      dna: fullDna("two"),
      created_by: "u1",
      created_at: "2026-08-02T00:00:00.000Z"
    });
    addUserFavorite("u1", "tmdb-1");
    addUserFavorite("u1", "tmdb-2");
    assert.deepEqual(getUserFavorites("u1").favorite_ids, ["tmdb-2", "tmdb-1"]);
    removeUserFavorite("u1", "tmdb-1");
    assert.deepEqual(getUserFavorites("u1").favorite_ids, ["tmdb-2"]);
    const batch = getDnaRecordsByIds(["tmdb-2", "tmdb-1", "tmdb-2", "missing"]);
    assert.equal(batch.length, 2);
    assert.equal(batch[0].id, "tmdb-2");
    assert.equal(getDnaRecord("tmdb-2").title, "Two");
  });
});
