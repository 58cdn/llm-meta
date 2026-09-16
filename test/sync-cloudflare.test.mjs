import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog, parsePricing, parseFee, catalogTokenPrices, build, ensureNoLoss, makeModelFiles } from '../scripts/sync-cloudflare.mjs';

const model = (id, task, price_text = '') => ({ id, task, price_text, url: 'https://developers.cloudflare.com/workers-ai/models/test/' });
const pricing = (rows) => ({ usd_per_1000_neurons: 0.011, free_neurons_per_day: 10000, rows });
const row = (id, neurons, usd = []) => ({ id, variant: 'default', section: 'LLM model pricing', neurons, usd });
const rate = (amount, unit) => ({ amount, unit });

test('neuron conversion, cache ratios and fee: $100 credit costs $105', () => {
  const id = '@cf/deepseek-ai/deepseek-v4-pro-0813';
  const result = build([model(id, 'Text Generation')], pricing([
    row(id, [rate(120000, 'M input tokens'), rate(360000, 'M output tokens'), rate(4000, 'M cached input tokens')]),
  ]), 0.05);
  assert.equal(result.base.data.model_ratio[id], 0.66);
  assert.equal(result.base.data.completion_ratio[id], 3);
  assert.ok(Math.abs(result.base.data.cache_ratio[id] - 1 / 30) < 1e-13);
  assert.equal(result.withFee.data.model_ratio[id], 0.693);
  assert.equal(result.withFee.data.cache_ratio[id], result.base.data.cache_ratio[id]);
  assert.equal(result.records[0].usd_per_million_tokens.cache_read, 0.044);
});

test('embeddings use precise neuron-derived input and zero completion', () => {
  const id = '@cf/baai/bge-m3';
  const result = build([model(id, 'Text Embeddings', 'Input (per 1M tokens): $0.0118')], pricing([row(id, [rate(1075, 'M input tokens')])]), 0.05);
  assert.equal(result.base.data.model_ratio[id], 0.0059125);
  assert.equal(result.base.data.completion_ratio[id], 0);
  assert.equal(Object.hasOwn(result.base.data.cache_ratio, id), false);
});

test('catalog cache supplements missing table field, explicit zero stays explicit', () => {
  const id = '@cf/test/model';
  const result = build([model(id, 'Text Generation', 'Input (per 1M tokens): $0.11\nOutput (per 1M tokens): $0.22\nCached input (per 1M tokens): $0')],
    pricing([row(id, [rate(10000, 'M input tokens'), rate(20000, 'M output tokens')])]), 0.05);
  assert.equal(result.base.data.cache_ratio[id], 0);
  assert.equal(result.records[0].price_basis.cache_read, 'catalog_usd');
});

test('minute/tile prices and unpublished models never become fake token prices', () => {
  const records = [model('@cf/test/embedding', 'Text Embeddings', 'Input (per 1M tokens): $0.1'),
    model('@cf/test/audio', 'Automatic Speech Recognition'), model('@cf/test/image', 'Text-to-Image'), model('@cf/test/missing', 'Text Generation')];
  const result = build(records, pricing([
    row('@cf/test/audio', [rate(46.63, 'audio minute')]), row('@cf/test/image', [rate(4.8, '512x512 tile')]),
  ]), 0.05);
  assert.deepEqual(Object.keys(result.base.data.model_ratio), ['@cf/test/embedding']);
  assert.equal(result.report.requires_unit_adapter.length, 2);
  assert.deepEqual(result.report.price_not_published, ['@cf/test/missing']);
});

test('large official discrepancies are exposed; token conflicts fail closed', () => {
  const audio = '@cf/test/audio';
  const r = build([model('@cf/test/embed', 'Text Embeddings', 'Input (per 1M tokens): $0.1'), model(audio, 'Audio')],
    pricing([row(audio, [rate(0.51, 'audio minute input')], [rate(0.00033795, 'audio minute input')])]), 0.05);
  assert.equal(r.warnings[0].issue, 'official_usd_neuron_disagreement');
  assert.throws(() => build([model('@cf/test/a', 'Text Generation', 'Input (per 1M tokens): $1\nOutput (per 1M tokens): $2')],
    pricing([row('@cf/test/a', [rate(10000, 'M input tokens')])]), 0.05), /Conflicting/);
});

