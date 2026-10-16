// netlify/functions/generate-background.js  (PAID app)
// Pipeline: check access token + usage cap -> Haiku writes the Greenprint ->
// structure checks (Sonnet full rewrite only if broken) -> free code fixes ->
// Sonnet reviewer returns replacement entries ONLY for flagged plants, swapped in by code.
// Reviewer problems are retried quietly; at worst the Greenprint is delivered with the code fixes only.

const { connectLambda, getStore } = require('@netlify/blobs');
const { readToken } = require('./lib/auth');

const SITE_ID = '58059f0f-bc4f-4cec-8963-b609550a12e6';
const WRITER = 'claude-haiku-4-5-20251001';
const STRONG = 'claude-sonnet-4-6';
const PRICES = { 'claude-haiku-4-5-20251001': [1, 5], 'claude-sonnet-4-6': [3, 15] }; // $ per million tokens (in, out)
const RUN_CAP = 10;       // Greenprints per month per license / lifetime per promo redemption
const WARN_AT = 8;        // show a heads-up once this many are used
const BUY_LINK = 'https://smartscape.gumroad.com/l/greenprint';
const PROMPT_SENTINEL = 'You are SmartScape, an expert in native plants and climate-resilient landscaping';

// Free fixes: known, mechanical mistakes corrected without spending any tokens.
// Add a line here whenever you spot a repeat error.
const CODE_FIXES = [
  [/Scrub Live Oak(\s*\(Quercus geminata\))/gi, 'Sand Live Oak$1'],
  [/(Coastalplain Honeycombhead\s*\()Balduina uniflora(\))/gi, '$1Balduina angustifolia$2'],
  [/\b(?:the\s+)?(?:official\s+)?state wildflower\b/gi, 'a native wildflower']
];

// Rules the reviewer checks. Add new known mistakes to KNOWN_MISTAKES.
const KNOWN_MISTAKES = [
  'Quercus geminata is Sand Live Oak (not "Scrub Live Oak"); Quercus inopina is Scrub Oak.',
  'Coastalplain Honeycombhead is Balduina angustifolia. Balduina uniflora is Oneflower Honeycombhead (flatwoods/bog plant of the panhandle and NE Florida).',
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
async function callClaude(apiKey, model, maxTokens, messages, usageAcc, system) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = { model: model, max_tokens: maxTokens, messages: messages };
      if (system) body.system = system;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body)
      });
      const raw = await resp.text();
      if (resp.status === 200) {
        const parsed = JSON.parse(raw);
        usagePlus(usageAcc, model, parsed.usage);
        return {
          text: (parsed.content && parsed.content[0] && parsed.content[0].text) || '',
          truncated: parsed.stop_reason === 'max_tokens'
        };
      }
      lastErr = new Error('Anthropic ' + resp.status + ': ' + raw.slice(0, 200));
      if (resp.status < 500 && resp.status !== 429) break;
    } catch (e) { lastErr = e; }
    await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
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

// ---------- reviewer ----------
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

