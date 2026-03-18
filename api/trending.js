import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    const count = Number(req.query.count) || 20;

    // TikTok トレンドページを取得
    const html = await fetch("https://www.tiktok.com/foryou").then(r => r.text());

    // HTML 内の SIGI_STATE を抽出
    const match = html.match(/<script id="SIGI_STATE" type="application\/json">(.+?)<\/script>/);

    if (!match) {
      return res.status(500).json({ error: "Failed to extract SIGI_STATE" });
    }

    const data = JSON.parse(match[1]);

    // トレンド動画リストを取得
    const videoList = Object.values(data.ItemModule || {}).slice(0, count);

    const items = videoList.map(item => ({
      id: item.id,
      title: item.desc,
      video_url: item.video?.playAddr,
      cover: item.video?.cover,
      author_name: item.author,
      like_count: item.stats?.diggCount,
      comment_count: item.stats?.commentCount,
      share_count: item.stats?.shareCount
    }));

    res.status(200).json({
      count: items.length,
      items
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scraping failed" });
  }
}
