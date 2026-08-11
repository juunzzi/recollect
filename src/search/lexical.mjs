import MiniSearch from "minisearch";

/**
 * Tokenizer that handles both Latin words and CJK runs (Korean/Japanese/Chinese).
 * CJK runs are indexed as character bigrams so partial-word queries still match.
 */
export function tokenize(text) {
  const out = [];
  const norm = String(text || "").toLowerCase();
  for (const m of norm.matchAll(/[a-z0-9][a-z0-9_$.@/#-]*|[ᄀ-ᇿ㄰-㆏가-힣぀-ヿ一-鿿]+/g)) {
    const t = m[0];
    if (/^[a-z0-9]/.test(t)) {
      for (const w of t.split(/[^a-z0-9]+/)) if (w) out.push(w);
    } else {
      if (t.length === 1) out.push(t);
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    }
  }
  return out;
}

export function buildIndex(facts) {
  const index = new MiniSearch({
    fields: ["title", "body", "entities", "tags", "files"],
    storeFields: [],
    tokenize,
    searchOptions: {
      boost: { title: 2, entities: 2.5, tags: 1.5 },
      prefix: true,
      fuzzy: 0.1,
    },
  });
  index.addAll(
    facts.map((f) => ({
      id: f.id,
      title: f.title,
      body: f.body,
      entities: (f.meta.entities || []).join(" "),
      tags: (f.meta.tags || []).join(" "),
      files: (f.meta.files || []).join(" "),
    }))
  );
  return index;
}