function buildReviewPrompt(siteDetails, plantLines, timeline) {
  return 'You are a careful native-plant fact checker for a landscaping app. Check the plant list and planting timeline below against the site details. Be conservative: flag a plant ONLY when you are confident there is a real error. Do not rewrite for style.\n\n' +
    'SITE DETAILS:\n' + siteDetails + '\n\n' +
    'CHECK EACH PLANT FOR:\n' +
    '1. The scientific name actually belongs to the common name given (wrong species / name mix-ups).\n' +
    '2. It is truly native to the specific ecoregion/zip, not just the state.\n' +
    '3. Its light, soil, drainage and moisture needs fit the site and the sun selected; wetland/wet-site plants do not fit a dry site or a Water savings goal.\n' +
    '4. Statements about size, wildlife and insects are well established (no unverified insect claims); milkweed is a locally native species.\n' +
    '5. State-listed endangered/threatened plants carry a short sourcing note (buy only nursery-propagated stock).\n' +
    '6. The planting timeline is consistent with the plant lines and with itself (for example, no advice to save seed for a season in which another entry says to sow it).\n' +
    '7. Tree size fits the yard size.\n\n' +
    'KNOWN MISTAKES TO CATCH:\n- ' + KNOWN_MISTAKES.join('\n- ') + '\n\n' +
    'PLANTS (numbered in order):\n' + plantLines.map(function (l, i) { return (i + 1) + '. ' + l.trim(); }).join('\n') + '\n\n' +
    'PLANTING TIMELINE:\n' + timeline.trim() + '\n\n' +
    'Reply with ONLY a JSON object, no other text:\n' +
    '{"plant_fixes":[{"n":<plant number>,"new_line":"<the complete corrected plant line, starting with \\"- \\", in the EXACT same format as the original: Common Name (Scientific name) — description. Mature size: ... [Indigenous-use sentence if present]. Attracts: ... Lifecycle: ...>"}],' +
    '"timeline_fixes":[{"find":"<exact text copied from the timeline, appearing once>","replace":"<corrected text>"}]}\n' +
    'Rules for fixes: for a wrong name or fact, correct the line but keep its length, style and format. If a plant does not fit the site, replace it with a different native plant that does fit (same layer, not already in the list) written in the same format. Keep the writing plain-language. If you replace or rename a plant, include timeline_fixes for every timeline mention of the old plant. If nothing needs fixing return {"plant_fixes":[],"timeline_fixes":[]}.';
}

function parseJson(s) {
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function applyReview(t, review) {
  const sec = splitSections(t);
  if (!sec || !review) return { text: t, changed: 0 };
  let plantsBlock = t.slice(sec.ps.start, sec.ps.end);
  let timeline = t.slice(sec.tStart, sec.tEnd);
  const lines = plantsBlock.split('\n');
  const idxs = [];
  lines.forEach(function (l, i) { if (l.trim().startsWith('-')) idxs.push(i); });
  const existingNames = idxs.map(function (i) { return sciName(lines[i]); });
  let changed = 0;
  (Array.isArray(review.plant_fixes) ? review.plant_fixes : []).forEach(function (f) {
    const n = parseInt(f && f.n, 10);
    const nl = f && typeof f.new_line === 'string' ? f.new_line.trim() : '';
    if (!(n >= 1 && n <= idxs.length) || !nl) return;
    if (nl.indexOf('\n') !== -1 || nl.length > 1800 || nl.length < 80) return;
    if (!nl.startsWith('- ') || !/\([^)]+\)/.test(nl) || nl.indexOf('Attracts:') === -1 || !/Lifecycle:\s*(Perennial|Annual|Biennial)/i.test(nl)) return;
    const name = sciName(nl);
    const others = existingNames.filter(function (x, k) { return k !== n - 1; });
    if (name && others.indexOf(name) !== -1) return;
    const li = idxs[n - 1];
    const lead = lines[li].match(/^\s*/)[0];
    lines[li] = lead + nl;
    existingNames[n - 1] = name;
    changed++;
  });
  plantsBlock = lines.join('\n');
  (Array.isArray(review.timeline_fixes) ? review.timeline_fixes : []).forEach(function (f) {
    if (!f || typeof f.find !== 'string' || typeof f.replace !== 'string') return;
    if (f.find.length < 4 || f.replace.length > 800) return;
    const first = timeline.indexOf(f.find);
    if (first === -1 || timeline.indexOf(f.find, first + 1) !== -1) return;
    timeline = timeline.slice(0, first) + f.replace + timeline.slice(first + f.find.length);
    changed++;
  });
  const out = t.slice(0, sec.ps.start) + plantsBlock + t.slice(sec.ps.end, sec.tStart) + timeline + t.slice(sec.tEnd);
  return { text: out, changed: changed };
}

