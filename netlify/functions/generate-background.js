// netlify/functions/generate-background.js  (PAID app)
// Pipeline: check access token + usage cap -> Haiku writes the Greenprint ->
// structure checks (Sonnet full rewrite only if broken) -> free code fixes ->
// Sonnet reviewer returns replacement entries ONLY for flagged plants, swapped in by code.
// Reviewer problems are retried quietly; at worst the Greenprint is delivered with the code fixes only.

const { connectLambda, getStore } = require('@netlify/blobs');
const { readToken } = require('./lib/auth');

const SITE_ID = '58059f0f-bc4f-4cec-8963-b609550a12e6';
// ============ MODEL SETTINGS — the one place to change models ============
// Rule: use the lowest-cost model that works for each job. Each list is tried in order; if Anthropic rejects
// a model ID (retired / unknown), the next one is used automatically. Cheapest first.
// Prices ($ per million tokens: input, output) last checked 2026-10-18. Haiku 5.5: VentureBeat + eesel (prompts under 100k tokens).
// Sonnet 5.5: third-party listing only (not yet confirmed on Anthropic's pricing page). Unknown models are costed at the highest price below.
const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-haiku-4-5-20251001': [1, 5],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-4-6': [3, 15]
};
const CHEAP = ['claude-haiku-5-5', 'claude-haiku-4-5-20251001'];
const STRONGER = ['claude-sonnet-5-5', 'claude-sonnet-4-6'];
// Request options per model (checked against Anthropic's effort docs 2026-10-18): the 5.5 models think by default and bill thinking as output,
// so thinking is switched off (Haiku 5.5) or set to its lowest setting (Sonnet 5.5). If the API rejects these options the call is retried without them.
const MODEL_OPTS = {
  'claude-haiku-5-5': { thinking: { type: 'disabled' }, output_config: { effort: 'medium' } },
  'claude-sonnet-5-5': { thinking: { type: 'between_tools' }, output_config: { effort: 'medium' } }
};
const OPTS_REJECTED = {};
const TASK_MODELS = {
  write: CHEAP,        // writes the Greenprint
  judge: STRONGER,     // checks plants and timeline for definite errors. Tested 2026-10-19: Haiku 5.5 as judge gave contradictory flags and could not check county facts, so this job uses Sonnet 5.5 (~1¢)
  rewrite: CHEAP,      // rewrites flagged plant entries and the timeline
  escalate: STRONGER,  // only for entries the cheap model could not fix
  fullRewrite: STRONGER // only when the writer's output fails the structure check
};
// ========================================================================
const RUN_CAP = 10;       // Greenprints per month per license / lifetime per promo redemption
const WARN_AT = 8;        // show a heads-up once this many are used
const BUY_LINK = 'https://smartscape.gumroad.com/l/greenprint';
const PROMPT_SENTINEL = 'You are SmartScape, an expert in native plants and climate-resilient landscaping';

// Free fixes: known, mechanical mistakes corrected without spending any tokens.
// Add a line here whenever you spot a repeat error.
const CODE_FIXES = [
  [/Scrub Live Oak(\s*\(Quercus geminata\))/gi, 'Sand Live Oak$1'],
  [/(Coastalplain Honeycombhead\s*\()Balduina uniflora(\))/gi, '$1Balduina angustifolia$2'],
  [/\bCoas[a-z]{0,3}plain Honeycombhead/gi, 'Coastalplain Honeycombhead'],
  [/\b(?:the\s+)?(?:official\s+)?state wildflower\b/gi, 'a native wildflower']
];

// Rules the reviewer checks. Add new known mistakes to KNOWN_MISTAKES.
const KNOWN_MISTAKES = [
  'Quercus geminata is Sand Live Oak (not "Scrub Live Oak"); Quercus inopina is Scrub Oak.',
  'Coastalplain Honeycombhead is Balduina angustifolia. Balduina uniflora is Oneflower Honeycombhead (flatwoods/bog plant of the panhandle and NE Florida).',
  'Balduina angustifolia (Coastalplain Honeycombhead) is an annual (occasionally biennial), not a perennial.',
  'Wetland / wet-site plants (for example Scarlet Rosemallow Hibiscus coccineus, Pond Apple, Coreopsis floridana, swamp and marsh species) do not fit when Water savings is a goal or the site is dry/sandy.',
  'Milkweed must be a species native to the zip code\'s ecoregion (never tropical milkweed, Asclepias curassavica).',
  'State-listed endangered or threatened plants (for example Curtiss\' Milkweed, Asclepias curtissii, in Florida) need a short note that they are state-listed and should only be bought as nursery-propagated stock.',
  'Never call any plant "the state wildflower".'
];

function monthKeyPT(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(d || new Date());
  const y = parts.find(function (p) { return p.type === 'year'; }).value;
  const m = parts.find(function (p) { return p.type === 'month'; }).value;
  return { key: y + '-' + m, year: +y, month: +m };
}
function nextResetLabel() {
  const mk = monthKeyPT();
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return names[mk.month % 12] + ' 1';
}

function validateRequest(incoming) {
  if (!incoming || typeof incoming.jobId !== 'string' || !/^job_[0-9]+_[a-z0-9]{3,30}$/.test(incoming.jobId)) return 'Bad job id';
  const m = incoming.messages;
  if (!Array.isArray(m) || m.length !== 1 || !m[0] || m[0].role !== 'user') return 'Bad request';
  const c = m[0].content;
  let textLen = 0, promptText = '', images = 0, imgLen = 0;
  if (typeof c === 'string') { promptText = c; }
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'text' && typeof b.text === 'string') promptText += b.text;
      else if (b && b.type === 'image' && b.source && b.source.type === 'base64' && typeof b.source.data === 'string') {
        images++; imgLen += b.source.data.length;
        if (!/^image\/(jpeg|png|webp|gif)$/.test(b.source.media_type || '')) return 'Bad image';
      } else return 'Bad request';
    }
  } else return 'Bad request';
  textLen = promptText.length;
  if (images > 1 || imgLen > 7000000) return 'Image too large';
  if (textLen < 500 || textLen > 60000) return 'Bad request';
  if (promptText.indexOf(PROMPT_SENTINEL) === -1) return 'Bad request';
  return null;
}