test('catalog uses API ID case, not lowercase search name, and validates count', () => {
  const html = 'We found 1 models <div data-models-cell data-name="@cf/a/model-1b" data-model-id="@cf/a/model-1B" data-model-href="/workers-ai/models/model-1b/" data-model-task="Translation" data-model-pricing="Input (per 1M tokens): $0.1"></div>';
  assert.equal(parseCatalog(html)[0].id, '@cf/a/model-1B');
  assert.throws(() => parseCatalog(html.replace('found 1', 'found 2')), /count mismatch/);
  assert.throws(() => parseCatalog(html + html), /duplicate/);
});

test('pricing table preserves transport variants and comma-separated neuron values', () => {
  const head = 'priced at **$0.011 per 1,000 Neurons**. total of **10,000 Neurons per day**\n## Audio model pricing\n';
  const rows = Array.from({ length: 10 }, (_, i) => `| @cf/test/model-${i}${i === 0 ? ' (WebSocket)' : ''} | $0.015 per 1k characters input <br/> | 1,363.64 neurons per 1k characters input <br/> |`).join('\n');
  const p = parsePricing(head + rows);
  assert.equal(p.rows[0].variant, 'WebSocket');
  assert.equal(p.rows[0].neurons[0].amount, 1363.64);
  assert.equal(p.free_neurons_per_day, 10000);
  assert.throws(() => parsePricing(head + rows.replace('neurons per', 'newunits per')), /Unrecognized rate/);
});

test('fee/source format drift fails instead of defaulting to stale constants', () => {
  assert.equal(parseFee('A 5% fee is applied to all credits purchased through Unified Billing.'), 0.05);
  assert.throws(() => parseFee('new pricing'), /Cannot verify/);
  assert.throws(() => catalogTokenPrices('Input (per 1K tokens): $1'), /Unrecognized/);
  assert.throws(() => catalogTokenPrices('Input (per 1M tokens): $1..2'), /Invalid numeric/);
});

test('published price disappearance blocks replacement, including cached-price loss', () => {
  const prev = { data: { model_ratio: { a: 1 }, cache_ratio: { a: 0.1 } } };
  assert.throws(() => ensureNoLoss(prev, { data: { model_ratio: { a: 2 }, cache_ratio: {} } }), /disappeared/);
  assert.doesNotThrow(() => ensureNoLoss(prev, { data: { model_ratio: { a: 2 }, cache_ratio: { a: 0.2 } } }));
});

test('model list and mappings include unpriced models, preserve case and existing aliases', () => {
  const records = [{ id: '@cf/test/model-1B', status: 'price_not_published' }, { id: '@cf/baai/bge-m3', status: 'token_priced' }];
  const original = { external: 'vendor/external', legacy: '@cf/old/legacy' };
  const files = makeModelFiles(records, original);
  assert.equal(files.models, '@cf/baai/bge-m3,@cf/test/model-1B');
  assert.equal(files.mapping['model-1B'], '@cf/test/model-1B');
  assert.equal(files.mapping.external, 'vendor/external');
  assert.equal(files.mapping.legacy, '@cf/old/legacy');
  assert.deepEqual(files.preservedAliases, ['external', 'legacy']);
  assert.deepEqual(original, { external: 'vendor/external', legacy: '@cf/old/legacy' });
  assert.deepEqual(makeModelFiles([...records].reverse(), files.mapping), files);
});

test('conflicting aliases and invalid mappings fail before files can be replaced', () => {
  assert.throws(() => makeModelFiles([{ id: '@cf/a/same' }, { id: '@cf/b/same' }]), /Ambiguous/);
  assert.throws(() => makeModelFiles([{ id: '@cf/a/same' }], { same: 'other/same' }), /conflicts/);
  assert.throws(() => makeModelFiles([{ id: '@cf/a/same' }], []), /JSON object/);
  assert.throws(() => makeModelFiles([{ id: '@cf/a/same' }], { broken: null }), /Invalid model mapping/);
  assert.throws(() => makeModelFiles([{ id: '@cf/a/same' }, { id: '@cf/a/same' }]), /duplicate/);
});
