import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;

// --- Socket Mode Bolt app (no ExpressReceiver) ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,       // xoxb-...
  appToken: process.env.SLACK_APP_TOKEN,    // xapp-...
  socketMode: true,                         // <- key switch
  processBeforeResponse: true
});

/* =========================
   Config
========================= */
const PREFIX = (process.env.SKU_PREFIX || 'C').toUpperCase();
const SEP = (process.env.SKU_SEPARATOR || '-'); // '-' or '_' etc.
const SKU_TYPE_INDEX = Number(process.env.SKU_TYPE_INDEX ?? 2); // 0:C,1:CAR,2:TYPE
const SKU_CAR_INDEX  = Number(process.env.SKU_CAR_INDEX  ?? 1);

// Background refresh cadence (minutes). Default 20.
const REFRESH_INTERVAL_MIN = Math.max(5, parseInt(process.env.REFRESH_INTERVAL_MIN || '20', 10));
// Add small jitter so multiple apps don’t spike at the same instant.
const JITTER_SEC = Math.floor(Math.random() * 30);

// Shopify API version (centralized)
const SHOPIFY_VERSION = process.env.SHOPIFY_API_VERSION || '2025-10';

/* =========================
   Shopify Admin GraphQL
========================= */
async function shopifyGQL(query, variables) {
  const url = `https://${process.env.SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_VERSION}/graphql.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json',
      // Header is optional but explicit; URL version is what matters most
      'Shopify-API-Version': SHOPIFY_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopify HTTP ${resp.status}: ${text}`);
  }

  const json = await resp.json();

  if (json.errors && json.errors.length) {
    console.error('❗Shopify GraphQL errors:', JSON.stringify(json.errors, null, 2));
    throw new Error('Shopify GraphQL returned errors (see previous line).');
  }
  if (json.data && json.data.errors) {
    console.error('❗Shopify data.errors:', JSON.stringify(json.data.errors, null, 2));
    throw new Error('Shopify GraphQL returned data.errors (see previous line).');
  }

  return json;
}

// Sanity (no inventory fields)
const SANITY_GQL = `
  {
    shop { name }
    productVariants(first: 5) {
      edges { node { id sku title product { title } } }
    }
  }
`;

// Page all variants and read inventoryQuantity
const VARIANTS_PAGE_GQL = `
  query ($after: String) {
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          sku
          inventoryQuantity
          product { title handle }
        }
      }
    }
  }
`;

// Diagnostic “count without inventory” (helps if above ever fails)
const VARIANTS_PAGE_NOINV_GQL = `
  query ($after: String) {
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id sku } }
    }
  }
`;

async function sanityCheckShopify() {
  try {
    const data = await shopifyGQL(SANITY_GQL, {});
    const shopName = data?.data?.shop?.name || '(unknown shop)';
    const sample = (data?.data?.productVariants?.edges || []).map(e => e.node?.sku || '(empty)');
    console.log(`🧪 Shopify sanity: shop="${shopName}", sample SKUs: ${sample.join(' | ')}`);
    return true;
  } catch (err) {
    console.error('🧪 Shopify sanity check FAILED:', err);
    return false;
  }
}

async function countAllVariantsNoInventory() {
  let count = 0, after = null;
  try {
    while (true) {
      const res = await shopifyGQL(VARIANTS_PAGE_NOINV_GQL, { after });
      const edges = res?.data?.productVariants?.edges || [];
      count += edges.length;
      if (res?.data?.productVariants?.pageInfo?.hasNextPage) {
        after = res.data.productVariants.pageInfo.endCursor;
      } else break;
    }
    console.log(`🔢 Diagnostic: total variants WITHOUT inventory fields = ${count}`);
  } catch (e) {
    console.error('❗Diagnostic (no inventory) failed:', e);
  }
  return count;
}

/* =========================
   In-memory Index
========================= */
let skuIndex = {
  types: new Set(),               // Set<string>
  carsByType: new Map(),          // Map<type, Set<car>>
  inStockByTypeCar: new Map(),    // Map<`${type}::${car}`, Array<{sku, suffix, available}>>
  outOfStockByTypeCar: new Map(), // Map<`${type}::${car}`, Array<{sku, suffix, available: 0}>>
};

