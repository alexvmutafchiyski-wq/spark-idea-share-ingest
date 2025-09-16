// Suggest 2–3 claims for an article (MVP: works with or without AI).
// Auth: requires ?key=<MOD_KEY> (same key you use for the Admin page).

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  try {
    // allow GET or POST; read params
    const url = new URL(req.url, `http://${req.headers.host}`);
    const key = (url.searchParams.get('key') || '').trim();
    const articleId = (url.searchParams.get('articleId') || '').trim();

    if (!key || !articleId) {
      return res.status(400).json({ error: 'Missing key or articleId' });
    }

    // server-side validate the MOD key against admin_config
    const { data: cfg, error: cfgErr } = await supabase
      .from('admin_config')
      .select('mod_key')
      .limit(1).single();
    if (cfgErr || !cfg || cfg.mod_key !== key) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // load the article
    const { data: article, error: artErr } = await supabase
      .from('articles')
      .select('id, headline, ai_summary, url, outlet')
      .eq('id', articleId)
      .single();

    if (artErr || !article) return res.status(404).json({ error: 'Article not found' });

    // If you have an LLM key set, call AI; else fall back to a mock from ai_summary.
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
    let suggestions = [];

    if (OPENAI_API_KEY) {
      // --- AI path (simple JSON extraction prompt) ---
      const prompt = [
        { role: 'system', content: 'You extract concise factual claims from news content and label each claim verdict.' },
        { role: 'user', content:
`From this article, propose up to 3 concise claims and a verdict for each.
Allowed verdicts: "supported","partial","not_supported","unverifiable".
Return only JSON array: [{"claim_text":"","verdict":"","evidence_url":""?}]

Headline: ${article.headline}
Summary: ${article.ai_summary || '(none)'}
URL: ${article.url}` }
      ];

      // Using fetch so we avoid extra SDKs; adjust model via env if you like.
      const model = process.env.LLM_MODEL || 'gpt-4o-mini';
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: prompt, temperature: 0.2 })
      });

      if (!resp.ok) {
        const t = await resp.text();
        return res.status(502).json({ error: 'LLM error', detail: t });
      }

      const json = await resp.json();
      const text = json?.choices?.[0]?.message?.content || '[]';
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) suggestions = parsed.slice(0, 3);
      } catch {
        // if model returned prose, try ultra-simple fallback
        suggestions = [];
      }
    }

    // Fallback: extract 2 short "claims" from ai_summary sentences
    if (!suggestions.length) {
      const s = (article.ai_summary || '').split(/[.!?]\s+/).filter(Boolean).slice(0, 3);
      suggestions = s.map(line => ({
        claim_text: line.slice(0, 200),
        verdict: 'unverifiable',
        evidence_url: ''
      }));
    }

    // Clamp verdicts to allowed values
    const allowed = new Set(['supported','partial','not_supported','unverifiable']);
    suggestions = suggestions
      .map(c => ({
        claim_text: (c.claim_text || '').toString().slice(0, 300),
        verdict: allowed.has((c.verdict || '').toLowerCase()) ? (c.verdict || '').toLowerCase() : 'unverifiable',
        evidence_url: c.evidence_url || ''
      }))
      .filter(c => c.claim_text);

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ article_id: article.id, suggestions });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'suggest-claims failed' });
  }
}
