import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCES = {
  catalog: 'https://developers.cloudflare.com/workers-ai/models/',
  pricing: 'https://developers.cloudflare.com/workers-ai/platform/pricing/index.md',
  billing: 'https://developers.cloudflare.com/ai-gateway/features/unified-billing/index.md',
};
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const round = (n) => Number(n.toPrecision(14));
const hash = (s) => createHash('sha256').update(s).digest('hex');
const sortObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'en')));

function nonNegativeNumber(value) {
  const number = Number(value.replaceAll(',', ''));
  if (!Number.isFinite(number) || number < 0) throw Error(`Invalid numeric price: ${value}`);
  return number;
}

function decode(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function parseCatalog(html) {
  const models = [];
  for (const [tag] of html.matchAll(/<div\b[^>]*\bdata-models-cell\b[^>]*>/g)) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
    const id = attrs['data-model-id'];
    if (!/^@(?:cf|hf)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id ?? '')) throw Error('Invalid catalog model ID');
    const href = attrs['data-model-href'];
    if (!/^\/workers-ai\/models\/[A-Za-z0-9_.-]+\/$/.test(href ?? '')) throw Error(`Invalid model href: ${id}`);
    models.push({ id, task: attrs['data-model-task'], url: new URL(href, SOURCES.catalog).href, price_text: attrs['data-model-pricing'] ?? '' });
  }
  const declared = html.match(/We found\s*(?:<[^>]*>\s*)*(\d+)\s*(?:<[^>]*>\s*)*models/);
  if (!models.length || new Set(models.map((m) => m.id)).size !== models.length) throw Error('Empty/duplicate catalog');
  if (!declared || Number(declared[1]) !== models.length) throw Error('Catalog count mismatch or changed HTML');
  return models.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function splitCell(s) { return s.split(/<br\s*\/?\s*>/i).map((x) => x.trim()).filter(Boolean); }

export function parsePricing(markdown) {
  const cleaned = markdown.replace(/\*\*/g, '');
  const rate = cleaned.match(/priced at\s+\$([\d.]+)\s+per\s+1,000\s+Neurons/i);
  const free = cleaned.match(/total of\s+([\d,]+)\s+Neurons per day/i);
  if (!rate || !free || Number(rate[1]) <= 0) throw Error('Missing neuron conversion/free allocation');
  const rows = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) section = line.slice(3).trim();
    if (!/^\|\s*@(?:cf|hf)\//.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (cells.length !== 3) throw Error('Pricing table shape changed');
    const name = cells[0].match(/^(@(?:cf|hf)\/[^\s]+)(?:\s+\(([^)]+)\))?$/);
    if (!name) throw Error(`Invalid pricing row: ${cells[0]}`);
    const parseRates = (cell, pattern) => splitCell(cell).map((part) => {
      const m = part.match(pattern);
      if (!m) throw Error(`Unrecognized rate: ${part}`);
      return { amount: nonNegativeNumber(m[1]), unit: m[2].trim() };
    });
    rows.push({ id: name[1], variant: name[2] ?? 'default', section,
      usd: parseRates(cells[1], /^\$([\d,.]+)\s+per\s+(.+)$/i),
      neurons: parseRates(cells[2], /^([\d,.]+)\s+neurons\s+per\s+(.+)$/i) });
  }
  if (rows.length < 10) throw Error('Unexpectedly small pricing table');
  if (new Set(rows.map((r) => `${r.id}:${r.variant}`)).size !== rows.length) throw Error('Duplicate pricing rows');
  return { usd_per_1000_neurons: nonNegativeNumber(rate[1]), free_neurons_per_day: nonNegativeNumber(free[1]), rows };
}

export function parseFee(markdown) {
  const m = markdown.replace(/\*\*/g, '').match(/([\d.]+)% fee is applied to all credits purchased/i);
  if (!m || Number(m[1]) < 0 || Number(m[1]) > 100) throw Error('Cannot verify Unified Billing purchase fee');
  return nonNegativeNumber(m[1]) / 100;
}

const TOKEN_UNITS = {
  'M input tokens': 'input', 'M output tokens': 'output',
  'M cached input tokens': 'cache_read', 'M cache write tokens': 'cache_write',
};
const CARD_FIELDS = { Input: 'input', Output: 'output', 'Cached input': 'cache_read', 'Cache write': 'cache_write' };

export function catalogTokenPrices(text) {
  const rates = {};
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const m = line.match(/^(Input|Output|Cached input|Cache write) \(per 1M tokens\): \$([\d.]+)$/);
    if (m) {
      const key = CARD_FIELDS[m[1]];
      if (Object.hasOwn(rates, key)) throw Error(`Duplicate catalog rate: ${key}`);
      rates[key] = nonNegativeNumber(m[2]);
    } else if (/tokens/i.test(line)) {
      throw Error(`Unrecognized token pricing: ${line}`);
    }
  }
  return rates;
}