function parseSku(rawSku) {
  if (!rawSku) return null;
  const upper = String(rawSku).trim().toUpperCase();

  // Accept "C" or "C-" style beginnings
  if (!(upper === PREFIX || upper.startsWith(PREFIX + SEP))) return null;

  const parts = upper.split(SEP);
  if (parts.length <= Math.max(SKU_TYPE_INDEX, SKU_CAR_INDEX)) return null;

  const car  = (parts[SKU_CAR_INDEX]  || '').toUpperCase();
  const type = (parts[SKU_TYPE_INDEX] || '').toUpperCase();
  if (!car || !type) return null;

  // Suffix = everything AFTER the first three parts (prefix, car, type)
  const suffix = parts.slice(3).join(SEP); // may be empty if SKU has only 3 parts

  return { car, type, suffix, parts };
}

async function refreshSkuIndex() {
  const idx = { types: new Set(), carsByType: new Map(), inStockByTypeCar: new Map(), outOfStockByTypeCar: new Map() };

  let sample = { total: 0, listed: 0, items: [] };

  let after = null;
  try {
    while (true) {
      const data = await shopifyGQL(VARIANTS_PAGE_GQL, { after });
      const pv = data?.data?.productVariants;
      const edges = pv?.edges || [];

      for (const e of edges) {
        const v = e.node;
        const raw = (v.sku || '').trim();
        sample.total++;
        if (sample.listed < 20) { sample.items.push(raw || '(empty)'); sample.listed++; }

        const parsed = parseSku(raw);
        if (!parsed) continue;

        const { car, type, suffix } = parsed;
        const available = Number(v.inventoryQuantity ?? 0);

        idx.types.add(type);
        if (!idx.carsByType.has(type)) idx.carsByType.set(type, new Set());
        idx.carsByType.get(type).add(car);

        const key = `${type}::${car}`;
if (available > 0) {
  if (!idx.inStockByTypeCar.has(key)) idx.inStockByTypeCar.set(key, []);
  idx.inStockByTypeCar.get(key).push({
    sku: raw,
    suffix,       // for display
    available
  });
} else {
  // Only include OOS if product title does NOT contain "Z Internal"
  const title = (v?.product?.title || '').toUpperCase();
  if (!title.includes('Z INTERNAL')) {
    if (!idx.outOfStockByTypeCar.has(key)) idx.outOfStockByTypeCar.set(key, []);
    idx.outOfStockByTypeCar.get(key).push({
      sku: raw,
      suffix,
      available: 0
    });
  }
}
      }

      if (pv?.pageInfo?.hasNextPage) after = pv.pageInfo.endCursor; else break;
    }
  } catch (err) {
    console.error('❗Index build failed while fetching variants (inventoryQuantity):', err);
    await countAllVariantsNoInventory();
  }

  console.log('🔎 Sample SKUs:', sample.items.join(' | '));
  console.log(`🔢 Total variants scanned: ${sample.total}`);

  skuIndex = idx;
  const totalCars = [...idx.carsByType.values()].reduce((a, s) => a + s.size, 0);
  console.log(`🔄 SKU index refreshed: ${idx.types.size} types, ${totalCars} cars total`);
}

/* =========================
   Slack helpers (custom type order + slim text)
========================= */

// Your preferred type order
const TYPE_PRIORITY = [
  'STEERINGWHEEL',
  'MAGPADDLES',
  'PADDLES',
  'TRIM',
  'DRIVERASSISTMODULE',
  'AIRBAG',
  'BACKCOVER',
];

// Build TYPE options in custom order, then all others A→Z
function optionsFromTypesWithPriority(set) {
  const types = [...set].map(t => t.toUpperCase());
  const first = TYPE_PRIORITY.filter(t => types.includes(t));
  const rest = types.filter(t => !TYPE_PRIORITY.includes(t)).sort();
  const ordered = [...first, ...rest];
  return ordered.map(val => ({
    text: { type: 'plain_text', text: val, emoji: true },
    value: val,
  }));
}

// Generic A→Z options builder (used for cars)
function optionsFromSet(set) {
  return [...set].sort().slice(0, 100).map(val => ({
    text: { type: 'plain_text', text: val, emoji: true },
    value: val
  }));
}

