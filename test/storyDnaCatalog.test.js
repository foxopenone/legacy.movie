import test from "node:test";
import assert from "node:assert/strict";
import { listGutendexPopular, listTmdbPopular, searchCatalogCross } from "../lib/storyDnaCatalog.js";

test("listGutendexPopular returns browsable page", async () => {
  const payload = await listGutendexPopular({ page: 1 });
  assert.ok(Array.isArray(payload.results));
  assert.ok(payload.results.length > 0);
  assert.ok(payload.results[0].id > 0);
  assert.ok(String(payload.results[0].title).length > 0);
  assert.equal(payload.results[0].source_kind, "gutendex");
});

test("TMDB popular requires API key", async () => {
  const previous = process.env.TMDB_API_KEY;
  delete process.env.TMDB_API_KEY;
  try {
    await assert.rejects(() => listTmdbPopular({ page: 1 }), /TMDB_API_KEY/);
  } finally {
    if (previous === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = previous;
  }
});

test("searchCatalogCross groups gutendex even without TMDB key", async () => {
  const previous = process.env.TMDB_API_KEY;
  delete process.env.TMDB_API_KEY;
  try {
    const payload = await searchCatalogCross("dracula", { limit: 5 });
    assert.ok(payload.groups.gutendex.length > 0);
    assert.ok(payload.errors.some((item) => item.source === "tmdb"));
  } finally {
    if (previous === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = previous;
  }
});