export function makeRatioConfig(records, multiplier) {
  const data = { model_ratio: {}, completion_ratio: {}, cache_ratio: {}, create_cache_ratio: {} };
  for (const r of records.filter((r) => r.status === 'token_priced')) {
    const p = r.usd_per_million_tokens;
    if (!(p.input > 0) || !Number.isFinite(p.input)) throw Error(`Unrepresentable input price: ${r.id}`);
    data.model_ratio[r.id] = round(p.input * multiplier / 2);
    // Embeddings/classification have no generated tokens; do not inherit a generic completion multiplier.
    data.completion_ratio[r.id] = round((p.output ?? 0) / p.input);
    if (p.cache_read !== undefined) data.cache_ratio[r.id] = round(p.cache_read / p.input);
    if (p.cache_write !== undefined) data.create_cache_ratio[r.id] = round(p.cache_write / p.input);
  }
  for (const key of Object.keys(data)) data[key] = sortObject(data[key]);
  return { success: true, message: '', data };
}

export function build(catalog, pricing, fee) {
  const warnings = [];
  const records = catalog.map((model) => {
    const rows = pricing.rows.filter((r) => r.id === model.id);
    const row = rows.find((r) => r.variant === 'default');
    const usd = {};
    const provenance = {};
    for (const rate of row?.neurons ?? []) {
      const key = TOKEN_UNITS[rate.unit];
      if (!key) continue;
      if (Object.hasOwn(usd, key)) throw Error(`Duplicate token unit: ${model.id}`);
      usd[key] = round(rate.amount * pricing.usd_per_1000_neurons / 1000);
      provenance[key] = 'pricing_table_neurons';
    }
    const card = catalogTokenPrices(model.price_text);
    for (const [key, price] of Object.entries(card)) {
      if (usd[key] === undefined) {
        usd[key] = price;
        provenance[key] = 'catalog_usd';
      } else if (Math.abs(usd[key] - price) > Math.max(0.00001, price * 0.02)) {
        throw Error(`Conflicting token price for ${model.id}/${key}: neurons=${usd[key]}, catalog=${price}`);
      }
    }
    for (const r of rows) {
      for (const rate of r.neurons) {
        const listed = r.usd.find((p) => p.unit === rate.unit);
        const calculated = round(rate.amount * pricing.usd_per_1000_neurons / 1000);
        if (listed && Math.abs(calculated - listed.amount) > Math.max(0.00001, listed.amount * 0.05)) {
          warnings.push({ model: model.id, variant: r.variant, unit: rate.unit,
            issue: 'official_usd_neuron_disagreement', published_usd: listed.amount, neuron_derived_usd: calculated });
        }
      }
    }
    let status = Object.hasOwn(usd, 'input') ? 'token_priced' : rows.length || model.price_text ? 'requires_unit_adapter' : 'price_not_published';
    if (status === 'token_priced' && /Text Generation|Translation/.test(model.task ?? '') && usd.output === undefined) {
      throw Error(`Missing output price: ${model.id}`);
    }
    return { ...model, status, usd_per_million_tokens: usd, price_basis: provenance,
      published_rates: rows.map((r) => ({ ...r, neuron_derived_usd: r.neurons.map((p) => ({ unit: p.unit, amount: round(p.amount * pricing.usd_per_1000_neurons / 1000) })) })) };
  });
  const base = makeRatioConfig(records, 1);
  if (!Object.keys(base.data.model_ratio).length) throw Error('No exportable token prices');
  return { records, warnings, base, withFee: makeRatioConfig(records, 1 + fee),
    report: {
      catalog_models: records.length,
      exported_token_models: records.filter((r) => r.status === 'token_priced').map((r) => r.id),
      requires_unit_adapter: records.filter((r) => r.status === 'requires_unit_adapter').map((r) => r.id),
      price_not_published: records.filter((r) => r.status === 'price_not_published').map((r) => r.id),
      pricing_rows_not_in_catalog: pricing.rows.filter((r) => !catalog.some((m) => m.id === r.id)).map((r) => ({ id: r.id, variant: r.variant })),
      warnings,
    } };
}

export function ensureNoLoss(previous, next) {
  if (!previous) return;
  for (const [field, entries] of Object.entries(previous.data ?? {})) {
    for (const id of Object.keys(entries)) {
      if (!Object.hasOwn(next.data[field] ?? {}, id)) throw Error(`Published price disappeared: ${field}/${id}. Review before replacing the baseline.`);
    }
  }
}

