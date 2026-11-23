// api/manual-views.js
//
// Lưu số "view phát sinh 7 ngày" NHẬP TAY cho những kênh chưa có đủ dữ liệu
// lịch sử (vd kênh mới thêm, app chưa theo dõi đủ 7 ngày). Ghi vào
// public/data/manual-views.json trên GitHub (qua Contents API, giống
// manage-channels.js) để mọi người mở web đều thấy cùng 1 số liệu.
//
// Cấu trúc file:
//   { "<tab>": { "<channelId>": { "views7d": 12345, "title": "...", "updatedAt": "ISO" } } }
//
// Khi app đã tự tính được số liệu cho kênh (đủ lịch sử 7 ngày), frontend tự
// ưu tiên số tự động - giá trị nhập tay chỉ còn là dự phòng, không cần xoá.
//
// Body (POST JSON):
//   { tab: "EnglishTravel", entries: [{ channelId, title, views7d }] }
//   views7d = số nguyên >= 0 để lưu, hoặc null / "" để xoá giá trị nhập tay của kênh đó.
//
// Biến môi trường: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO (+ GITHUB_REF tuỳ chọn).

const FILE_PATH = "public/data/manual-views.json";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const missing = ["GITHUB_TOKEN", "GITHUB_OWNER", "GITHUB_REPO"].filter((k) => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({
      error: `Server chưa cấu hình đủ biến môi trường: ${missing.join(", ")} (vào Vercel Settings > Environment Variables).`,
    });
  }
  const { GITHUB_TOKEN: token, GITHUB_OWNER: owner, GITHUB_REPO: repo } = process.env;
  const ref = process.env.GITHUB_REF || "main";

  const body = typeof req.body === "string" ? safeJsonParse(req.body) : req.body || {};
  const tab = typeof body.tab === "string" ? body.tab.trim() : "";
  const entries = Array.isArray(body.entries) ? body.entries : null;
  if (!tab) return res.status(400).json({ error: "Thiếu tên tab." });
  if (!entries || entries.length === 0) return res.status(400).json({ error: "Không có số liệu nào để lưu." });
  if (entries.length > 500) return res.status(400).json({ error: "Quá nhiều kênh trong 1 lần lưu." });

  const clean = [];
  for (const e of entries) {
    const channelId = typeof e?.channelId === "string" ? e.channelId.trim() : "";
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(channelId)) {
      return res.status(400).json({ error: `channelId không hợp lệ: ${String(e?.channelId).slice(0, 60)}` });
    }
    let views7d = null;
    if (e.views7d !== null && e.views7d !== undefined && e.views7d !== "") {
      views7d = Number(e.views7d);
      if (!Number.isFinite(views7d) || views7d < 0 || views7d > 1e12) {
        return res.status(400).json({ error: `Số view không hợp lệ cho kênh ${channelId}.` });
      }
      views7d = Math.round(views7d);
    }
    clean.push({ channelId, title: typeof e.title === "string" ? e.title.slice(0, 200) : "", views7d });
  }

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${FILE_PATH}`;

  // Thử lại khi bị xung đột sha (có người/ workflow vừa ghi file cùng lúc).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let current = {};
      let sha;
      const getRes = await fetch(`${url}?ref=${ref}`, { headers: ghHeaders });
      if (getRes.ok) {
        const file = await getRes.json();
        sha = file.sha;
        try {
          current = JSON.parse(Buffer.from(file.content || "", "base64").toString("utf-8")) || {};
        } catch {
          current = {};
        }
      } else if (getRes.status !== 404) {
        const t = await getRes.text();
        return res.status(502).json({ error: `Không đọc được ${FILE_PATH} (HTTP ${getRes.status}): ${t.slice(0, 300)}` });
      }

      if (typeof current !== "object" || Array.isArray(current)) current = {};
      const tabData = current[tab] && typeof current[tab] === "object" ? current[tab] : {};
      const now = new Date().toISOString();
      for (const e of clean) {
        if (e.views7d === null) delete tabData[e.channelId];
        else tabData[e.channelId] = { views7d: e.views7d, title: e.title, updatedAt: now };
      }
      if (Object.keys(tabData).length) current[tab] = tabData;
      else delete current[tab];

      const putRes = await fetch(url, {
        method: "PUT",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `chore: cập nhật view 7 ngày nhập tay (tab "${tab}") qua web`,
          content: Buffer.from(JSON.stringify(current, null, 2) + "\n", "utf-8").toString("base64"),
          branch: ref,
          ...(sha ? { sha } : {}),
        }),
      });
      if (putRes.ok) return res.status(200).json({ ok: true, manualViews: current });
      if (putRes.status === 409 || putRes.status === 422) continue; // sha cũ - đọc lại rồi thử lại
      const t = await putRes.text();
      return res.status(502).json({ error: `Không ghi được ${FILE_PATH} (HTTP ${putRes.status}): ${t.slice(0, 300)}` });
    } catch (err) {
      return res.status(500).json({ error: `Lỗi: ${err.message}` });
    }
  }
  return res.status(409).json({ error: "File đang được cập nhật ở nơi khác, thử lại sau vài giây." });
};

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