async function reviewGreenprint(apiKey, t, siteDetails, usageAcc) {
  const sec = splitSections(t);
  if (!sec) return { text: t, changed: 0, ok: false };
  const plantLines = t.slice(sec.ps.start, sec.ps.end).split('\n').filter(function (l) { return l.trim().startsWith('-'); });
  const timeline = t.slice(sec.tStart, sec.tEnd);
  const prompt = buildReviewPrompt(siteDetails, plantLines, timeline);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await callClaude(apiKey, STRONG, 3000, [{ role: 'user', content: prompt }], usageAcc);
      const review = parseJson(r.text);
      if (!review) { console.log('Reviewer reply not parseable (attempt ' + (attempt + 1) + ')'); continue; }
      const applied = applyReview(t, review);
      if (applied.changed > 0 && structureProblem(applied.text, false)) {
        console.log('Reviewed text failed structure check; discarding review edits.');
        return { text: t, changed: 0, ok: true };
      }
      return { text: applied.text, changed: applied.changed, ok: true };
    } catch (e) {
      console.log('Reviewer attempt ' + (attempt + 1) + ' failed: ' + e.message);
    }
  }
  return { text: t, changed: 0, ok: false };
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
    if (!auth || (auth.k !== 'promo' && auth.k !== 'lic') || !auth.id) {
      await store.setJSON(jobId, { status: 'auth', message: 'Please enter your license key to continue.' });
      return { statusCode: 202, body: '' };
    }
    const meter = getStore({ name: 'usage-meter', siteID: SITE_ID, token: process.env.BLOBS_TOKEN });
    const mKey = meterKey(auth);
    const rec = await meter.get(mKey, { type: 'json' });
    const used = (rec && rec.count) || 0;
    if (used >= RUN_CAP) {
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

    let text, truncated;
    try {
      const w = await callClaude(API_KEY, WRITER, 6000, messages, usage);
      text = w.text; truncated = w.truncated;
    } catch (e) {
      console.log('Haiku writer failed after retries, using Sonnet: ' + e.message);
      const w = await callClaude(API_KEY, STRONG, 6000, messages, usage);
      text = w.text; truncated = w.truncated;
    }

    const isMismatch = /PHOTO_MISMATCH:/.test(text);
    let reviewed = 0, usedRewrite = false, reviewerOk = true;
    if (!isMismatch) {
      // structure check -> Sonnet full rewrite (rare)
      let problem = structureProblem(text, truncated);
      if (problem) {
        console.log('Structure problem from writer: ' + problem + ' — Sonnet rewrite.');
        const retryMessages = messages.concat([
          { role: 'assistant', content: text },
          { role: 'user', content: problem + ' Provide your complete full response again in the exact same format, but keep every section — especially each plant description and the PLANTING TIMELINE — as concise as the instructions allow so the full response fits completely, while still including all FOUR seasons (Fall, Winter, Spring, Summer) as separate headers each with at least one bullet, AND every single plant line ending with its own "Attracts: [...]" tag naming specific pollinators, birds, or wildlife followed by "Lifecycle: [Perennial/Annual/Biennial]." Never drop either tag to save space.' }
        ]);
        try {
          const r = await callClaude(API_KEY, STRONG, 6000, retryMessages, usage);
          if (!structureProblem(r.text, r.truncated) || structureProblem(text, truncated)) { text = r.text; truncated = r.truncated; usedRewrite = true; }
        } catch (e) { console.log('Sonnet rewrite failed: ' + e.message); }
      }

      text = applyCodeFixes(text);

      if (!structureProblem(text, truncated)) {
        const rv = await reviewGreenprint(API_KEY, text, siteDetails, usage);
        text = rv.text; reviewed = rv.changed; reviewerOk = rv.ok;
        text = applyCodeFixes(text);
      }
    }

    // ----- count the run (not for photo mismatches) -----
    let newCount = used, warning = '';
    if (!isMismatch) {
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

    await store.setJSON(jobId, {
      status: 'done',
      body: JSON.stringify({ content: [{ type: 'text', text: text }] }),
      warning: warning,
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
