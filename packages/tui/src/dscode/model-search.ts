/**
 * dscode: the /model picker's row filter. Only the session's current provider is
 * listed, and typing narrows at once instead of acting as a shortcut: BM25 over the
 * model name (weight 3), the id (2) and the provider (1). Letters and digits split
 * into separate tokens, so `glm5` finds GLM 5.3, and the word still being typed
 * matches the tokens it starts (`kim` finds Kimi). Rows matching every word win
 * over rows matching some, and whatever matches is presented in alphabetical order of
 * the displayed label with digits compared naturally.
 *
 * @module dsh-code/dscode/model-search
 */

export interface DscodeModelRow {
  provider?: string
  providerName?: string
  model?: string
  modelName?: string
  [key: string]: unknown
}

export function dscodeFilterModels(rows, query, provider) {
  // One provider at a time: the picker lists the routes the session can actually select.
  const directory = provider === void 0 ? rows : rows.filter(row => row.provider === provider);
  const label = row => String(row.modelName ?? row.model ?? "");
  // Display order is the label itself, so the list reads alphabetically and digits inside a
  // name compare naturally ("GLM 5.2" before "GLM 5.3"); searching narrows rows, never re-ranks them.
  const byLabel = (left, right) => label(left).localeCompare(label(right), void 0, {
    numeric: true,
    sensitivity: "base"
  }) || String(left.model ?? "").localeCompare(String(right.model ?? "")) || String(left.provider ?? "").localeCompare(String(right.provider ?? ""));
  const tokenize = text => String(text ?? '').normalize('NFKC').toLowerCase().match(/[a-z]+|[0-9]+|[^\s\x00-\x7f]+/g) ?? [];
  const raw = String(query ?? '');
  const words = tokenize(raw);
  if (words.length === 0) return [...directory].sort(byLabel);
  const typing = /\s$/.test(raw) ? -1 : words.length - 1;
  const fields = [['modelName', 3], ['model', 2], ['providerName', 1], ['provider', 1]];
  const docs = directory.map(row => {
    const counts = new Map();
    let length = 0;
    for (const [field, weight] of fields) for (const token of tokenize(row[field])) { counts.set(token, (counts.get(token) ?? 0) + weight); length += weight; }
    return { row, counts, length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const frequency = (doc, word, prefix) => {
    if (!prefix) return doc.counts.get(word) ?? 0;
    let sum = 0;
    for (const [token, count] of doc.counts) if (token.startsWith(word)) sum += token === word ? count : count * 0.8;
    return sum;
  };
  const k1 = 1.2, b = 0.75;
  const terms = words.map((word, index) => {
    const matches = docs.map(doc => frequency(doc, word, index === typing));
    const found = matches.filter(value => value > 0).length;
    return { matches, idf: Math.log(1 + (docs.length - found + 0.5) / (found + 0.5)) };
  });
  const scored = docs.map((doc, index) => {
    let score = 0, hits = 0;
    for (const term of terms) {
      const tf = term.matches[index];
      if (tf <= 0) continue;
      hits += 1;
      score += term.idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * doc.length / average));
    }
    return { row: doc.row, score, hits };
  }).filter(entry => entry.hits > 0);
  const complete = scored.filter(entry => entry.hits === terms.length);
  return (complete.length > 0 ? complete : scored).map(entry => entry.row).sort(byLabel);
}
