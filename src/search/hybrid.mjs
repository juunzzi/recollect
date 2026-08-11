import { cosine } from "./embeddings.mjs";

const CANDIDATES = 50;

/**
 * Hybrid ranking. When embedding coverage is high the vector stream gates the
 * candidate set and BM25 boosts scores within it — semantic recall decides
 * what competes, lexical precision decides what wins, and rank-fusion noise
 * from weak lexical-only candidates stays out. With partial coverage we fall
 * back to a union so
 * facts without vectors can still surface. No embeddings at all → BM25 only.
 */
export async function hybridSearch({ facts, index, embMap, embedQuery, query, k = 8 }) {
  const lexHits = index.search(String(query).slice(0, 1000)).slice(0, CANDIDATES);
  const maxLex = lexHits[0]?.score || 1;
  const lexScore = new Map(lexHits.map((r) => [r.id, r.score / maxLex]));

  let qv = null;
  if (embedQuery && embMap && embMap.size > 0) {
    try {
      qv = await embedQuery(query, "query");
    } catch {
      qv = null;
    }
  }

  if (!qv) {
    return lexHits.slice(0, k).map((r) => ({ id: r.id, score: lexScore.get(r.id), via: "lexical" }));
  }

  const sem = [];
  for (const [id, vec] of embMap) sem.push([id, cosine(qv, vec)]);
  sem.sort((a, b) => b[1] - a[1]);
  const semTop = sem.slice(0, CANDIDATES);
  const semMax = semTop[0]?.[1] ?? 1;
  const semMin = semTop[semTop.length - 1]?.[1] ?? 0;
  const semNorm = new Map(
    semTop.map(([id, s]) => [id, semMax === semMin ? 1 : (s - semMin) / (semMax - semMin)])
  );

  const coverage = embMap.size / Math.max(1, facts.length);
  const candidateIds =
    coverage >= 0.8
      ? new Set(semNorm.keys())
      : new Set([...semNorm.keys(), ...lexScore.keys()]);

  const scored = [];
  for (const id of candidateIds) {
    const s = (semNorm.get(id) ?? 0) + (lexScore.get(id) ?? 0);
    scored.push({ id, score: s / 2, via: semNorm.has(id) ? "hybrid" : "lexical" });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Injection cut: drop hits far below the best hit. Single source of truth so
 * every injection path applies the same policy.
 */
export const INJECT_MIN_RATIO = 0.35;

export function cutLowRelevance(hits) {
  const top = hits[0]?.score || 0;
  return hits.filter((h) => h.score >= top * INJECT_MIN_RATIO);
}
