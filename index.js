const express = require("express");
const TikTokScraper = require("tiktok-scraper");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/trending", async (req, res) => {
  try {
    const count = Number(req.query.count) || 50;

    // TikTok のトレンド動画をスクレイピング
    const posts = await TikTokScraper.trend("", {
      number: count,
      sessionList: [],
      proxy: "",
      by_user_id: false
    });

    const items = posts.collector.map((item) => ({
      id: item.id,
      title: item.text,
      video_url: item.videoUrl,
      cover: item.covers.default,
      author_name: item.authorMeta.name,
      author_id: item.authorMeta.id,
      like_count: item.diggCount,
      comment_count: item.commentCount,
      share_count: item.shareCount
    }));

    res.json({
      count: items.length,
      items
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Failed to fetch TikTok trending videos" });
  }
});

app.get("/", (req, res) => {
  res.json({
    message: "TikTok Trending Scraper API",
    example: "/trending?count=50"
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
