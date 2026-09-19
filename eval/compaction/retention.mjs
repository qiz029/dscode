// Deterministic context-retention measurement.
//
// Every v2 probe carries verbatim evidence quotes that `validateDataset`
// requires to exist inside the replayed transcript. Whether a checkpoint's
// model-facing context still carries those quotes can therefore be measured
// without the answering model and without the judge: no provider calls, no
// sampling variance, and no dependence on answer phrasing.
//
// `retained` is the strict signal (the whole quote survives on token
// boundaries). `termsRetained` is deliberately looser: it counts distinct >=4
// character words of the quote that still occur anywhere as standalone tokens,
// so a paraphrase that keeps the fact but rewrites the sentence does not score
// as total loss. That looseness is by design: an unrelated sentence reusing a
// common word can hold the term ratio up, so terms is a screening signal, never
// proof that the fact survived.
export function contextText(messages) {
  const parts = [];
  for (const message of messages) for (const block of message.content ?? []) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool-result') for (const inner of block.content ?? []) if (inner.type === 'text') parts.push(inner.text);
  }
  return parts.join('\n');
}

const normalize = text => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const tokensOf = text => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const termsOf = quote => new Set(tokensOf(quote).filter(value => value.length >= 4));

export function measureRetention(messages, probes) {
  // Both the quote and the terms match on token boundaries only, so a short
  // token cannot score as retained by sitting inside a longer identifier and a
  // quote cannot match a longer word that merely starts the same way.
  const haystack = ` ${tokensOf(normalize(contextText(messages))).join(' ')} `;
  const items = [];
  for (const probe of probes) {
    const quotes = probe.evidence ?? [];
    if (!quotes.length) continue;
    let retained = 0, terms = 0, termsRetained = 0;
    for (const evidence of quotes) {
      const quote = ` ${tokensOf(normalize(evidence.quote)).join(' ')} `;
      if (quote.trim() && haystack.includes(quote)) retained++;
      for (const term of termsOf(normalize(evidence.quote))) { terms++; if (haystack.includes(` ${term} `)) termsRetained++; }
    }
    items.push({ probe: probe.id, quotes: quotes.length, retained, terms, termsRetained });
  }
  if (!items.length) return null;
  const sum = field => items.reduce((total, item) => total + item[field], 0);
  const quotes = sum('quotes'), retained = sum('retained'), terms = sum('terms'), termsRetained = sum('termsRetained');
  return {
    quotes, retained, terms, termsRetained,
    quoteRatio: quotes ? retained / quotes : null,
    termRatio: terms ? termsRetained / terms : null,
    items,
  };
}
