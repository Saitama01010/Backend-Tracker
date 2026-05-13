import { Router } from "express";

const router = Router();

// Allowlisted Google Sheets CSV export URLs that can be proxied.
// Only IDP tab is proxied here — browser fetches of this tab silently fail
// when another tab from the same spreadsheet is fetched concurrently.
const ALLOWED_URLS = new Set([
  "https://docs.google.com/spreadsheets/d/11kOhk8xBPywxsAoULxS1b2QlofV7Le8ubawPoG7TZdc/export?format=csv&gid=871007220",
]);

router.get("/csv-proxy", async (req, res) => {
  const url = req.query.url as string;
  if (!url || !ALLOWED_URLS.has(url)) {
    res.status(400).json({ error: "URL not in allowlist" });
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
    });
    if (!upstream.ok) {
      req.log.warn({ status: upstream.status }, "csv-proxy upstream error");
      res.status(502).json({ error: `Upstream HTTP ${upstream.status}` });
      return;
    }
    const text = await upstream.text();
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Cache-Control", "no-cache, no-store, max-age=0");
    res.send(text);
  } catch (err) {
    req.log.error({ err }, "csv-proxy fetch failed");
    res.status(502).json({ error: "Fetch failed" });
  }
});

export default router;
