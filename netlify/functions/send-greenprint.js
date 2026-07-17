function renderNurseryRow(n) {
  const tagColors = {
    wholesale: 'background:#fef3e2;color:#7a4f0a;',
    ships: 'background:#e8f4fd;color:#0a4a7a;',
    seed: 'background:#f3e8fd;color:#4a0a7a;',
    resource: 'background:#f0ede8;color:#5a5248;',
    directory: 'background:#f0ede8;color:#5a5248;'
  };
  const tags = (n.tags || []).slice(0, 3).map(function(t) {
    const style = tagColors[t] || 'background:#f0f7eb;color:#1a3a0f;';
    return '<span style="font-size:10px;padding:2px 8px;border-radius:99px;' + style + 'margin-right:4px;">' + t + '</span>';
  }).join('');
  return '<tr><td style="padding:10px 0;border-bottom:1px solid #f0ede8;">' +
    '<table width="100%" cellpadding="0" cellspacing="0"><tr>' +
    '<td style="vertical-align:top;">' +
    '<div style="font-size:14px;font-weight:500;color:#1c1a16;">' + (n.name || '') + '</div>' +
    '<div style="font-size:12px;color:#6b6558;margin-top:2px;line-height:1.45;">' + (n.city || '') + ', ' + (n.state || '') + ' — ' + (n.desc || '') + '</div>' +
    '<div style="margin-top:5px;">' + tags + '</div>' +
    '</td>' +
    '<td style="vertical-align:top;text-align:right;white-space:nowrap;padding-left:12px;">' +
    '<a href="' + (n.url || '#') + '" style="font-size:12px;color:#2d6a1f;font-weight:500;text-decoration:none;">Visit →</a>' +
    '</td></tr></table>' +
    '</td></tr>';
}

