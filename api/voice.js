// api/voice.js
// Vercel serverless function — receives base64 audio, transcribes with Whisper,
// interprets intent with Claude, returns structured task data.

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { audio, mimeType, projects = [], focusAreas = [] } = req.body;
  if (!audio) {
    return res.status(400).json({ error: 'No audio provided' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  }

  if (!OPENAI_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
  }

  // ── Step 1: Transcribe with Whisper ─────────────────────────────
  let transcript = '';

  try {
    const buffer = Buffer.from(audio, 'base64');
    const ext = mimeType?.includes('mp4') ? 'mp4' : 'webm';
    const filename = `audio.${ext}`;

    const boundary = '----KairoVoiceBoundary' + Date.now();

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType || 'audio/webm'}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      console.error('Whisper error:', err);
      return res.status(500).json({ error: 'Transcription failed', detail: err });
    }

    const whisperData = await whisperRes.json();
    transcript = whisperData.text?.trim() || '';
  } catch (e) {
    console.error('Whisper exception:', e);
    return res.status(500).json({ error: 'Transcription exception', detail: e.message });
  }

  if (!transcript) {
    return res.json({ transcript: '', task: null });
  }

  // ── Step 2: Interpret with Claude ─────────────────────────────
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const projectList = projects.map(p => `- "${p.title}" (id: ${p.id})`).join('\n') || 'None';
  const areaList = focusAreas.join(', ') || 'Career, Health, Personal, Life Admin, Growth';

  const prompt = `You are a task parser for a personal productivity app called Kairo.

The user just said: "${transcript}"

Today's date: ${today}

Available focus areas: ${areaList}
Available projects:
${projectList}

Respond ONLY with a valid JSON object:
{
  "title": "clean task title",
  "focusArea": "one of the focus areas above",
  "dueDate": "YYYY-MM-DD or null",
  "projectId": "matching project id or null",
  "notes": "any extra context or null"
}

Rules:
- If user says "today", dueDate = ${today}
- If "tomorrow", dueDate = ${tomorrow}
- Default focusArea = "Personal"
`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Claude error:', err);
      return res.json({ transcript, task: null });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text?.trim() || '';

    let task = null;

    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      task = JSON.parse(clean);
    } catch {
      console.error('JSON parse failed:', raw);
    }

    return res.json({ transcript, task });

  } catch (e) {
    console.error('Claude exception:', e);
    return res.json({ transcript, task: null });
  }
};
