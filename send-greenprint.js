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

  const { email, zip, siteAnalysis, plants, timeline, nurseries } = body;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email' }) };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  // Format nursery data into structured HTML
  function renderNurseryRow(n) {
    const tagColors = {
      wholesale: 'background:#fef3e2;color:#7a4f0a;',
      ships: 'background:#e8f4fd;color:#0a4a7a;',
      seed: 'background:#f3e8fd;color:#4a0a7a;',
      resource: 'background:#f0ede8;color:#5a5248;',
      directory: 'background:#f0ede8;color:#5a5248;'
    };
    const tags = (n.tags || []).slice(0, 3).map(t => {
      const style = tagColors[t] || 'background:#f0f7eb;color:#1a3a0f;';
      return `<span style="font-size:10px;padding:2px 8px;border-radius:99px;${style}margin-right:4px;">${t}</span>`;
    }).join('');
    return `
      <tr><td style="padding:10px 0;border-bottom:1px solid #f0ede8;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:14px;font-weight:500;color:#1c1a16;">${n.name}</div>
              <div style="font-size:12px;color:#6b6558;margin-top:2px;line-height:1.45;">${n.city}, ${n.state} — ${n.desc}</div>
              <div style="margin-top:5px;">${tags}</div>
            </td>
            <td style="vertical-align:top;text-align:right;white-space:nowrap;padding-left:12px;">
              <a href="${n.url}" style="font-size:12px;color:#2d6a1f;font-weight:500;text-decoration:none;">Visit →</a>
            </td>
          </tr>
        </table>
      </td></tr>`;
  }

  let nurseryHTML = '';
  if (nurseries && nurseries.local && nurseries.local.length) {
    nurseryHTML += `<tr><td style="font-size:11px;font-weight:500;color:#6b6558;letter-spacing:0.06em;text-transform:uppercase;padding:12px 0 6px;border-bottom:1px solid #eee;">📍 ${nurseries.regionLabel}</td></tr>`;
    nurseryHTML += nurseries.local.map(renderNurseryRow).join('');
  }
  if (nurseries && nurseries.national && nurseries.national.length) {
    nurseryHTML += `<tr><td style="font-size:11px;font-weight:500;color:#6b6558;letter-spacing:0.06em;text-transform:uppercase;padding:16px 0 6px;border-bottom:1px solid #eee;">🚚 Ships nationwide</td></tr>`;
    nurseryHTML += nurseries.national.map(renderNurseryRow).join('');
  }

  // Format plant lines
  const plantLines = (plants || '').split('\n')
    .filter(l => l.trim())
    .map(l => {
      const parts = l.split('—');
      if (parts.length > 1) {
        return `<li style="margin-bottom:8px;"><strong style="color:#1a3a0f;">${parts[0].trim()}</strong> — ${parts.slice(1).join('—').trim()}</li>`;
      }
      return `<li style="margin-bottom:8px;">${l.trim()}</li>`;
    })
    .join('');

  // Format timeline lines
  const timeLines = (timeline || '').split('\n')
    .filter(l => l.trim())
    .map(l => {
      const ci = l.indexOf(':');
      if (ci > -1 && ci < 40) {
        return `<li style="margin-bottom:8px;"><strong style="color:#1a3a0f;">${l.substring(0, ci)}:</strong>${l.substring(ci+1)}</li>`;
      }
      return `<li style="margin-bottom:8px;">${l.trim()}</li>`;
    })
    .join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f0f4eb;font-family:'Georgia',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4eb;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#1a3a0f;padding:32px 36px;">
          <p style="margin:0;font-size:11px;letter-spacing:0.12em;color:#c8e6b8;text-transform:uppercase;">SmartScape</p>
          <h1 style="margin:8px 0 4px;font-size:28px;color:white;font-weight:500;">Your Greenprint</h1>
          <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.65);">AI-generated native plant plan for zip code ${zip || 'your area'}</p>
        </td></tr>

        <!-- Site Analysis -->
        <tr><td style="padding:28px 36px 0;">
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">🔍 Site Analysis</h2>
          <p style="margin:0;font-size:14px;color:#333;line-height:1.7;">${(siteAnalysis || '').replace(/\n/g, '<br>')}</p>
        </td></tr>

        <!-- Plants -->
        <tr><td style="padding:24px 36px 0;">
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">🌱 Recommended Native Plants</h2>
          <ul style="margin:0;padding-left:20px;font-size:14px;color:#333;line-height:1.6;">${plantLines || '<li>See your Greenprint for plant recommendations.</li>'}</ul>
        </td></tr>

        <!-- Timeline -->
        <tr><td style="padding:24px 36px 0;">
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">📅 Planting Timeline</h2>
          <ul style="margin:0;padding-left:20px;font-size:14px;color:#333;line-height:1.6;">${timeLines || '<li>See your Greenprint for timeline details.</li>'}</ul>
        </td></tr>

        <!-- Nurseries -->
        ${nurseryHTML ? `
        <tr><td style="padding:24px 36px 0;">
          <h2 style="margin:0 0 12px;font-size:16px;color:#1a3a0f;border-bottom:2px solid #c8e6b8;padding-bottom:8px;">🏡 Native Plant Nurseries Near You</h2>
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#333;">${nurseryHTML}</table>
        </td></tr>` : ''}

        <!-- Footer -->
        <tr><td style="padding:28px 36px;background:#f0f7eb;margin-top:24px;">
          <p style="margin:0 0 8px;font-size:12px;color:#5a7052;line-height:1.6;">AI plant recommendations are generated by Anthropic Claude. Recommendations are for informational purposes only — verify species suitability with a local expert before planting.</p>
          <p style="margin:0;font-size:12px;color:#5a7052;">Generated by <a href="https://greenprint-subscriber.netlify.app" style="color:#2d6a1f;">SmartScape Greenprint Generator</a> · Beta 2026</p>
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
        subject: `Your SmartScape Greenprint — Zip ${zip || ''}`,
        html: html
      })
    });

    const data = await resp.json();

    if (resp.ok) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true })
      };
    } else {
      console.error('Resend error:', data);
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: data.message || 'Send failed' })
      };
    }
  } catch(err) {
    console.error('Send error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