function usagePlus(acc, model, u) {
  if (!u) return;
  const a = acc[model] || (acc[model] = { in: 0, out: 0, calls: 0 });
  a.in += u.input_tokens || 0; a.out += u.output_tokens || 0; a.calls++;
}
function costOf(acc) {
  let total = 0;
  for (const m in acc) { const p = PRICES[m] || [3, 15]; total += acc[m].in * p[0] / 1e6 + acc[m].out * p[1] / 1e6; }
  return Math.round(total * 10000) / 10000;
}

// ---------- structure checks (unchanged behavior) ----------
function missingSeasons(t) {
  const tIdx = t.indexOf('PLANTING TIMELINE');
  if (tIdx === -1) return ['Fall', 'Winter', 'Spring', 'Summer'];
  const sIdx = t.indexOf('SPECIES COUNT', tIdx);
  const sec = sIdx === -1 ? t.slice(tIdx) : t.slice(tIdx, sIdx);
  return ['Fall', 'Winter', 'Spring', 'Summer'].filter(function (s) { return sec.indexOf(s) === -1; });
}
function plantSection(t) {
  const rIdx = t.indexOf('RECOMMENDED NATIVE PLANTS');
  if (rIdx === -1) return null;
  const tIdx = t.indexOf('PLANTING TIMELINE', rIdx);
  return { start: rIdx, end: tIdx === -1 ? t.length : tIdx };
}
function plantLinesMissingTags(t) {
  const s = plantSection(t);
  if (!s) return 0;
  return t.slice(s.start, s.end).split('\n').filter(function (l) { return l.trim().startsWith('-'); })
    .filter(function (l) { return l.indexOf('Attracts:') === -1 || !/Lifecycle:\s*(Perennial|Annual|Biennial)/i.test(l); }).length;
}
function structureProblem(t, truncated) {
  if (truncated) return 'Your previous response above was cut off before it finished (it ran out of space partway through, most likely during the PLANTING TIMELINE section).';
  const miss = missingSeasons(t);
  if (miss.length) return 'Your PLANTING TIMELINE above is missing the following required season(s): ' + miss.join(', ') + '.';
  const tags = plantLinesMissingTags(t);
  if (tags) return tags + ' plant line(s) above are missing the required trailing "Attracts: [...]" tag and/or the final "Lifecycle: [Perennial/Annual/Biennial]." tag.';
  if (!/^\s*-\s+.+\(.+\)/m.test(t)) return 'Your RECOMMENDED NATIVE PLANTS section above did not include any actual plant lines.';
  return null;
}

// ---------- Anthropic calls (quiet retries) ----------
const DEAD_MODELS = {}; // model IDs Anthropic rejected during this function's lifetime
async function callClaude(apiKey, modelOrList, maxTokens, messages, usageAcc, system) {
  let models = Array.isArray(modelOrList) ? modelOrList : [modelOrList];
  const alive = models.filter(function (m) { return !DEAD_MODELS[m]; });
  if (alive.length) models = alive;
  let lastErr;
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    let modelRejected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = { model: model, max_tokens: maxTokens, messages: messages };
        if (system) body.system = system;
        if (MODEL_OPTS[model] && !OPTS_REJECTED[model]) Object.assign(body, MODEL_OPTS[model]);
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body)
        });
        const raw = await resp.text();
        if (resp.status === 200) {
          const parsed = JSON.parse(raw);
          usagePlus(usageAcc, model, parsed.usage);
          // answer = the text blocks only (newer models may put a thinking block first)
          const blocks = Array.isArray(parsed.content) ? parsed.content : [];
          const text = blocks.filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text || ''; }).join('');
          if (!text.trim()) {
            lastErr = new Error('Empty reply from ' + model + ' (stop: ' + parsed.stop_reason + ', blocks: ' + blocks.map(function (b) { return b && b.type; }).join(',') + ')');
            break; // try the next model in the list
          }
          return { text: text, truncated: parsed.stop_reason === 'max_tokens', model: model };
        }
        // option fields rejected -> retry this model without them
        if (resp.status === 400 && /thinking|effort|output_config/i.test(raw) && MODEL_OPTS[model] && !OPTS_REJECTED[model]) { OPTS_REJECTED[model] = true; lastErr = new Error('Anthropic 400 (' + model + ') options: ' + raw.slice(0, 200)); attempt--; continue; }
        lastErr = new Error('Anthropic ' + resp.status + ' (' + model + '): ' + raw.slice(0, 200));
        // unknown / retired / unavailable model -> try the next model in the list
        if (resp.status === 404 || (resp.status === 400 && /model/i.test(raw))) { modelRejected = true; DEAD_MODELS[model] = true; break; }
        if (resp.status < 500 && resp.status !== 429) break;
      } catch (e) { lastErr = e; }
      await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
    }
    if (!modelRejected && mi < models.length - 1 && lastErr && /Anthropic (5|429)|Empty reply/.test(String(lastErr.message))) continue; // overloaded or empty: try next model too
    if (!modelRejected) break;
  }
  throw lastErr || new Error('Anthropic call failed');
}

// ---------- free code fixes ----------
function applyCodeFixes(t) {
  let out = t;
  for (const f of CODE_FIXES) out = out.replace(f[0], f[1]);
  // Quercus geminata is Sand Live Oak everywhere it is mentioned (plant line and timeline)
  if (/Quercus geminata/.test(out)) out = out.replace(/Scrub Live Oak/g, 'Sand Live Oak');
  return out;
}