// Sorting helpers
function sortByQtyDesc(arr) {
  return [...arr].sort((a, b) => b.available - a.available);
}
function sortBySuffixAsc(arr) {
  return [...arr].sort((a, b) => (a.suffix || '').localeCompare(b.suffix || ''));
}

// DEDUPE by full SKU (keep highest available just in case)
function dedupeBySku(variants) {
  const m = new Map(); // sku -> {sku,suffix,available}
  for (const v of variants) {
    const key = String(v.sku || '').trim().toUpperCase();
    const prev = m.get(key);
    if (!prev || v.available > prev.available) {
      m.set(key, { ...v, sku: key });
    }
  }
  return [...m.values()];
}

// Build blocks for ONE Slack message: header + multiple section blocks.
function buildBlocksOneMessage({ type, car, variants, headerLabel = 'In-Stock' }) {
  const header = `*${headerLabel}* — *Type:* ${type} • *Car:* ${car}`;
  const headerBlock = { type: 'section', text: { type: 'mrkdwn', text: header } };

  // Turn lines into chunks that keep each section’s mrkdwn < 3000 chars.
  const lines = variants.map(v => `• ${v.suffix || v.sku} — ${v.available}`);
  const blocks = [headerBlock];

  const MAX_BLOCKS = 50; // Slack limit
  const MAX_SECTIONS = MAX_BLOCKS - 1; // reserve 1 for header
  const MAX_CHARS = 2900; // conservative per-section mrkdwn limit

  let current = [];
  let currentLen = 0;
  let sections = 0;

  const flush = () => {
    const text = current.join('\n') || '_No matches_';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    current = [];
    currentLen = 0;
    sections += 1;
  };

  for (const line of lines) {
    if (currentLen + line.length + 1 > MAX_CHARS) {
      flush();
      if (sections >= MAX_SECTIONS) break; // safety cap
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length && sections < MAX_SECTIONS) flush();

  return blocks;
}

/* =========================
   Slash: /stock  (Single-modal)
========================= */
app.command('/stock', async ({ ack, body, client }) => {
  await ack();

  const typeOptions = optionsFromTypesWithPriority(skuIndex.types);
  if (!typeOptions.length) {
    await client.chat.postEphemeral({
      channel: body.channel_id,
      user: body.user_id,
      text: 'Index is building or empty. Try /stock-refresh. If it stays empty, check logs for errors.'
    });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'stock_picker_submit',
      title: { type: 'plain_text', text: 'Inventory Picker' },
      submit: { type: 'plain_text', text: 'Show Results' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({ channel: body.channel_id }),
      blocks: [
  // TYPE (static_select)
  {
    type: 'input',
    block_id: 'type_block',
    label: { type: 'plain_text', text: 'Choose a Product Type' },
    element: {
      type: 'static_select',
      action_id: 'ptype_select', // we'll listen to this to update the car list
      options: typeOptions,
      placeholder: { type: 'plain_text', text: 'e.g., STEERINGWHEEL' }
    }
  },

  // CAR (static_select) — starts with a "pick type first" placeholder
  {
    type: 'input',
    block_id: 'car_block',
    label: { type: 'plain_text', text: 'Choose a Car' },
    element: {
      type: 'static_select',
      action_id: 'car_select',
      options: [
        {
          text: { type: 'plain_text', text: '— Pick a Type first —' },
          value: '__disabled__'
        }
      ],
      initial_option: {
        text: { type: 'plain_text', text: '— Pick a Type first —' },
        value: '__disabled__'
      }
    }
  },

  // SORT (radio)
  {
    type: 'input',
    block_id: 'sort_block',
    label: { type: 'plain_text', text: 'Display order' },
    element: {
      type: 'radio_buttons',
      action_id: 'sort_choice',
      options: [
        { text: { type: 'plain_text', text: 'Alphabetical (A→Z)' }, value: 'alpha' },
        { text: { type: 'plain_text', text: 'Quantity (High → Low)' }, value: 'qtydesc' }
      ],
      initial_option: { text: { type: 'plain_text', text: 'Quantity (High → Low)' }, value: 'qtydesc' }
    }
  },

  // Include OOS? (radio)
  {
    type: 'input',
    block_id: 'oos_block',
    label: { type: 'plain_text', text: 'Show only in-stock? Or also include out-of-stock?' },
    element: {
      type: 'radio_buttons',
      action_id: 'oos_choice',
      options: [
        { text: { type: 'plain_text', text: 'Only show in-stock SKUs' }, value: 'in_only' },
        { text: { type: 'plain_text', text: 'Show in-stock AND out-of-stock SKUs' }, value: 'with_oos' }
      ],
      initial_option: { text: { type: 'plain_text', text: 'Only show in-stock SKUs' }, value: 'in_only' }
    }
  }
]
    }
  });
});

