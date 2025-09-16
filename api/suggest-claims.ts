// api/suggest-claims.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''; // optional

// tiny helpers
const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const key = String(req.query.key || '');
    const articleId = String(req.query.articleId || '');
    if (!key) return res.status(400).json({ error: 'Missing key' });
    if (!isUUID(articleId)) return res.status(400).json({ error: 'articleId must be a UUID' });

    // 1) Validate MOD key against admin_config
    const adminCfg = await fetch(`${SUPABASE_URL}/rest/v1/admin_config?select=mod_key`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      },
    }).then(r => r.json());
    const modKey = adminCfg?.[0]?.mod_key;
    if (!modKey || modKey !== key) return res.status(401).json({ error: 'Unauthorized' });

    // 2) Load article text (headline + ai_summary or full text if you have it)
    const articleRows = await fetch(
      `${SUPABASE_URL}/rest/v1/articles?id=eq.${articleId}&select=headline,ai_summary,outlet,url`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` } }
    ).then(r => r.json());

    const article = articleRows?.[0];
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const context =
      `Outlet: ${article.outlet || 'n/a'}\nHeadline: ${article.headline || 'n/a'}\nURL: ${article.url || 'n/a'}\nSummary: ${article.ai_summary || 'n/a'}`;

    // 3) Produce suggestions
    let suggestions: Array<{ text: string; verdict: string; evidence?: string }> = [];

    if (OPENAI_API_KEY) {
      // LLM path (OpenAI Chat Completions)
      const prompt = `
Extract 2-3 concise factual claims from the article context below. 
Output JSON only, with shape:
{"suggestions":[{"text":"...", "verdict":"supported|partial|not_supported|unverifiable", "evidence":""}]}

Context:
${context}
`;

      const ai = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini', // or another chat-capable model you have access to
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
        }),
      }).then(r => r.json());

      // try to parse JSON from the assistant message
      const content = ai?.choices?.[0]?.message?.content || '';
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed?.suggestions)) suggestions = parsed.suggestions;
      } catch {
        // fallback parse (if model returned markdown fenced code)
        const m = content.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          if (Array.isArray(parsed?.suggestions)) suggestions = parsed.suggestions;
        }
      }
    }

    // 4) Fallback if no OPENAI_API_KEY or parsing failed
    if (!suggestions.length) {
      // simple heuristic: propose generic checks from headline/summary
      suggestions = [
        { text: `Твърдението в заглавието: "${article.headline}" е коректно?`, verdict: 'unverifiable' },
        { text: 'Претендираните числа/проценти са подкрепени с официални източници?', verdict: 'partial' },
      ];
    }

    // Validate shape minimally
    suggestions = suggestions
      .map(s => ({
        text: String(s.text || '').slice(0, 300),
        verdict: (s.verdict || 'unverifiable').toLowerCase(),
        evidence: s.evidence ? String(s.evidence).slice(0, 400) : '',
      }))
      .filter(s => s.text);

    return res.status(200).json({ suggestions });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: 'suggest-claims failed', detail: String(e?.message || e) });
  }
}