// ---------- reviewer: Sonnet judges (short reply), Haiku rewrites flagged entries ----------
function sciName(line) {
  const m = line.match(/\(([A-Z][a-z]+(?:\s+[a-z×.-]+){0,3}[^)]*)\)/);
  return m ? m[1].toLowerCase().replace(/[^a-z ]/g, '').trim() : '';
}
function splitSections(t) {
  const ps = plantSection(t);
  if (!ps) return null;
  const tIdx = t.indexOf('PLANTING TIMELINE', ps.start);
  if (tIdx === -1) return null;
  const sIdx = t.indexOf('SPECIES COUNT', tIdx);
  return { ps: ps, tStart: tIdx, tEnd: sIdx === -1 ? t.length : sIdx };
}
function getPlantLines(t) {
  const sec = splitSections(t);
  if (!sec) return [];
  return t.slice(sec.ps.start, sec.ps.end).split('\n').filter(function (l) { return l.trim().startsWith('-'); }).map(function (l) { return l.trim(); });
}
function getTimeline(t) {
  const sec = splitSections(t);
  if (!sec) return '';
  return t.slice(sec.tStart, sec.tEnd).replace(/^PLANTING TIMELINE:?\s*/, '').trim();
}
function plantLineProblem(nl) {
  if (typeof nl !== 'string' || !nl) return 'no entry returned';
  if (nl.indexOf('\n') !== -1) return 'more than one line';
  if (nl.length < 80) return 'too short (' + nl.length + ')';
  if (nl.length > 1800) return 'too long (' + nl.length + ')';
  if (!nl.startsWith('- ')) return 'does not start with "- "';
  if (!/\([^)]+\)/.test(nl)) return 'no (Scientific name)';
  if (nl.indexOf('Attracts:') === -1) return 'missing "Attracts:"';
  if (!/Lifecycle:\s*(Perennial|Annual|Biennial)/i.test(nl)) return 'missing "Lifecycle: Perennial/Annual/Biennial"';
  return '';
}
// ---------- yard-size check (free, in code) ----------
// Maximum mature height (ft) a plant may have for the yard size; null = no limit.
function yardClass(siteDetails) {
  const m = String(siteDetails || '').match(/Yard size:\s*([^\n]+)/i);
  const s = m ? m[1] : '';
  if (/under\s*500/i.test(s)) return 'tiny';
  if (/^\s*500/.test(s)) return 'small';
  if (/1,500\s*[–-]\s*5,000/.test(s)) return 'medium';
  if (/5,000\s*\+/.test(s)) return 'large';
  return '';
}
function heightLimit(siteDetails) {
  const c = yardClass(siteDetails);
  return c === 'tiny' ? 30 : c === 'small' ? 35 : c === 'medium' ? 60 : null;
}
// First height-like number (upper end of a range) in the "Mature size:" part of an entry; null if none found.
function plantMaxHeight(line) {
  const m = String(line || '').match(/Mature size:\s*([^]*?)(?:Attracts:|$)/i);
  if (!m) return null;
  const h = m[1].match(/(\d+(?:\.\d+)?)\s*(?:[–-]\s*(\d+(?:\.\d+)?))?\s*(?:\+\s*)?(?:ft|feet|foot)\b/i);
  if (!h) return null;
  return parseFloat(h[2] || h[1]);
}
function tooTall(line, limit) {
  if (!limit) return 0;
  const h = plantMaxHeight(line);
  return h !== null && h > limit ? h : 0;
}
function validPlantLine(nl) { return !plantLineProblem(nl); }
// Swap the n-th plant line (1-based) for a new one; returns new text or null.
function setPlantLine(t, n, nl) {
  const sec = splitSections(t);
  if (!sec) return null;
  const block = t.slice(sec.ps.start, sec.ps.end);
  const lines = block.split('\n');
  const idxs = [];
  lines.forEach(function (l, i) { if (l.trim().startsWith('-')) idxs.push(i); });
  if (!(n >= 1 && n <= idxs.length)) return null;
  const others = idxs.filter(function (_, k) { return k !== n - 1; }).map(function (i) { return sciName(lines[i]); });
  const name = sciName(nl);
  if (name && others.indexOf(name) !== -1) return null;
  const li = idxs[n - 1];
  lines[li] = lines[li].match(/^\s*/)[0] + nl;
  return t.slice(0, sec.ps.start) + lines.join('\n') + t.slice(sec.ps.end);
}
function setTimeline(t, newTimeline) {
  const sec = splitSections(t);
  if (!sec) return null;
  return t.slice(0, sec.tStart) + 'PLANTING TIMELINE:\n' + newTimeline.trim() + '\n\n' + t.slice(sec.tEnd);
}
function parseJson(s) {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

const FORMAT_RULES = 'FORMAT FOR EVERY PLANT LINE (exactly): "- Common Name (Scientific name) — one sentence on why it fits this site, sun exposure and goals. Mature size: <plain-language size>. <One brief factual sentence on a well-documented Indigenous use of the plant, as plain text with no label, using the word "Indigenous"; leave it out entirely if not well documented and never mention that it is left out.> Attracts: <plain list of every group the plant is well documented to support — insects, birds and mammals, not only the pollinators the goal asks for — most specific first, any parenthetical at most six words>. Lifecycle: <Perennial, Annual or Biennial>." Write in plain everyday language, do not name specific pollinators, birds or animals in the description sentence (a general phrase like "supports pollinators" is fine; name them only in the Attracts tag so nothing is said twice), give one common name only (no slashes), never state a berry or fruit colour, make no insect or wildlife claim that is not well documented, and for a state-listed endangered or threatened plant say so briefly and say to buy only nursery-propagated stock. The entry must be a single line.';

function judgePrompt(siteDetails, plants, timeline, shortMode) {
  return 'You are a strict native-plant fact checker for a landscaping app. Check the items below against the site details. List only items you are SURE are wrong. If an item is merely doubtful or you cannot be certain, either leave it out or mark it sure=false. DO NOT write replacement text. Reply briefly.\n\n' +
    'SITE DETAILS:\n' + siteDetails + '\n\n' +
    'CHECK EVERY PLANT FOR: (1) NAME: the scientific name belongs to the common name given, and the common name is the standard one. (2) NATIVE RANGE: native to the specific county/ecoregion of this zip code, not merely somewhere in the state. (3) HABITAT: light, soil, drainage and moisture needs fit the site and sun; moisture-loving, shade-loving or wetland plants do not fit a dry sunny sandy site or a Water savings goal; "drought-tolerant" must be true for that species. (4) LIFECYCLE tag is correct. (5) LAYER: right layer for real height and form (Groundcover only under about 1 foot; herbaceous wildflowers are not Shrubs). (6) CLAIMS: size, wildlife and insect statements are well documented; milkweed is locally native. (7) State-listed endangered/threatened plants carry a sourcing note. (8) Tree size fits the yard size.\n' +
    'KNOWN MISTAKES:\n- ' + KNOWN_MISTAKES.join('\n- ') + '\n\n' +
    'PLANTS (numbered):\n' + plants.map(function (p) { return p.n + '. ' + p.line; }).join('\n') + '\n\n' +
    (timeline ? 'PLANTING TIMELINE:\n' + timeline + '\n\nCHECK THE TIMELINE: the planting seasons match what this specific county\'s cooperative extension service, state native plant society or other expert regional sources recommend (do not assume any default season; fall is not best everywhere); it agrees with itself (for example no "save seed for next summer" in one entry and "sow in spring" in another); it names only plants in the list.\n\n' : '') +
    'Reply with ONLY this JSON, nothing else: {"plants":[{"n":<number>,"sure":<true only if you are certain it is an error, else false>,"problem":"<reason, at most ' + (shortMode ? '10' : '20') + ' words>"}],"timeline":[' + (timeline ? '"<problem, at most 25 words>"' : '') + '],"notes":"<one short sentence>"}. Use empty lists when nothing is wrong.';
}

async function judge(apiKey, siteDetails, plants, timeline, usage) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await callClaude(apiKey, TASK_MODELS.judge, 1500, [{ role: 'user', content: judgePrompt(siteDetails, plants, timeline, attempt > 0) }], usage);
      const j = parseJson(r.text);
      if (j && !r.truncated) {
        const valid = {};
        plants.forEach(function (p) { valid[p.n] = true; });
        const flagged = (Array.isArray(j.plants) ? j.plants : []).map(function (x) { return { n: parseInt(x && x.n, 10), sure: !!(x && x.sure === true), problem: String((x && x.problem) || '').slice(0, 200) }; }).filter(function (x) { return valid[x.n]; });
        return { ok: true, raw: r.text.slice(0, 4000), plants: flagged, timeline: (Array.isArray(j.timeline) ? j.timeline : []).map(function (x) { return String(x).slice(0, 300); }).filter(Boolean), notes: String(j.notes || '').slice(0, 400) };
      }
      console.log('Judge reply unusable (attempt ' + (attempt + 1) + '): ' + (r.truncated ? 'truncated' : 'unparseable'));
    } catch (e) { console.log('Judge attempt ' + (attempt + 1) + ' failed: ' + e.message); }
  }
  return { ok: false, plants: [], timeline: [], notes: 'judge failed' };
}