export function makeModelFiles(records, previousMapping = {}) {
  if (!previousMapping || Array.isArray(previousMapping) || typeof previousMapping !== 'object') throw Error('Model mapping must be a JSON object');
  const mapping = new Map(Object.entries(previousMapping));
  for (const [alias, target] of mapping) {
    if (!alias.trim() || typeof target !== 'string' || !target.trim()) throw Error(`Invalid model mapping: ${alias}`);
  }
  const ids = records.map((r) => r.id).sort();
  if (!ids.length || new Set(ids).size !== ids.length) throw Error('Empty/duplicate supported models');
  const generated = new Map();
  for (const id of ids) {
    if (!/^@(?:cf|hf)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id)) throw Error(`Invalid supported model ID: ${id}`);
    const alias = id.split('/').at(-1);
    if (generated.has(alias) && generated.get(alias) !== id) throw Error(`Ambiguous model alias: ${alias}`);
    if (mapping.has(alias) && mapping.get(alias) !== id) throw Error(`Existing model alias conflicts with catalog: ${alias}`);
    generated.set(alias, id);
  }
  return {
    models: ids.join(','),
    mapping: sortObject(Object.fromEntries(generated)),
  };
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'llm-meta-price-sync/1.0' } });
  if (!response.ok) throw Error(`HTTP ${response.status}: ${url}`);
  const text = await response.text();
  if (!text.trim() || text.length > 5_000_000) throw Error(`Unexpected response size: ${url}`);
  return text;
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/sync-cloudflare.mjs [--dry-run | --write]\nDefault: dry-run. Fetch public Cloudflare prices; --write updates managed prices, model list and mapping.');
    return;
  }
  if (args.some((a) => !['--dry-run', '--write'].includes(a)) || (args.includes('--dry-run') && args.includes('--write'))) throw Error('Invalid arguments; use --help');
  const [html, markdown, billing] = await Promise.all(Object.values(SOURCES).map(fetchText));
  const pricing = parsePricing(markdown);
  const fee = parseFee(billing);
  const result = build(parseCatalog(html), pricing, fee);
  const output = resolve(ROOT, 'newapi/ratio_config-v1.json');
  const previousText = await readOptional(output);
  if (previousText?.trim()) ensureNoLoss(JSON.parse(previousText), result.base);
  const oldCatalogText = await readOptional(resolve(ROOT, 'data/cloudflare-workers-ai.json'));
  if (oldCatalogText?.trim()) {
    const previousIds = JSON.parse(oldCatalogText).models.map((m) => m.id);
    const nextIds = new Set(result.records.map((m) => m.id));
    const removed = previousIds.filter((id) => !nextIds.has(id));
    if (removed.length) throw Error(`Catalog models disappeared; review removal before updating: ${removed.join(', ')}`);
  }
  const mappingText = await readOptional(resolve(ROOT, 'newapi/cf_models_mapping.json'));
  const modelFiles = makeModelFiles(result.records, mappingText === null ? {} : JSON.parse(mappingText));
  console.log(JSON.stringify({ mode: args.includes('--write') ? 'write' : 'dry-run', catalog_models: result.records.length,
    model_mapping_entries: Object.keys(modelFiles.mapping).length,
    exported_token_models: result.report.exported_token_models.length,
    requires_unit_adapter: result.report.requires_unit_adapter.length, price_not_published: result.report.price_not_published.length,
    warnings: result.warnings, fee }, null, 2));
  const managed = {
    'newapi/ratio_config-v1.json': result.base,
    'newapi/ratio_config-v1-with-fee.json': result.withFee,
    'newapi/cf_models.txt': modelFiles.models,
    'newapi/cf_models_mapping.json': modelFiles.mapping,
    'data/cloudflare-workers-ai.json': {
      schema_version: 1, currency: 'USD', sources: SOURCES,
      usd_per_1000_neurons: pricing.usd_per_1000_neurons,
      unified_billing_purchase_fee: fee,
      free_allocation: { neurons_per_account_per_day: pricing.free_neurons_per_day, reset: '00:00 UTC', applied_to_model_prices: false },
      models: result.records,
    },
    'data/sync-report.json': result.report,
  };
  // Finish parsing, coverage and loss checks before touching any published output.
  for (const [path, value] of Object.entries(managed)) {
    const target = resolve(ROOT, path);
    const content = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    if (await readOptional(target) === content) continue;
    console.log(`${args.includes('--write') ? 'WRITE' : 'WOULD WRITE'} ${path} sha256=${hash(content)}`);
    if (args.includes('--write')) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      if (await readFile(target, 'utf8') !== content) throw Error(`Readback failed: ${path}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
