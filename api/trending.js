import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    const count = Number(req.query.count) || 20;

    // TikTok トレンドページを取得
    const html = await fetch("https://www.tiktok.com/foryou").then(r => r.text());

    // HTML 内の __NEXT_DATA__ を抽出
    const jsonMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/);

    if (!jsonMatch) {
      return res.status(500).json({ error: "Failed to extract TikTok data" });
    }

    const data = JSON.parse(jsonMatch[1]);

    // 埋め込まれている動画データを抽出
    const items =
      data?.props?.pageProps?.items?.slice(0, count).map(item => ({
        id: item.id,
        title: item.desc,
        video_url: item.video?.playAddr,
        cover: item.video?.cover,
        author_name: item.author?.nickname,
        author_id: item.author?.id,
        like_count: item.stats?.diggCount,
        comment_count: item.stats?.commentCount,
        share_count: item.stats?.shareCount
      })) || [];

    res.status(200).json({
      count: items.length,
      items
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scraping failed" });
  }
}