function rewritePlantsPrompt(siteDetails, flagged, usedNames) {
  return 'You are rewriting flagged entries of a native plant list for a landscaping app.\n\nSITE DETAILS:\n' + siteDetails + '\n\n' +
    'For each flagged plant below write ONE replacement entry. If the problem is only a wrong name, label, size, lifecycle or unsupported claim, correct that entry and keep the same plant. If the plant does not fit the site or is not native to this specific area, choose a DIFFERENT plant that is native to this specific county/ecoregion, fits the sun, soil, yard size and goals, belongs in the same layer, and is not in this list of plants already used: ' + usedNames.join('; ') + '. Choose only plants you are certain are native to this area.\n\n' +
    FORMAT_RULES + '\n\nFLAGGED ENTRIES:\n' + flagged.map(function (f) { return 'n=' + f.n + ' | problem: ' + f.problem + ' | original: ' + f.line; }).join('\n') + '\n\n' +
    'Output ONLY blocks in this exact form, nothing else: no thinking aloud, no notes, no repeated blocks, exactly one block per flagged entry.\n### <n>\n<the single-line entry>\n';
}
function parseBlocks(s) {
  const out = {};
  const lines = String(s || '').split('\n');
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^\s*#{1,4}\s*(?:n\s*=\s*)?(\d+)\s*:?\s*$/i);
    if (h) { cur = parseInt(h[1], 10); continue; }
    if (cur !== null && lines[i].trim()) {
      let l = lines[i].trim().replace(/^[-*•]\s*/, '');
      (out[cur] = out[cur] || []).push('- ' + l);
      cur = null;
    }
  }
  return out;
}
async function rewritePlants(apiKey, model, siteDetails, flagged, usedNames, usage) {
  try {
    const r = await callClaude(apiKey, model, Math.min(5000, 400 + flagged.length * 450), [{ role: 'user', content: rewritePlantsPrompt(siteDetails, flagged, usedNames) }], usage);
    return { blocks: parseBlocks(r.text), raw: String(r.text || '').slice(0, 6000), truncated: !!r.truncated };
  } catch (e) { console.log('Plant rewrite (' + model + ') failed: ' + e.message); return { blocks: {}, raw: 'ERROR: ' + e.message, truncated: false }; }
}