// Fetch a Wikipedia thumbnail URL for a scientific name (returns null if not found)
async function fetchWikiThumb(scientificName) {
  try {
    const slug = scientificName.trim().replace(/\s+/g, '_');
    const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(slug);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.thumbnail && data.thumbnail.source) ? data.thumbnail.source : null;
  } catch(e) {
    return null;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const { email, zip, siteAnalysis, summaryLine, plants, timeline, nurseries, includePhotos } = body;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email' }) };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  // Build nursery HTML from structured object
  let nurseryHTML = '';
  try {
    if (nurseries && typeof nurseries === 'object') {
      if (nurseries.local && nurseries.local.length) {
        nurseryHTML += nurseries.local.map(renderNurseryRow).join('');
      }
      if (nurseries.national && nurseries.national.length) {
        nurseryHTML += '<tr><td style="background:#f0f7eb;border:1px solid #d0e8c4;border-radius:6px;padding:12px 16px;margin-top:8px;margin-bottom:8px;"><span style="font-size:12px;font-weight:700;color:#1a3a0f;letter-spacing:0.06em;text-transform:uppercase;">🚚 Order online — Nurseries that ship nationwide</span></td></tr>';
        nurseryHTML += nurseries.national.map(renderNurseryRow).join('');
      }
    }
  } catch(nurseryErr) {
    console.error('Nursery render error:', nurseryErr);
    nurseryHTML = '';
  }

  // Parse plant lines and optionally fetch Wikipedia thumbnails
  const allLines = (plants || '').split('\n').filter(function(l) { return l.trim() && !/^\s*[-_*]{2,}\s*$/.test(l); });
  const rawPlantLines = allLines.filter(function(l) { return l.trim().startsWith('-'); });

  // Build a map of idx -> thumbnail URL (only if includePhotos is true)
  const thumbMap = {};
  if (includePhotos) {
    await Promise.all(rawPlantLines.map(async function(l, idx) {
      const sciMatch = l.match(/\(([A-Z][a-z]+(?:\s+[a-z]+)+)\)/);
      if (!sciMatch) return;
      const thumb = await fetchWikiThumb(sciMatch[1]);
      if (thumb) thumbMap[idx] = thumb;
    }));
  }

  // Render plant rows grouped under their LAYER headers (with or without photos)
  let plantIdx = 0;
  const plantLines = allLines.map(function(l) {
    const trimmed = l.trim();
    const layerMatch = trimmed.match(/^LAYER:\s*(.+)$/i);
    if (layerMatch) {
      return '<tr><td style="padding:16px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#8a8473;font-weight:600;">' + layerMatch[1].trim() + '</td></tr>';
    }
    if (!trimmed.startsWith('-')) return '';
    const idx = plantIdx++;
    const clean = trimmed.replace(/^-\s*/, '');
    const parts = clean.split('—');
    let descText = parts.length > 1 ? parts.slice(1).join('—').trim() : '';
    if (descText) descText = descText.charAt(0).toUpperCase() + descText.slice(1);
    const nameHTML = parts.length > 1
      ? parts[0].trim() + ' — ' + descText
      : clean;

    if (includePhotos && thumbMap[idx]) {
      return '<tr><td style="padding:8px 0;border-bottom:1px solid #f0ede8;vertical-align:top;">'
        + '<table width="100%" cellpadding="0" cellspacing="0"><tr>'
        + '<td style="width:72px;vertical-align:top;padding-right:12px;">'
        + '<img src="' + thumbMap[idx] + '" alt="" width="64" height="64" style="width:64px;height:64px;object-fit:cover;border-radius:8px;display:block;border:1px solid #e0ddd6;"/>'
        + '</td>'
        + '<td style="vertical-align:middle;font-size:14px;color:#333;line-height:1.6;">' + nameHTML + '</td>'
        + '</tr></table>'
        + '</td></tr>';
    }
    return '<tr><td style="padding:8px 0;border-bottom:1px solid #f0ede8;font-size:14px;color:#333;line-height:1.6;">'
      + nameHTML
      + '</td></tr>';
  }).join('');

  // Format timeline lines: group bullet items under plain-text season headers
  const rawTimeLines = (timeline || '').split('\n').map(function(l) { return l.replace(/\*\*/g, '').trim(); }).filter(function(l) { return l && !/^\s*[-_*]{2,}\s*$/.test(l); });
  const seasonHeaderRe = /^[-*•\s]*((Fall|Winter|Spring|Summer)\s*\([^)]*\))\s*:?\s*$/i;
  const seasonBlocks = [];
  let curBlock = null;
  rawTimeLines.forEach(function(l) {
    const m = l.match(seasonHeaderRe);
    if (m) {
      curBlock = { header: m[1] + ':', items: [] };
      seasonBlocks.push(curBlock);
    } else {
      const cleanItem = l.replace(/^[-*•]\s*/, '');
      if (!curBlock) { curBlock = { header: '', items: [] }; seasonBlocks.push(curBlock); }
      curBlock.items.push(cleanItem);
    }
  });
  const timeLines = seasonBlocks.map(function(b) {
    const itemsHtml = b.items.map(function(it) { return '<li style="margin-bottom:6px;">' + it + '</li>'; }).join('');
    return '<div style="margin-bottom:14px;">' +
      (b.header ? '<div style="font-weight:600;color:#1a3a0f;margin-bottom:6px;">' + b.header + '</div>' : '') +
      '<ul style="margin:0;padding-left:20px;">' + itemsHtml + '</ul>' +
      '</div>';
  }).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f0f4eb;font-family:'Georgia',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4eb;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background-color:#1a3a0f;background-image:url('https://greenprint-subscriber.netlify.app/email-header-watercolor.jpg');background-size:cover;background-position:center;padding:32px 36px;">
          <div style="margin:0 0 10px;">
            <span style="display:inline-block;margin:0;font-size:11px;letter-spacing:0.12em;color:#000;text-transform:uppercase;font-weight:700;background:rgba(79,143,136,0.65);padding:4px 12px;border-radius:3px;">SmartScape</span>
          </div>
          <div style="margin:0 0 6px;">
            <span style="display:inline-block;font-size:28px;color:#fff;font-weight:500;line-height:1.2;background:rgba(79,143,136,0.65);padding:6px 14px;border-radius:3px;">Your Greenprint</span>
          </div>
          <div style="margin:0;">
            <span style="display:inline-block;font-size:14px;color:#fff;background:rgba(79,143,136,0.65);padding:5px 12px;border-radius:3px;">Native plant plan for zip code ${zip || 'your area'}</span>
          </div>
        </td></tr>

        <!-- Site Analysis -->
        <tr><td style="padding:28px 36px 0;">
          ${summaryLine ? `<p style="margin:0 0 20px;font-size:13px;color:#5a7052;font-style:italic;">${summaryLine}</p>` : ''}
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">🔍 Site Analysis</h2>
          <p style="margin:0;font-size:14px;color:#333;line-height:1.7;">${(siteAnalysis || '').replace(/\n/g, '<br>')}</p>
        </td></tr>

        <!-- Plants -->
        <tr><td style="padding:24px 36px 0;">
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">🌱 Recommended Native Plants</h2>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#333;">${plantLines || '<tr><td style="padding:10px 0;font-size:14px;color:#333;">See your Greenprint for plant recommendations.</td></tr>'}</table>
        </td></tr>

        <!-- Timeline -->
        <tr><td style="padding:24px 36px 0;">
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">📅 Planting Timeline</h2>
          <div style="font-size:14px;color:#333;line-height:1.6;">${timeLines || '<p>See your Greenprint for timeline details.</p>'}</div>
        </td></tr>

        <!-- Nurseries -->
        ${nurseryHTML ? `
        <tr><td style="padding:24px 36px 0;">
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">🏡 Native Plant Nurseries Near You</h2>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#333;">${nurseryHTML}</table>
        </td></tr>` : ''}

        <!-- Footer -->
        <tr><td style="padding:28px 36px;background:#4F8F88;">
          <p style="margin:0 0 8px;font-size:12px;color:rgba(255,255,255,0.85);line-height:1.6;">Your Greenprint's plant recommendations are shaped and directed by real native-plant expertise, powered by Claude AI. Your local nursery is a great resource too — they can confirm current availability and answer any site-specific questions.</p>
          <p style="margin:0 0 14px;font-size:12px;color:rgba(255,255,255,0.85);">Greenprints by <a href="https://smartscape.co" target="_blank" rel="noopener" style="color:#fff;font-weight:600;">SmartScape</a> ✨AI For Good · Early Access 2026</p>
          <p style="margin:0;font-size:12px;color:#fff;padding-top:12px;border-top:1px solid rgba(255,255,255,0.25);">Know someone who could use this? You can gift them a Greenprint of their own — <a href="https://smartscape.gumroad.com/l/greenprint" target="_blank" rel="noopener" style="color:#fff;font-weight:600;text-decoration:underline;">send one here →</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'SmartScape Greenprint <noreply@mail.smartscape.co>',
        to: [email],
        bcc: ['smartscapeapp@gmail.com'],
        reply_to: 'smartscapeapp@gmail.com',
        subject: `Your SmartScape Greenprint — Zip ${zip || ''}`,
        html: html
      })
    });

    const data = await resp.json();

    if (resp.ok) {
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    } else {
      console.error('Resend error:', data);
      return { statusCode: 500, body: JSON.stringify({ success: false, error: data.message || 'Send failed' }) };
    }
  } catch(err) {
    console.error('Send error:', err);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
