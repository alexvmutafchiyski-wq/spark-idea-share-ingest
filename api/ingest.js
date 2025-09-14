import Parser from "rss-parser";
import { createClient } from "@supabase/supabase-js";
const parser = new Parser();

export default async function handler(req, res) {
  try {
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if ((req.headers.authorization || "") !== expected)
      return res.status(401).json({ error: "Unauthorized" });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE, { auth: { persistSession:false }});
    const feeds = (process.env.RSS_FEEDS || "").split(",").map(s=>s.trim()).filter(Boolean);

    let scanned = 0, inserted = 0;
    for (const feedUrl of feeds) {
      const feed = await parser.parseURL(feedUrl);
      const outlet = (feed.title || "unknown").trim();
      for (const item of (feed.items||[]).slice(0,30)) {
        scanned++;
        const url = item.link || item.guid; if (!url) continue;
        const headline = item.title || "(no title)";
        const ai_summary = (item.contentSnippet || item.content || "")?.slice(0,600) || null;
        const trust_score = 40 + Math.floor(Math.random()*41);
        const { error } = await supabase.from("articles").upsert([{
          url, headline, outlet, ai_summary, trust_score, publish_ok:true
        }], { onConflict:"url" });
        if (!error) inserted++;
      }
    }
    res.status(200).json({ ok:true, scanned, inserted });
  } catch (e) {
    res.status(500).json({ error: e?.message || "ingest failed" });
  }
}
