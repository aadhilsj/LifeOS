// api/voice.js
// Handles two modes:
// 1. Audio mode: receives base64 audio → Whisper transcription → Claude interpretation
// 2. Text mode:  receives plain text directly → Claude interpretation only (no Whisper)

const VALID_FOCUS_AREAS = ['Career', 'Health', 'Personal', 'Life Admin', 'Growth'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sanitiseTask(t, validProjectIds) {
  if (!t || typeof t !== 'object') return null;
  const title = (t.title || '').trim();
  if (!title) return null;
  return {
    title,
    focusArea: VALID_FOCUS_AREAS.includes(t.focusArea) ? t.focusArea : 'Personal',
    dueDate:   typeof t.dueDate === 'string' && ISO_DATE_RE.test(t.dueDate) ? t.dueDate : null,
    projectId: validProjectIds.includes(t.projectId) ? t.projectId : null,
    notes:     typeof t.notes === 'string' && t.notes.trim() ? t.notes.trim() : null,
  };
}

function salvageTasks(raw, validProjectIds) {
  const tasks = [];
  const objectMatches = raw.match(/\{[^{}]+\}/g) || [];
  for (const chunk of objectMatches) {
    try {
      const sanitised = sanitiseTask(JSON.parse(chunk), validProjectIds);
      if (sanitised) tasks.push(sanitised);
    } catch {}
  }
  return tasks;
}

async function interpretWithClaude(transcript, projects, focusAreas, ANTHROPIC_KEY) {
  const now      = new Date();
  const today    = now.toISOString().split('T')[0];
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const relativeDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now.getTime() + (i + 1) * 86400000);
    return `"next ${dayNames[d.getDay()]}" or "this ${dayNames[d.getDay()]}" = ${d.toISOString().split('T')[0]}`;
  }).join('\n');

  const weekend = Array.from({length:7},(_,i)=>{
    const d=new Date(now.getTime()+(i+1)*86400000);
    return d.getDay()===6?d.toISOString().split('T')[0]:null;
  }).filter(Boolean)[0] || tomorrow;

  const projectList = projects.map(p => `- "${p.title}" (id: ${p.id})`).join('\n') || 'None';
  const areaList    = (focusAreas.length ? focusAreas : VALID_FOCUS_AREAS).join(', ');

  const prompt = `You are a task parser for a personal productivity app called Kairo.

The user said: "${transcript}"

Today: ${today} (${dayNames[now.getDay()]})

Focus areas: ${areaList}
Projects:
${projectList}

DATES:
"today" = ${today}
"tomorrow" = ${tomorrow}
${relativeDates}
"this weekend" = ${weekend}
"next week" = ${new Date(now.getTime() + 7 * 86400000).toISOString().split('T')[0]}
Unknown date reference = null

RULES:
- One action = one task. Multiple actions = multiple tasks.
- "pay phone bill, buy dates, buy toilet paper" → 3 tasks
- "do the grocery shopping" → 1 task (don't invent sub-items)
- title: concise, starts with action verb
- focusArea: shopping/bills → "Life Admin", work → "Career", health/gym → "Health", learning → "Growth", else → "Personal"
- dueDate: YYYY-MM-DD only, or null
- projectId: exact id from list above, or null

Respond ONLY with a JSON array, no markdown:
[{"title":"...","focusArea":"...","dueDate":null,"projectId":null,"notes":null}]`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!claudeRes.ok) {
    console.error('Claude error:', await claudeRes.text());
    return [];
  }

  const claudeData = await claudeRes.json();
  const raw = claudeData.content?.[0]?.text?.trim() || '';
  const validIds = projects.map(p => p.id);

  try {
    const clean  = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    const arr    = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(t => sanitiseTask(t, validIds)).filter(Boolean);
  } catch {
    console.warn('Primary parse failed, attempting salvage. Raw:', raw);
    const salvaged = salvageTasks(raw, validIds);
    return salvaged;
  }
}

const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { audio, text, mimeType, projects = [], focusAreas = [] } = req.body;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_KEY    = process.env.OPENAI_API_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  // ── TEXT MODE (command bar — no audio) ───────────────────────────────────────
  if (text && !audio) {
    const transcript = text.trim();
    if (!transcript) return res.json({ transcript: '', tasks: [], fallback: false });

    try {
      const tasks = await interpretWithClaude(transcript, projects, focusAreas, ANTHROPIC_KEY);
      return res.json({ transcript, tasks, fallback: tasks.length === 0 });
    } catch (e) {
      console.error('Text mode Claude exception:', e);
      return res.json({ transcript, tasks: [], fallback: true });
    }
  }

  // ── AUDIO MODE (voice recording) ─────────────────────────────────────────────
  if (!audio) return res.status(400).json({ error: 'No audio or text provided' });
  if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  let transcript = '';
  try {
    const buffer   = Buffer.from(audio, 'base64');
    const ext      = mimeType?.includes('mp4') ? 'mp4' : 'webm';
    const boundary = '----KairoVoiceBoundary' + Date.now();

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType || 'audio/webm'}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    });

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      console.error('Whisper error:', err);
      return res.status(500).json({ error: 'Transcription failed', detail: err });
    }

    transcript = (await whisperRes.json()).text?.trim() || '';
  } catch (e) {
    console.error('Whisper exception:', e);
    return res.status(500).json({ error: 'Transcription exception', detail: e.message });
  }

  if (!transcript) return res.json({ transcript: '', tasks: [], fallback: false });

  try {
    const tasks = await interpretWithClaude(transcript, projects, focusAreas, ANTHROPIC_KEY);
    return res.json({ transcript, tasks, fallback: tasks.length === 0 });
  } catch (e) {
    console.error('Claude exception:', e);
    return res.json({ transcript, tasks: [], fallback: true });
  }
}

handler.config = config;
module.exports = handler;
