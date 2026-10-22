// Talks to Claude.
//  - As a Claude artifact: through the `sample` capability, on your own Claude plan (no API key, no token billing).
//  - Anywhere else: through the Anthropic API with an API key from Settings (optional fallback).
import * as store from './store.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_MODELS = { complex: 'claude-opus-5-5', default: 'claude-sonnet-5-5', quick: 'claude-haiku-5-5' };
// The sample capability caps one request at 256 KiB; stay well under it.
const MAX_INPUT_BYTES = 200000;

export const DEFAULT_SETTINGS = { profile: '', tutorTier: 'complex', toolTier: 'default', apiKey: '' };

let samplePromise = null;
function getSample() {
  if (!samplePromise) samplePromise = window.claude?.use ? window.claude.use('sample').catch(() => null) : Promise.resolve(null);
  return samplePromise;
}

export async function mode() {
  return (await getSample()) ? 'plan' : 'api';
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await store.kvGet('settings')) || {}) };
}

export async function saveSettings(s) {
  await store.kvSet('settings', s);
}

/* ---------- errors ---------- */

const SAMPLE_COPY = {
  not_granted: 'Lyceum needs your permission to use Claude. Reload the page and choose Allow when asked.',
  sampling_disabled: 'Claude is not available for this account right now.',
  rate_limited: "You've hit a usage limit on your Claude plan, or sent requests too quickly. Wait a little, then try again.",
  session_expired: 'Your Claude session expired. Sign in again, then reload this page.',
  refused: 'Claude declined that request. Try rephrasing it.',
  empty_completion: 'Claude returned an empty answer. Try again.',
  invalid_json: 'Claude returned something Lyceum could not read. Try again.',
  prompt_too_large: 'This lesson has grown too long to send in one go. Start the next lesson, or generate notes to wrap this one up.',
  upstream_error: 'The connection to Claude dropped. Try again.',
};

function toError(e) {
  if (e instanceof Error) return e;
  if (e && typeof e === 'object' && e.code) {
    const err = new Error(SAMPLE_COPY[e.code] || e.message || 'Something went wrong talking to Claude.');
    err.code = e.code;
    err.partial = e.text;
    if (e.code === 'cancelled') err.name = 'AbortError';
    return err;
  }
  return new Error(String(e));
}

/* ---------- input shaping ---------- */

const bytes = (s) => new Blob([s]).size;

function normalize(turns) {
  const out = [];
  for (const t of turns) {
    if (!t.content || !t.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += '\n\n' + t.content;
    else out.push({ role: t.role, content: t.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// Keep the opening turn and as many recent turns as fit the size budget.
function fit(turns, budget) {
  if (!turns.length) return turns;
  let total = turns.reduce((n, t) => n + bytes(t.content), 0);
  const kept = [...turns];
  while (total > budget && kept.length > 3) {
    const [removed] = kept.splice(1, 1);
    total -= bytes(removed.content);
  }
  if (kept.length > 1 && kept[1].role === 'assistant') {
    kept.splice(1, 0, { role: 'user', content: '(Earlier parts of this lesson were trimmed for length.)' });
  }
  return kept;
}

/* ---------- public calls ---------- */

// Streaming chat. `instructions` become the opening turn; `turns` are [{role, content}] ending with the student.
export async function chat({ instructions, turns, tier, onText, signal, maxTokens = 4096 }) {
  const s = await getSettings();
  tier ||= s.tutorTier;
  const sample = await getSample();
  if (sample) {
    const head = { role: 'user', content: `INSTRUCTIONS FOR THIS TUTORING SESSION (from the Lyceum app; follow them throughout):\n\n${instructions}` };
    const input = normalize(fit([head, ...turns], MAX_INPUT_BYTES));
    try {
      const r = await sample(input, { modelTier: tier, signal, cache: false, onText: onText ? ({ text }) => onText(text) : undefined });
      return r.text;
    } catch (e) {
      throw toError(e);
    }
  }
  return apiStream({ system: instructions, messages: normalize(turns), model: API_MODELS[tier], onText, signal, maxTokens, apiKey: s.apiKey });
}

// One-shot text (notes, recaps). Streams if onText is given.
export async function write({ instructions, prompt, tier, onText, signal, maxTokens = 6000 }) {
  const s = await getSettings();
  tier ||= s.toolTier;
  const sample = await getSample();
  if (sample) {
    try {
      const r = await sample(`${instructions}\n\n---\n\n${prompt}`, { modelTier: tier, signal, cache: false, onText: onText ? ({ text }) => onText(text) : undefined });
      return r.text;
    } catch (e) {
      throw toError(e);
    }
  }
  return apiStream({ system: instructions, messages: [{ role: 'user', content: prompt }], model: API_MODELS[tier], onText, signal, maxTokens, apiKey: s.apiKey });
}

// Structured output. `schema` is a JSON Schema object; resolves to the parsed value.
export async function json({ instructions, prompt, schema, tier, signal, maxTokens = 12000 }) {
  const s = await getSettings();
  tier ||= s.toolTier;
  const sample = await getSample();
  if (sample) {
    const input = `${instructions}\n\n---\n\n${prompt}\n\n---\n\nReply with ONLY one JSON object (no prose, no code fence) that matches this JSON Schema:\n${JSON.stringify(schema)}`;
    try {
      const out = await sample.json(input, { modelTier: tier, signal, cache: false });
      if (!out || typeof out !== 'object') throw new Error('Claude returned something Lyceum could not read. Try again.');
      return out;
    } catch (e) {
      throw toError(e);
    }
  }
  return apiTool({ system: instructions, prompt, schema, model: API_MODELS[tier], signal, maxTokens, apiKey: s.apiKey });
}

/* ---------- Anthropic API fallback (only used outside Claude) ---------- */

function apiHeaders(key) {
  if (!key) throw new Error('Open Lyceum inside Claude to use your Claude plan, or add an Anthropic API key in Settings.');
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

async function apiCheck(res) {
  if (res.ok) return;
  let msg = `${res.status} ${res.statusText}`;
  try { msg = (await res.json()).error?.message || msg; } catch {}
  if (res.status === 401) msg = `Your API key was rejected. Check it in Settings. (${msg})`;
  throw new Error(msg);
}

async function apiStream({ system, messages, model, onText, signal, maxTokens, apiKey }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    signal,
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, stream: true }),
  });
  await apiCheck(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          full += ev.delta.text;
          onText && onText(full);
        } else if (ev.type === 'error') throw new Error(ev.error?.message || 'The response stream failed.');
      }
    }
  }
  return full;
}

async function apiTool({ system, prompt, schema, model, signal, maxTokens, apiKey }) {
  const tool = { name: 'respond', description: 'Return the requested data.', input_schema: schema };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    signal,
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }], tools: [tool], tool_choice: { type: 'tool', name: 'respond' } }),
  });
  await apiCheck(res);
  const j = await res.json();
  if (j.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try again.');
  const block = (j.content || []).find((c) => c.type === 'tool_use');
  if (!block) throw new Error('Claude did not return the expected structure. Try again.');
  return block.input;
}
