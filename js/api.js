// Calls the Anthropic Messages API directly from the browser with the user's own key.
import { kvGet } from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (deepest, costs most)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (strong, balanced)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fast, cheapest)' },
];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  tutorModel: 'claude-opus-5-5',
  utilityModel: 'claude-sonnet-5-5',
  profile: '',
  vaultPath: '00 Notes/Courses',
};

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await kvGet('settings')) || {}) };
}

function headers(key) {
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

async function requireKey() {
  const s = await getSettings();
  if (!s.apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  return s;
}

async function check(res) {
  if (res.ok) return;
  let msg = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    msg = j.error?.message || msg;
  } catch {}
  if (res.status === 401) msg = `Your API key was rejected. Check it in Settings. (${msg})`;
  if (res.status === 429) msg = `Rate limited by the API. Wait a moment and try again. (${msg})`;
  if (res.status === 529) msg = `Claude is overloaded right now. Try again in a minute.`;
  throw new Error(msg);
}

// Merge consecutive same-role messages and make sure the list starts with a user turn.
export function normalizeMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    if (!m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export async function streamText({ system, messages, model, maxTokens = 4096, onText, signal }) {
  const s = await requireKey();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: headers(s.apiKey),
    signal,
    body: JSON.stringify({
      model: model || s.tutorModel,
      max_tokens: maxTokens,
      system,
      messages: normalizeMessages(messages),
      stream: true,
    }),
  });
  await check(res);
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
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          full += ev.delta.text;
          onText && onText(full);
        } else if (ev.type === 'error') {
          throw new Error(ev.error?.message || 'The response stream failed.');
        }
      }
    }
  }
  return full;
}

// Forces the model to answer through a single tool so we get clean JSON back.
export async function callTool({ system, messages, tool, model, maxTokens = 8000, signal }) {
  const s = await requireKey();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: headers(s.apiKey),
    signal,
    body: JSON.stringify({
      model: model || s.utilityModel,
      max_tokens: maxTokens,
      system,
      messages: normalizeMessages(messages),
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    }),
  });
  await check(res);
  const j = await res.json();
  if (j.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try again.');
  const block = (j.content || []).find((c) => c.type === 'tool_use');
  if (!block) throw new Error('Claude did not return the expected structure. Try again.');
  return block.input;
}

export async function completeText({ system, messages, model, maxTokens = 6000, signal }) {
  return streamText({ system, messages, model: model || (await getSettings()).utilityModel, maxTokens, signal });
}