function rewriteTimelinePrompt(siteDetails, timeline, problems, plantNames) {
  return 'You are correcting the PLANTING TIMELINE of a native plant Greenprint.\n\nSITE DETAILS:\n' + siteDetails + '\n\nPLANTS IN THE LIST (use only these): ' + plantNames.join('; ') + '\n\nPROBLEMS TO FIX:\n- ' + problems.join('\n- ') + '\n\nCURRENT TIMELINE:\n' + timeline + '\n\n' +
    'Rewrite the timeline so every problem is fixed. Keep every bullet that is already correct exactly as written and change only what is needed. Rules: exactly four entries in this order: Fall, Winter, Spring, Summer; each header is plain text alone on its line, such as "Fall (September–November):"; under each header one or more action bullets, each on its own line starting with "- ", each naming specific plants from the list and the exact action. Use the planting seasons that this specific county\'s cooperative extension service, state native plant society or other expert regional sources recommend; do not assume any default season. Keep the Summer bullet saying that once established (typically after the first one to two years) these native plants generally need no supplemental watering under normal regional rainfall, though occasional deep watering can help in severe heat waves or drought. If seed is scattered, always say to cover or press it into the soil. NEW PLANTING: this is a brand-new planting for a yard where nothing is planted yet, so every action must be a first-time action (planting, sowing or preparing the site); do not include maintenance of established plants (dividing, pruning, deadheading, cleaning up, collecting seed), and every listed plant must be planted or sown in one of the bullets. STRICT STRUCTURE: every plant in the list is named in one bullet under the season that suits it best for this location, and in no more than TWO bullets in total; do not write backup or alternate actions such as "if not planted in fall", "if you miss the window" or "otherwise"; group plants that share the same action and season into one bullet; do not mention any plant that is not in the list. Output ONLY the four entries, with no title and no other text.';
}
// Free code check of a rewritten timeline: every listed plant in one or two bullets (never missing, never three or more), no backup/alternate actions.
function timelineProblem(t, plantNames) {
  const bullets = t.split('\n').filter(function (l) { return /^-\s/.test(l.trim()); });
  const issues = [];
  plantNames.forEach(function (nm) {
    const key = nm.toLowerCase();
    const n = bullets.filter(function (b) { return b.toLowerCase().indexOf(key) !== -1; }).length;
    if (n === 0) issues.push(nm + ' is missing');
    else if (n > 2) issues.push(nm + ' appears in ' + n + ' bullets');
  });
  if (/\b(if (?:you )?(?:did not|didn't|have not|haven't|not|missed|miss)\b|otherwise\b|alternatively\b|as a backup\b)/i.test(bullets.join('\n'))) issues.push('contains a backup/alternate action');
  return issues.length ? issues.join('; ') : '';
}
async function rewriteTimeline(apiKey, model, siteDetails, timeline, problems, plantNames, usage) {
  try {
    const r = await callClaude(apiKey, model, 2500, [{ role: 'user', content: rewriteTimelinePrompt(siteDetails, timeline, problems, plantNames) }], usage);
    const t = r.text.trim();
    const raw = t.slice(0, 6000);
    if (r.truncated) return { text: null, raw: raw, reason: 'reply truncated' };
    if (t.length < 300) return { text: null, raw: raw, reason: 'too short (' + t.length + ')' };
    const miss = missingSeasons('PLANTING TIMELINE\n' + t);
    if (miss.length) return { text: null, raw: raw, reason: 'missing seasons: ' + miss.join(',') };
    if (!/^-\s/m.test(t)) return { text: null, raw: raw, reason: 'no "- " bullets' };
    const tp = timelineProblem(t, plantNames);
    if (tp) return { text: null, raw: raw, reason: 'structure rule: ' + tp, issues: tp };
    return { text: t, raw: raw, reason: '' };
  } catch (e) { console.log('Timeline rewrite (' + model + ') failed: ' + e.message); return { text: null, raw: 'ERROR: ' + e.message, reason: 'error: ' + e.message }; }
}

