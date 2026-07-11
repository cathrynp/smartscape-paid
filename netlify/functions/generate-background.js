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
      max_tokens: 2000,
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

    function missingSeasons(assistantText) {
      const tIdx = assistantText.indexOf('PLANTING TIMELINE');
      if (tIdx === -1) return ['Fall', 'Winter', 'Spring', 'Summer']; // can't verify, treat as missing
      const sIdx = assistantText.indexOf('SPECIES COUNT', tIdx);
      const timelineSection = sIdx === -1 ? assistantText.slice(tIdx) : assistantText.slice(tIdx, sIdx);
      const seasons = ['Fall', 'Winter', 'Spring', 'Summer'];
      return seasons.filter(function(s) { return timelineSection.indexOf(s) === -1; });
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

    // Reliability check: PLANTING TIMELINE must include all 4 seasons. Retry once if any are missing.
    if (response.status === 200) {
      const missing = missingSeasons(extractAssistantText(text));
      if (missing.length > 0) {
        console.log('Missing season(s) in first attempt:', missing.join(', '), '— retrying once.');
        const priorAssistantText = extractAssistantText(text);
        const retryMessages = incoming.messages.concat([
          { role: 'assistant', content: priorAssistantText },
          { role: 'user', content: 'Your PLANTING TIMELINE above is missing the following required season(s): ' + missing.join(', ') + '. Provide your complete full response again in the exact same format, but this time include ALL FOUR seasons (Fall, Winter, Spring, Summer) as separate headers, each with at least one bullet — even if a season is maintenance-only, it must still appear with its own header and content.' }
        ]);
        const retryResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: retryMessages })
        });
        const retryText = await retryResponse.text();
        console.log('Retry status:', retryResponse.status, 'response:', retryText.substring(0, 300));
        if (retryResponse.status === 200 && missingSeasons(extractAssistantText(retryText)).length === 0) {
          text = retryText;
        } else {
          console.log('Retry still missing season(s) or failed; keeping original response.');
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