/* =========================
   Action: when Type changes, rebuild the Car options and update the modal
========================= */
app.action('ptype_select', async ({ ack, body, client }) => {
  await ack();

  // 1) what Type did they select?
  const selectedType = body.actions?.[0]?.selected_option?.value;

  // 2) build fresh Type and Car options
  const typeOptions = optionsFromTypesWithPriority(skuIndex.types);
  const typeInitial = typeOptions.find(o => o.value === selectedType) || typeOptions[0];

  const carsSet = skuIndex.carsByType.get(selectedType) || new Set();
  const carOptions = optionsFromSet(carsSet);

  // 3) rebuild the same view with updated Car list
  const newView = {
    type: 'modal',
    callback_id: 'stock_picker_submit',
    title: { type: 'plain_text', text: 'Inventory Picker' },
    submit: { type: 'plain_text', text: 'Show Results' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: body.view.private_metadata,
    blocks: [
      // TYPE (keep selection)
      {
        type: 'input',
        block_id: 'type_block',
        label: { type: 'plain_text', text: 'Choose a Product Type' },
        element: {
          type: 'static_select',
          action_id: 'ptype_select',
          options: typeOptions,
          initial_option: typeInitial,
          placeholder: { type: 'plain_text', text: 'e.g., STEERINGWHEEL' }
        }
      },

      // CAR (now with actual options for the chosen Type)
      {
        type: 'input',
        block_id: 'car_block',
        label: { type: 'plain_text', text: 'Choose a Car' },
        element: {
          type: 'static_select',
          action_id: 'car_select',
          options: carOptions.length
            ? carOptions
            : [
                {
                  text: { type: 'plain_text', text: '— No cars for this Type —' },
                  value: '__disabled__'
                }
              ],
          initial_option: carOptions.length
            ? undefined
            : {
                text: { type: 'plain_text', text: '— No cars for this Type —' },
                value: '__disabled__'
              },
          placeholder: { type: 'plain_text', text: carOptions.length ? 'Pick a car…' : 'No cars found' }
        }
      },

      // SORT (preserve defaults)
      {
        type: 'input',
        block_id: 'sort_block',
        label: { type: 'plain_text', text: 'Display order' },
        element: {
          type: 'radio_buttons',
          action_id: 'sort_choice',
          options: [
            { text: { type: 'plain_text', text: 'Alphabetical (A→Z)' }, value: 'alpha' },
            { text: { type: 'plain_text', text: 'Quantity (High → Low)' }, value: 'qtydesc' }
          ],
          initial_option: { text: { type: 'plain_text', text: 'Quantity (High → Low)' }, value: 'qtydesc' }
        }
      },

      // Include OOS? (preserve defaults)
      {
        type: 'input',
        block_id: 'oos_block',
        label: { type: 'plain_text', text: 'Show only in-stock? Or also include out-of-stock?' },
        element: {
          type: 'radio_buttons',
          action_id: 'oos_choice',
          options: [
            { text: { type: 'plain_text', text: 'Only show in-stock SKUs' }, value: 'in_only' },
            { text: { type: 'plain_text', text: 'Show in-stock AND out-of-stock SKUs' }, value: 'with_oos' }
          ],
          initial_option: { text: { type: 'plain_text', text: 'Only show in-stock SKUs' }, value: 'in_only' }
        }
      }
    ]
  };

  // 4) push the updated view (replace the current modal)
  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,       // prevents race conditions
    view: newView
  });
});

