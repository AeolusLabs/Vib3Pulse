import type { Express, Request, Response, NextFunction } from "express";
import { storage } from "./storage";

// Known link-unfurling crawlers — everything else (real browsers) falls
// through to the normal SPA shell via next().
const CRAWLER_UA_PATTERN =
  /WhatsApp|facebookexternalhit|Facebot|Twitterbot|Slackbot|LinkedInBot|TelegramBot|Discordbot|Pinterest|SkypeUriPreview|redditbot|Googlebot|bingbot/i;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderOgPage(opts: { url: string; title: string; description: string; image?: string | null }): string {
  const { url, title, description, image } = opts;
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeImage = image ? escapeHtml(image) : null;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<meta property="og:type" content="article">
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDescription}">
<meta property="og:url" content="${escapeHtml(url)}">
${safeImage ? `<meta property="og:image" content="${safeImage}">` : ""}
<meta name="twitter:card" content="${safeImage ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${safeTitle}">
<meta name="twitter:description" content="${safeDescription}">
${safeImage ? `<meta name="twitter:image" content="${safeImage}">` : ""}
</head>
<body>
<p>${safeDescription}</p>
</body>
</html>`;
}

// A client-only SPA shares as a bare/ugly link in WhatsApp/iMessage/Slack —
// no title, no image, just a URL. Real browsers still get the normal client
// app; only recognized crawler user-agents get this server-rendered stand-in.
export function registerOgRoutes(app: Express) {
  app.get("/posts/:id", async (req: Request, res: Response, next: NextFunction) => {
    const userAgent = req.get("user-agent") || "";
    if (!CRAWLER_UA_PATTERN.test(userAgent)) return next();

    try {
      const post = await storage.getPost(req.params.id);
      const appUrl = (process.env.APP_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
      const url = `${appUrl}/posts/${req.params.id}`;

      if (!post || post.moderationStatus !== "approved") {
        res.status(post ? 404 : 404).send(renderOgPage({
          url,
          title: "Vib3Pulse",
          description: "This post isn't available.",
        }));
        return;
      }

      const author = await storage.getUser(post.userId);
      const authorName = author?.displayName || (author as any)?.organizationName || author?.username || "Someone";
      const image = post.imageUrls?.[0] || post.imageUrl || null;

      res.send(renderOgPage({
        url,
        title: `${authorName} on Vib3Pulse`,
        description: post.content.slice(0, 200),
        image,
      }));
    } catch (error) {
      next();
    }
  });
}