// Sonnet judges (sure errors only); Haiku rewrites sure-flagged plants; Sonnet re-checks those rewrites and writes only what is still wrong;
// the timeline is corrected LAST, once, against the final plant list. Every model reply and every accept/reject decision is saved in detail.
async function reviewGreenprint(apiKey, t, siteDetails, usage) {
  const detail = { sizeFlags: [], original: t, judgeRaw: '', recheckRaw: '', retryRaw: '', plantRewriteRaw: '', escalationRaw: '', timelineRaw: '', decisions: [], flaggedSure: [], flaggedUnsure: [], timelineProblems: 0, rewritten: 0, replacedPlants: 0, timelineRewritten: false, timelineDecision: '', recheckFlagged: 0, escalated: 0, judgeNotes: '', recheckNotes: '' };
  const sec = splitSections(t);
  if (!sec) return { text: t, changed: 0, ok: false, notes: 'no sections', proposed: 0, detail: detail };
  const plants = getPlantLines(t).map(function (line, i) { return { n: i + 1, line: line }; });
  const timeline = getTimeline(t);

  let j1 = await judge(apiKey, siteDetails, plants, timeline, usage);
  detail.judgeRaw = j1.raw || '';
  if (!j1.ok) {
    // the judge is unusable, but the free size check can still act
    const lim0 = heightLimit(siteDetails);
    if (!plants.some(function (p) { return tooTall(p.line, lim0); })) return { text: t, changed: 0, ok: false, notes: j1.notes, proposed: 0, detail: detail };
    j1 = { ok: false, plants: [], timeline: [], notes: j1.notes };
  }
  const sureMap = {};
  j1.plants.forEach(function (x) { if (!x.sure) return; if (sureMap[x.n]) sureMap[x.n].problem += ' ; ' + x.problem; else sureMap[x.n] = { n: x.n, sure: true, problem: x.problem }; });
  // free code check: plants too tall for the yard
  const limit = heightLimit(siteDetails);
  const sizeFlags = [];
  plants.forEach(function (p) {
    const h = tooTall(p.line, limit);
    if (!h) return;
    sizeFlags.push(p.n);
    const msg = 'Mature height up to ' + h + ' ft is too tall for this yard (limit ' + limit + ' ft); choose a plant that stays under ' + (limit - 10) + ' ft.';
    if (sureMap[p.n]) sureMap[p.n].problem += ' ; ' + msg; else sureMap[p.n] = { n: p.n, sure: true, problem: msg };
  });
  detail.sizeFlags = sizeFlags;
  const sure = Object.keys(sureMap).map(function (k) { return sureMap[k]; }).sort(function (a, b) { return a.n - b.n; });
  detail.flaggedSure = sure.map(function (x) { return x.n; });
  detail.flaggedUnsure = j1.plants.filter(function (x) { return !x.sure; }).map(function (x) { return x.n; });
  detail.timelineProblems = j1.timeline.length;
  detail.judgeNotes = j1.notes + ' | ' + j1.plants.map(function (x) { return x.n + (x.sure ? '(sure)' : '(unsure)') + ': ' + x.problem; }).join(' ; ') + (j1.timeline.length ? ' | TIMELINE: ' + j1.timeline.join(' ; ') : '');
  if (!sure.length && !j1.timeline.length) return { text: t, changed: 0, ok: true, notes: 'none', proposed: 0, detail: detail };

  let text = t, changed = 0, plantNamesChanged = false;
  const timelineProblems = j1.timeline.slice();
  const lineOf = {};
  plants.forEach(function (p) { lineOf[p.n] = p.line; });

  // Apply one set of replacement entries, recording accept/reject + reason for each
  function applyBlocks(round, flagged, blocks) {
    let applied = 0;
    flagged.forEach(function (f) {
      const cands = blocks[f.n] || [];
      let nl = cands.filter(function (c) { return !plantLineProblem(c); })[0] || cands[0];
      let why = plantLineProblem(nl);
      if (!why && limit && tooTall(nl, limit)) why = 'too tall for this yard: ' + tooTall(nl, limit) + ' ft (limit ' + limit + ' ft)';
      if (!why && sciName(nl) && getPlantLines(text).some(function (l, k) { return k !== f.n - 1 && sciName(l) === sciName(nl); })) why = 'duplicate: that plant is already in the list';
      const dec = { round: round, n: f.n, problem: f.problem, before: f.line, after: nl || '', accepted: false, reason: why };
      if (!why) {
        const next = setPlantLine(text, f.n, nl);
        if (!next) dec.reason = 'could not place the entry in the list';
        else {
          if (sciName(nl) !== sciName(f.line)) { detail.replacedPlants++; plantNamesChanged = true; }
          text = next; changed++; applied++; dec.accepted = true; dec.reason = 'accepted';
        }
      }
      detail.decisions.push(dec);
    });
    return applied;
  }

  const rewrittenNs = [], rejectedNs = [];
  if (sure.length) {
    const flagged = sure.map(function (x) { return { n: x.n, problem: x.problem, line: lineOf[x.n] }; });
    const used = plants.map(function (p) { return sciName(p.line); }).filter(Boolean);
    const rw = await rewritePlants(apiKey, TASK_MODELS.rewrite, siteDetails, flagged, used, usage);
    detail.plantRewriteRaw = rw.raw;
    applyBlocks('haiku', flagged, rw.blocks);
    detail.decisions.forEach(function (d) { if (d.round === 'haiku' && d.accepted) rewrittenNs.push(d.n); });
    detail.rewritten = rewrittenNs.length;
    detail.decisions.forEach(function (d) { if (d.round === 'haiku' && !d.accepted) rejectedNs.push(d.n); });
  }

  // Sonnet re-checks the accepted rewrites, and writes the entries that are still wrong or whose Haiku rewrite was rejected
  if (rewrittenNs.length || rejectedNs.length) {
    const nowPlants = getPlantLines(text).map(function (line, i) { return { n: i + 1, line: line }; });
    const todo = {};
    rejectedNs.forEach(function (n) { todo[n] = { n: n, problem: (sure.filter(function (x) { return x.n === n; })[0] || {}).problem || 'wrong plant for this site', line: nowPlants[n - 1].line }; });
    if (rewrittenNs.length) {
      const toCheck = nowPlants.filter(function (p) { return rewrittenNs.indexOf(p.n) !== -1; });
      const j2 = await judge(apiKey, siteDetails, toCheck, '', usage);
      detail.recheckRaw = j2.raw || '';
      if (j2.ok) {
        const still = j2.plants.filter(function (x) { return x.sure && x.n > 0 && x.n <= nowPlants.length; });
        detail.recheckNotes = j2.notes + ' | ' + j2.plants.map(function (x) { return x.n + (x.sure ? '(sure)' : '(unsure)') + ': ' + x.problem; }).join(' ; ');
        still.forEach(function (x) {
          if (todo[x.n]) todo[x.n].problem += ' ; ' + x.problem;
          else todo[x.n] = { n: x.n, problem: x.problem, line: nowPlants[x.n - 1].line };
        });
      }
    }
    const flagged2 = Object.keys(todo).map(function (k) { return todo[k]; });
    detail.recheckFlagged = flagged2.length;
    if (flagged2.length) {
      const used2 = nowPlants.map(function (p) { return sciName(p.line); }).filter(Boolean);
      const rw2 = await rewritePlants(apiKey, TASK_MODELS.escalate, siteDetails, flagged2, used2, usage);
      detail.escalationRaw = rw2.raw;
      detail.escalated = applyBlocks('sonnet', flagged2, rw2.blocks);
      // one more try, with the rejection reason spelled out, for entries still not replaced
      const failed = flagged2.filter(function (f) { return !detail.decisions.some(function (d) { return d.round === 'sonnet' && d.n === f.n && d.accepted; }); });
      if (failed.length) {
        const retry = failed.map(function (f) {
          const last = detail.decisions.filter(function (d) { return d.round === 'sonnet' && d.n === f.n; }).pop();
          return { n: f.n, problem: f.problem + ' ; YOUR PREVIOUS ANSWER WAS REJECTED: ' + (last ? last.reason : 'no valid entry') + '. Choose a different plant that avoids this.', line: f.line };
        });
        const used3 = getPlantLines(text).map(function (l) { return sciName(l); }).filter(Boolean);
        const rw3 = await rewritePlants(apiKey, TASK_MODELS.escalate, siteDetails, retry, used3, usage);
        detail.retryRaw = rw3.raw;
        detail.escalated += applyBlocks('sonnet-retry', retry, rw3.blocks);
      }
    }
  }

  // Timeline LAST: one Haiku pass against the final plant list
  if (timelineProblems.length || plantNamesChanged) {
    const problems = timelineProblems.slice();
    if (plantNamesChanged) problems.push('Some plants in the list were replaced. Make every timeline bullet refer only to plants in the final list (use their common names exactly as listed) and remove any plant that is no longer listed.');
    const names = getPlantLines(text).map(function (l) { return (l.match(/^-\s*(.+?)\s*\(/) || [, l])[1]; });
    let tr = await rewriteTimeline(apiKey, TASK_MODELS.rewrite, siteDetails, getTimeline(text), problems, names, usage);
    detail.timelineRaw = tr.raw;
    if (!tr.text && tr.issues) {
      // cheap model broke the structure rules: one retry by the stronger model, told exactly what was wrong
      detail.timelineDecision = 'cheap model rejected: ' + tr.reason;
      const p2 = problems.concat(['A previous rewrite was rejected because: ' + tr.issues + '. Fix this.']);
      const tr2 = await rewriteTimeline(apiKey, TASK_MODELS.escalate, siteDetails, getTimeline(text), p2, names, usage);
      detail.timelineRaw2 = tr2.raw;
      tr = tr2;
    }
    if (!tr.text) detail.timelineDecision += ' | rejected: ' + tr.reason;
    else {
      const next = setTimeline(text, tr.text);
      if (!next) detail.timelineDecision = 'rejected: could not place timeline';
      else if (structureProblem(next, false)) detail.timelineDecision = 'rejected: structure check: ' + structureProblem(next, false);
      else { text = next; detail.timelineRewritten = true; changed++; detail.timelineDecision = (detail.timelineDecision ? detail.timelineDecision + ' | ' : '') + 'accepted'; }
    }
  }

  if (changed && structureProblem(text, false)) return { text: t, changed: 0, ok: true, notes: 'edits discarded: structure check failed', proposed: sure.length, detail: detail };
  return { text: text, changed: changed, ok: true, notes: detail.judgeNotes, proposed: sure.length + j1.timeline.length, detail: detail };
}

// ---------- usage meter ----------
function meterKey(auth) {
  if (auth.k === 'promo') return 'promo:' + auth.id;
  return 'lic:' + auth.id + ':' + monthKeyPT().key;
}

exports.handler = async function (event) {
  connectLambda(event);
  let jobId;
  const usage = {};
  try {
    const incoming = JSON.parse(event.body);
    const bad = validateRequest(incoming);
    jobId = incoming && typeof incoming.jobId === 'string' && /^job_[0-9]+_[a-z0-9]{3,30}$/.test(incoming.jobId) ? incoming.jobId : null;
    if (bad || !jobId) { console.log('Rejected request: ' + bad); return { statusCode: 202, body: '' }; }

    const store = getStore({ name: 'greenprint-jobs' });
    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) { await store.setJSON(jobId, { status: 'error', message: 'API key not configured' }); return { statusCode: 202, body: '' }; }

    // ----- access + cap -----
    const auth = readToken(incoming.token);
    if (!auth || (auth.k !== 'promo' && auth.k !== 'lic' && auth.k !== 'admin') || !auth.id) {
      await store.setJSON(jobId, { status: 'auth', message: 'Please enter your license key to continue.' });
      return { statusCode: 202, body: '' };
    }
    const meter = getStore({ name: 'usage-meter', siteID: SITE_ID, token: process.env.BLOBS_TOKEN });
    const mKey = meterKey(auth);
    const rec = await meter.get(mKey, { type: 'json' });
    const used = (rec && rec.count) || 0;
    if (auth.k !== 'admin' && used >= RUN_CAP) {
      const promo = auth.k === 'promo';
      await store.setJSON(jobId, {
        status: 'limit',
        promo: promo,
        buyLink: promo ? BUY_LINK : '',
        message: promo
          ? 'You\'ve used all ' + RUN_CAP + ' Greenprints that came with this promo code. Nothing is broken — this is just the limit for promo access. To keep making Greenprints, you can get your own license for the Greenprint Generator.'
          : 'You\'ve used all ' + RUN_CAP + ' of this month\'s Greenprints. Nothing is broken — each license includes ' + RUN_CAP + ' Greenprints per month so we can keep the Generator running at a one-time price. Your count resets on ' + nextResetLabel() + '. Questions? Email smartscapeapp@gmail.com.'
      });
      return { statusCode: 202, body: '' };
    }

    // ----- write -----
    const messages = incoming.messages;
    const promptText = typeof messages[0].content === 'string' ? messages[0].content : messages[0].content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
    const sd = promptText.match(/Site details:\n([\s\S]*?)\n\s*If you are not certain/);
    const siteDetails = sd ? sd[1] : promptText.slice(0, 600);

    // yard-size rule appended to what the writer sees
    const limitFt = heightLimit(siteDetails);
    let writerMessages = messages;
    if (limitFt) {
      const extra = '\n\nSIZE RULE: this yard is small. Do not recommend any plant whose mature height is more than ' + (limitFt - 10) + ' feet (no large forest trees such as pines or tall oaks). Choose smaller trees, shrubs, grasses and wildflowers that fit the yard.';
      writerMessages = messages.map(function (m, i) {
        if (i !== 0) return m;
        if (typeof m.content === 'string') return { role: m.role, content: m.content + extra };
        return { role: m.role, content: m.content.concat([{ type: 'text', text: extra }]) };
      });
    }
    let writerModel = '';
    let text, truncated;
    try {
      const w = await callClaude(API_KEY, TASK_MODELS.write, 6000, writerMessages, usage);
      text = w.text; truncated = w.truncated; writerModel = w.model;
    } catch (e) {
      console.log('Cheap writer failed after retries, using the stronger model: ' + e.message);
      const w = await callClaude(API_KEY, TASK_MODELS.fullRewrite, 6000, writerMessages, usage);
      text = w.text; truncated = w.truncated;
    }

    const writerRaw = text;
    const isMismatch = /PHOTO_MISMATCH:/.test(text);
    let reviewed = 0, usedRewrite = false, reviewerOk = true, reviewerRan = false, reviewerNotes = '', reviewerProposed = 0, reviewerDetail = null;
    if (!isMismatch) {
      // structure check -> Sonnet full rewrite (rare)
      let problem = structureProblem(text, truncated);
      if (problem) {
        console.log('Structure problem from writer: ' + problem + ' — Sonnet rewrite.');
        const retryMessages = writerMessages.concat([
          { role: 'assistant', content: text },
          { role: 'user', content: problem + ' Provide your complete full response again in the exact same format, but keep every section — especially each plant description and the PLANTING TIMELINE — as concise as the instructions allow so the full response fits completely, while still including all FOUR seasons (Fall, Winter, Spring, Summer) as separate headers each with at least one bullet, AND every single plant line ending with its own "Attracts: [...]" tag naming specific pollinators, birds, or wildlife followed by "Lifecycle: [Perennial/Annual/Biennial]." Never drop either tag to save space.' }
        ]);
        try {
          const r = await callClaude(API_KEY, TASK_MODELS.fullRewrite, 6000, retryMessages, usage);
          if (!structureProblem(r.text, r.truncated) || structureProblem(text, truncated)) { text = r.text; truncated = r.truncated; usedRewrite = true; }
        } catch (e) { console.log('Sonnet rewrite failed: ' + e.message); }
      }

      text = applyCodeFixes(text);

      if (!structureProblem(text, truncated)) {
        const rv = await reviewGreenprint(API_KEY, text, siteDetails, usage);
        text = rv.text; reviewed = rv.changed; reviewerOk = rv.ok; reviewerRan = true; reviewerNotes = rv.notes || ''; reviewerProposed = rv.proposed || 0; reviewerDetail = rv.detail || null;
        text = applyCodeFixes(text);
      }
    }

    // ----- count the run (not for photo mismatches) -----
    let newCount = used, warning = '';
    if (!isMismatch && auth.k !== 'admin') {
      newCount = used + 1;
      try { await meter.setJSON(mKey, { count: newCount, updated: new Date().toISOString() }); } catch (e) { console.log('Meter write failed: ' + e.message); }
      const left = RUN_CAP - newCount;
      if (newCount >= RUN_CAP) {
        warning = auth.k === 'promo'
          ? 'That was your last Greenprint on this promo code. To keep making Greenprints, you can get your own license for the Greenprint Generator.'
          : 'That was your last Greenprint for this month. Your count resets on ' + nextResetLabel() + '.';
      } else if (newCount >= WARN_AT) {
        warning = 'Heads up: you\'ve used ' + newCount + ' of your ' + RUN_CAP + (auth.k === 'promo' ? ' promo-code Greenprints.' : ' Greenprints for this month.') + ' You have ' + left + ' left.';
      }
    }

    const cost = costOf(usage);
    console.log('USAGE ' + JSON.stringify({ jobId: jobId, cost: cost, usage: usage, rewrite: usedRewrite, reviewerFixes: reviewed, reviewerOk: reviewerOk, mismatch: isMismatch }));
    try {
      await getStore({ name: 'run-costs', siteID: SITE_ID, token: process.env.BLOBS_TOKEN })
        .setJSON(jobId, { time: new Date().toISOString(), cost: cost, usage: usage, rewrite: usedRewrite, reviewerFixes: reviewed, reviewerOk: reviewerOk });
    } catch (e) { /* non-blocking */ }

    const debugNote = { time: new Date().toISOString(), cost: cost, usage: usage, writer: writerModel, models: TASK_MODELS, rewrite: usedRewrite, reviewerRan: reviewerRan, reviewerOk: reviewerOk, reviewerProposed: reviewerProposed, reviewerApplied: reviewed, reviewerNotes: reviewerNotes, reviewerDetail: reviewerDetail, writerRaw: writerRaw, finalText: text };
    try {
      await getStore({ name: 'run-debug', siteID: SITE_ID, token: process.env.BLOBS_TOKEN }).setJSON(jobId, debugNote);
    } catch (e) { console.log('Debug note save failed: ' + e.message); }
    await store.setJSON(jobId, {
      status: 'done',
      body: JSON.stringify({ content: [{ type: 'text', text: text }] }),
      warning: warning,
      debug: { cost: cost, usage: usage, writer: writerModel, models: TASK_MODELS, rewrite: usedRewrite, reviewerRan: reviewerRan, reviewerOk: reviewerOk, reviewerProposed: reviewerProposed, reviewerApplied: reviewed, reviewerNotes: reviewerNotes, reviewerDetail: reviewerDetail, writerRaw: writerRaw, finalText: text },
      promo: auth.k === 'promo',
      buyLink: auth.k === 'promo' && newCount >= RUN_CAP ? BUY_LINK : ''
    });
  } catch (err) {
    console.log('Error:', err.message);
    if (jobId) {
      try {
        const store = getStore({ name: 'greenprint-jobs' });
        await store.setJSON(jobId, { status: 'error', message: 'The AI powering Greenprint Generator is very busy right now' });
      } catch (storeErr) { console.log('Failed to write error to store:', storeErr.message); }
    }
  }
  return { statusCode: 202, body: '' };
};