/* =========================
   View submit: stock_picker_submit -> post results
========================= */
app.view('stock_picker_submit', async ({ ack, body, view, client }) => {
  // Validate required fields
  const errors = {};
  const type = view.state.values?.type_block?.ptype_select?.selected_option?.value;
  const car  = view.state.values?.car_block?.car_select?.selected_option?.value;
  const sortChoice =
    view.state.values?.sort_block?.sort_choice?.selected_option?.value || 'qtydesc';
  const includeOpt =
    view.state.values?.oos_block?.oos_choice?.selected_option?.value || 'in_only';

  if (!type) errors['type_block'] = 'Please choose a Product Type.';
  if (!car)  errors['car_block']  = 'Please choose a Car.';

const car  = view.state.values?.car_block?.car_select?.selected_option?.value;

// reject placeholder
if (car === '__disabled__') {
  errors['car_block'] = 'Please pick a Car.';
}

  if (Object.keys(errors).length) {
    await ack({ response_action: 'errors', errors });
    return;
  }

  await ack(); // close modal

  // Where to post
  const md = JSON.parse(view.private_metadata || '{}');
  const channel = md.channel;

  const key = `${type}::${car}`;
  const inStock = skuIndex.inStockByTypeCar.get(key) || [];
  const oosList = skuIndex.outOfStockByTypeCar.get(key) || [];

  const choice = sortChoice === 'alpha' ? 'alpha' : 'qtydesc';

  if (includeOpt === 'in_only') {
    if (!inStock.length) {
      await client.chat.postMessage({ channel, text: `No in-stock variants for *${type}* / *${car}*.` });
      return;
    }
    let variants = dedupeBySku(inStock);
    variants = choice === 'alpha' ? sortBySuffixAsc(variants) : sortByQtyDesc(variants);
    const blocks = buildBlocksOneMessage({ type, car, variants, headerLabel: 'In-Stock' });
    await client.chat.postMessage({ channel, text: `${type}/${car} in-stock SKUs`, blocks });
    return;
  }

  // with_oos
  let combined = dedupeBySku([ ...(inStock || []), ...(oosList || []) ]);
  if (!combined.length) {
    await client.chat.postMessage({ channel, text: `No variants (in-stock or out-of-stock) for *${type}* / *${car}*.` });
    return;
  }
  combined = choice === 'alpha' ? sortBySuffixAsc(combined) : sortByQtyDesc(combined);
  const blocks = buildBlocksOneMessage({ type, car, variants: combined, headerLabel: 'In-Stock + OOS' });
  await client.chat.postMessage({ channel, text: `${type}/${car} variants (in-stock + OOS)`, blocks });
});


/* =========================
   Slash: /stock-refresh (ASYNC)
========================= */
app.command('/stock-refresh', async ({ ack, body, client, logger }) => {
  // 1) immediate ACK so Slack never times out
  await ack();

  const channel = body.channel_id;
  const user = body.user_id;

  // 2) optional: tell the requester we started
  try {
    await client.chat.postEphemeral({ channel, user, text: '🔄 Refreshing inventory index…' });
  } catch (e) {
    logger?.warn?.('Could not post ephemeral pre-refresh notice', e);
  }

  // 3) run refresh in the background (no blocking)
  setTimeout(async () => {
    try {
      await refreshSkuIndex();
      await client.chat.postEphemeral({ channel, user, text: '✅ Inventory index refreshed.' });
    } catch (e) {
      logger?.error?.('refreshSkuIndex failed', e);
      await client.chat.postEphemeral({ channel, user, text: '❌ Refresh failed. Check Render logs for ❗ errors.' });
    }
  }, 0);
});

/* =========================
   Background refresher (keeps index fresh w/o heavy pings)
========================= */
function startBackgroundRefresh() {
  // Initial refresh (non-blocking after boot sanity check)
  refreshSkuIndex().catch(e => console.error('Initial refresh failed:', e?.message || e));

  const intervalMs = REFRESH_INTERVAL_MIN * 60 * 1000;
  setTimeout(() => {
    setInterval(() => {
      refreshSkuIndex().catch(e => console.error('Scheduled refresh failed:', e?.message || e));
    }, intervalMs);
  }, JITTER_SEC * 1000);

  console.log(`🕒 Background refresh every ${REFRESH_INTERVAL_MIN} min (jitter ${JITTER_SEC}s).`);
}

/* =========================
   Start
========================= */
(async () => {
  const port = process.env.PORT || 3000;
  await app.start();
  console.log(`✅ inventory-picker running on port ${port}`);

  await sanityCheckShopify();

  // Kick off periodic refreshes (use /stock-refresh for manual).
  startBackgroundRefresh();
})();