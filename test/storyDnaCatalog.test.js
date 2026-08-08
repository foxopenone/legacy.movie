import test from "node:test";
import assert from "node:assert/strict";
import {
  listArchivePopular,
  listGutendexPopular,
  normalizeArchiveId,
  normalizeWikidataId,
  searchArchiveFilms,
  searchCatalogCross,
  searchWikidataFilms
} from "../lib/storyDnaCatalog.js";

test("normalizeWikidataId accepts Q ids", () => {
  assert.equal(normalizeWikidataId("q25188"), "Q25188");
  assert.equal(normalizeWikidataId("wikidata-Q11424"), "Q11424");
  assert.equal(normalizeWikidataId("nope"), "");
});

test("normalizeArchiveId accepts archive identifiers", () => {
  assert.equal(normalizeArchiveId("sex_madness"), "sex_madness");
  assert.equal(normalizeArchiveId("../bad"), "");
});

test("listGutendexPopular returns browsable page", async () => {
  const payload = await listGutendexPopular({ page: 1 });
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.length > 0);
  assert.equal(payload.results[0].source_kind, "gutendex");
});

test("searchWikidataFilms finds film entities", async () => {
  const payload = await searchWikidataFilms("Inception", { limit: 5 });
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.length > 0);
  assert.equal(payload.results[0].source_kind, "wikidata");
  assert.match(String(payload.results[0].id), /^Q\d+$/);
});

test("listArchivePopular returns feature films", async () => {
  const payload = await listArchivePopular({ page: 1 });
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.length > 0);
  assert.equal(payload.results[0].source_kind, "archive");
});

test("searchArchiveFilms finds movies", async () => {
  const payload = await searchArchiveFilms("Chaplin", { limit: 5 });
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.length > 0);
  assert.equal(payload.results[0].source_kind, "archive");
});

test("searchCatalogCross returns wikidata archive and gutendex groups", async () => {
  const payload = await searchCatalogCross("Frankenstein", { limit: 4 });
  assert.ok(Array.isArray(payload.groups.wikidata));
  assert.ok(Array.isArray(payload.groups.archive));
  assert.ok(Array.isArray(payload.groups.gutendex));
});
