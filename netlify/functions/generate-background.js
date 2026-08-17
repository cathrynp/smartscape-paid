const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async function(event) {
  connectLambda(event);
  let jobId;
  try {
    const incoming = JSON.parse(event.body);
    jobId = incoming.jobId;
    const store = getStore({ name: 'greenprint-jobs' });
    const API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!API_KEY) {
      await store.setJSON(jobId, { status: 'error', message: 'API key not configured' });
      return { statusCode: 202, body: '' };
    }

    const requestBody = {
      model: 'claude-sonnet-4-6',
      max_tokens: 3500,
      messages: incoming.messages
    };

    function extractAssistantText(rawResponseText) {
      try {
        const parsed = JSON.parse(rawResponseText);
        return (parsed.content && parsed.content[0] && parsed.content[0].text) || '';
      } catch (e) {
        return '';
      }
    }

    function wasTruncated(rawResponseText) {
      try {
        const parsed = JSON.parse(rawResponseText);
        return parsed.stop_reason === 'max_tokens';
      } catch (e) {
        return false;
      }
    }

    function missingSeasons(assistantText) {
      const tIdx = assistantText.indexOf('PLANTING TIMELINE');
      if (tIdx === -1) return ['Fall', 'Winter', 'Spring', 'Summer']; // can't verify, treat as missing
      const sIdx = assistantText.indexOf('SPECIES COUNT', tIdx);
      const timelineSection = sIdx === -1 ? assistantText.slice(tIdx) : assistantText.slice(tIdx, sIdx);
      const seasons = ['Fall', 'Winter', 'Spring', 'Summer'];
      return seasons.filter(function(s) { return timelineSection.indexOf(s) === -1; });
    }

    function plantLinesMissingAttracts(assistantText) {
      const rIdx = assistantText.indexOf('RECOMMENDED NATIVE PLANTS');
      if (rIdx === -1) return 0;
      const tIdx = assistantText.indexOf('PLANTING TIMELINE', rIdx);
      const plantSection = tIdx === -1 ? assistantText.slice(rIdx) : assistantText.slice(rIdx, tIdx);
      const plantLines = plantSection.split('\n').filter(function(l) { return l.trim().startsWith('-'); });
      return plantLines.filter(function(l) { return l.indexOf('Attracts:') === -1; }).length;
    }

    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    let text = await response.text();
    console.log('Anthropic status:', response.status, 'response:', text.substring(0, 300));

    // Reliability check: response must not be cut off, and PLANTING TIMELINE must include all 4 seasons. Retry once if either fails.
    if (response.status === 200) {
      const truncated = wasTruncated(text);
      const missing = missingSeasons(extractAssistantText(text));
      const missingAttracts = plantLinesMissingAttracts(extractAssistantText(text));
      if (truncated || missing.length > 0 || missingAttracts > 0) {
        let reason;
        if (truncated) {
          reason = 'Your previous response above was cut off before it finished (it ran out of space partway through, most likely during the PLANTING TIMELINE section).';
        } else if (missing.length > 0) {
          reason = 'Your PLANTING TIMELINE above is missing the following required season(s): ' + missing.join(', ') + '.';
        } else {
          reason = missingAttracts + ' plant line(s) above are missing the required trailing "Attracts: [...]" tag naming the specific pollinators, birds, or wildlife that plant supports.';
        }
        console.log(truncated ? 'Response was truncated (stop_reason: max_tokens) — retrying once.' : (missing.length > 0 ? 'Missing season(s) in first attempt: ' + missing.join(', ') + ' — retrying once.' : missingAttracts + ' plant line(s) missing Attracts tag — retrying once.'));
        const priorAssistantText = extractAssistantText(text);
        const retryMessages = incoming.messages.concat([
          { role: 'assistant', content: priorAssistantText },
          { role: 'user', content: reason + ' Provide your complete full response again in the exact same format, but this time keep every section — especially each plant description and the PLANTING TIMELINE — as concise as the instructions allow so the full response fits completely, while still including all FOUR seasons (Fall, Winter, Spring, Summer) as separate headers each with at least one bullet, AND every single plant line ending with its own "Attracts: [...]" tag naming specific pollinators, birds, or wildlife — never drop the Attracts tag to save space. Even if a season is maintenance-only, it must still appear with its own header and content.' }
        ]);
        const retryResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3500, messages: retryMessages })
        });
        const retryText = await retryResponse.text();
        console.log('Retry status:', retryResponse.status, 'response:', retryText.substring(0, 300));
        if (retryResponse.status === 200 && !wasTruncated(retryText) && missingSeasons(extractAssistantText(retryText)).length === 0 && plantLinesMissingAttracts(extractAssistantText(retryText)) === 0) {
          text = retryText;
        } else {
          console.log('Retry still truncated, still missing season(s)/Attracts tags, or failed; keeping original response.');
        }
      }
    }

    await store.setJSON(jobId, { status: 'done', body: text });
  } catch (err) {
    console.log('Error:', err.message);
    if (jobId) {
      try {
        const store = getStore({ name: 'greenprint-jobs' });
        await store.setJSON(jobId, { status: 'error', message: err.message });
      } catch (storeErr) {
        console.log('Failed to write error to store:', storeErr.message);
      }
    }
  }
  return { statusCode: 202, body: '' };
};
