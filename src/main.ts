import { ModAction } from "@devvit/protos";
import {
  Comment,
  Devvit,
  JobContext,
  Post,
  ScheduledJobEvent,
  SettingsFormFieldValidatorEvent,
  Subreddit,
  TriggerContext,
} from "@devvit/public-api";

const MINIMUM_DELAY = 3;
const RELAY_SCHEDULED_JOB = "relay";
const FRONT_PAGE_CHECK_SCHEDULED_JOB = "check-front-page";

Devvit.configure({
  http: true,
  redditAPI: true,
  redis: true,
});

function isRemoved(target: Comment | Post) {
  console.log(`isRemoved attrs ${JSON.stringify(target, null, 2)}`);
  return (
    target.spam ||
    target.removed ||
    // @ts-ignore
    target.removedByCategory === "automod_filtered" ||
    // @ts-ignore
    target.bannedBy === "AutoModerator" ||
    // @ts-ignore
    target.bannedBy?.toString() === "true" ||
    // @ts-ignore
    target.removalReason === "legal"
  );
}

async function isShadowBanned(
  _context: TriggerContext,
  target: Comment | Post
) {
  const authorName = await target.getAuthorName();
  if (!authorName || authorName === "[deleted]") {
    return true;
  }

  return false;
}

function truncateText(text: string | undefined, maxLength: number): string {
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength - 1) + "…";
}

function renderTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    return (variables as any)[key] ?? "";
  });
}

function decodeUrl(u: string | undefined): string | undefined {
  return u ? String(u).replace(/&amp;/g, "&") : undefined;
}

function looksLikeImage(url: string | undefined): boolean {
  if (!url) return false;
  return (
    /i\.redd\.it|preview\.redd\.it|i\.imgur\.com/.test(url) ||
    /\.(png|jpe?g|gif|webp)$/i.test(url)
  );
}

function getImageUrlFromRedditPostJson(data: any): string | undefined {
  if (!data) return undefined;

  // Common fields (both Devvit Post + raw JSON)
  const urlOver: string | undefined =
    data.url_overridden_by_dest ?? data.urlOverriddenByDest;
  const baseUrl: string | undefined = data.url;
  const previewImage: string | undefined =
    data.preview?.images?.[0]?.source?.url;

  const selftext: string = data.selftext || "";
  const mediaMeta: any =
    data.media_metadata ?? data.mediaMetadata ?? undefined;
  const galleryData: any = data.gallery_data ?? data.galleryData ?? undefined;

  // --- Devvit Post shape helpers -------------------------------------
  const hasDevvitGallery =
    Array.isArray(data.galleryImages) && data.galleryImages.length > 0;
  const hasDevvitMedia =
    Array.isArray(data.mediaUrls) && data.mediaUrls.length > 0;

  const isGalleryPost =
    data.isGallery === true ||
    data.type === "gallery" ||
    data.is_gallery === true; // raw JSON fallback

  const isTextWithInlineImage =
    (data.isSelf === true || data.is_self === true) &&
    !isGalleryPost &&
    (!!mediaMeta || hasDevvitMedia);

  const galleryImages: string[] = [];
  const mediaUrls: string[] = [];

  // --- 1) Devvit gallery posts (preferred) ---------------------------
  if (isGalleryPost && hasDevvitGallery) {
    for (let u of data.galleryImages as string[]) {
      u = decodeUrl(u);
      if (u && looksLikeImage(u)) galleryImages.push(u);
    }

    if (galleryImages.length > 0) {
      const imageUrl = galleryImages[0];
      console.log("Gallery post image chosen (Devvit)", {
        imageUrl,
        galleryImages,
      });
      return imageUrl;
    }
  }

  // --- 2) Devvit text-with-image posts (preferred) -------------------
  if (isTextWithInlineImage && hasDevvitMedia) {
    for (let u of data.mediaUrls as string[]) {
      u = decodeUrl(u);
      if (u && looksLikeImage(u)) mediaUrls.push(u);
    }

    if (mediaUrls.length > 0) {
      const imageUrl = mediaUrls[0];
      console.log("Text post inline image chosen (Devvit)", {
        imageUrl,
        mediaUrls,
      });
      return imageUrl;
    }
  }

  // --- 3) Raw JSON gallery fallback (if you ever pass raw data) ------
  if (!hasDevvitGallery && galleryData && mediaMeta && Array.isArray(galleryData.items)) {
    for (const item of galleryData.items) {
      const mid = item.media_id ?? item.mediaId ?? item.id;
      if (!mid) continue;
      const md = mediaMeta[mid];
      if (!md) continue;

      const src = md.s || md.source || {};
      let u: string | undefined =
        src.u ||
        src.url ||
        (Array.isArray(md.p) && md.p.length
          ? md.p[md.p.length - 1].u || md.p[md.p.length - 1].url
          : undefined);

      u = decodeUrl(u);
      if (u && looksLikeImage(u)) {
        galleryImages.push(u);
      }
    }

    if (galleryImages.length > 0) {
      const imageUrl = galleryImages[0];
      console.log("Gallery post image chosen (raw JSON)", {
        imageUrl,
        galleryImages,
      });
      return imageUrl;
    }
  }

  // --- 4) Raw JSON-style inline media fallback -----------------------
  if (!hasDevvitMedia && mediaMeta && typeof mediaMeta === "object") {
    for (const key of Object.keys(mediaMeta)) {
      const md = mediaMeta[key];
      if (!md) continue;

      const src = md.s || md.source || {};
      let u: string | undefined =
        src.u ||
        src.url ||
        (Array.isArray(md.p) && md.p.length
          ? md.p[md.p.length - 1].u || md.p[md.p.length - 1].url
          : undefined);

      u = decodeUrl(u);
      if (u && looksLikeImage(u)) {
        mediaUrls.push(u);
      }
    }
  }

  if (!hasDevvitMedia && selftext) {
    const matches = selftext.match(/https?:\/\/\S+/g) || [];
    for (let candidate of matches) {
      candidate = candidate.replace(/[)\]]$/, "");
      const decoded = decodeUrl(candidate);
      if (decoded && looksLikeImage(decoded) && !mediaUrls.includes(decoded)) {
        mediaUrls.push(decoded);
      }
    }
  }

  if (mediaUrls.length > 0) {
    const imageUrl = mediaUrls[0];
    console.log("Text post inline image chosen (raw JSON)", {
      imageUrl,
      mediaUrls,
    });
    return imageUrl;
  }

  // --- 5) Single-image / generic fallback (your original logic) ------
  let imageUrl: string | undefined;

  if (looksLikeImage(urlOver)) {
    imageUrl = decodeUrl(urlOver);
  } else if (looksLikeImage(previewImage)) {
    imageUrl = decodeUrl(previewImage);
  } else if (looksLikeImage(baseUrl)) {
    imageUrl = decodeUrl(baseUrl);
  }

  console.log("Image candidates", {
    isGalleryPost,
    isTextWithInlineImage,
    hasDevvitGallery,
    hasDevvitMedia,
    urlOver,
    baseUrl,
    previewImage,
    galleryImages,
    mediaUrls,
    final: imageUrl,
  });

  return imageUrl;
}

function getImageUrlsFromRedditPostJson(data: any): string[] | undefined {
  if (!data) return undefined;

  // Common fields (both Devvit Post + raw JSON)
  const urlOver: string | undefined =
    data.url_overridden_by_dest ?? data.urlOverriddenByDest;
  const baseUrl: string | undefined = data.url;
  const previewImage: string | undefined =
    data.preview?.images?.[0]?.source?.url;

  const selftext: string = data.selftext || "";
  const mediaMeta: any =
    data.media_metadata ?? data.mediaMetadata ?? undefined;
  const galleryData: any = data.gallery_data ?? data.galleryData ?? undefined;

  // --- Devvit Post shape helpers -------------------------------------
  const hasDevvitGallery =
    Array.isArray(data.galleryImages) && data.galleryImages.length > 0;
  const hasDevvitMedia =
    Array.isArray(data.mediaUrls) && data.mediaUrls.length > 0;

  const isGalleryPost =
    data.isGallery === true ||
    data.type === "gallery" ||
    data.is_gallery === true; // raw JSON fallback

  const isTextWithInlineImage =
    (data.isSelf === true || data.is_self === true) &&
    !isGalleryPost &&
    (!!mediaMeta || hasDevvitMedia);

  const galleryImages: string[] = [];
  const mediaUrls: string[] = [];

  // --- 1) Devvit gallery posts (preferred) ---------------------------
  if (isGalleryPost && hasDevvitGallery) {
    for (let u of data.galleryImages as string[]) {
      u = decodeUrl(u);
      if (u && looksLikeImage(u)) galleryImages.push(u);
    }

    if (galleryImages.length > 0) {
      const imageUrl = galleryImages[0];
      console.log("Gallery post imags (Devvit)", {
        galleryImages,
      });
      return galleryImages;
    }
  }

  // --- 2) Devvit text-with-image posts (preferred) -------------------
  if (isTextWithInlineImage && hasDevvitMedia) {
    for (let u of data.mediaUrls as string[]) {
      u = decodeUrl(u);
      if (u && looksLikeImage(u)) mediaUrls.push(u);
    }

    if (mediaUrls.length > 0) {
      const imageUrl = mediaUrls[0];
      console.log("Text post inline images (Devvit)", {
        mediaUrls,
      });
      return mediaUrls;
    }
  }

  // --- 3) Raw JSON gallery fallback (if you ever pass raw data) ------
  if (!hasDevvitGallery && galleryData && mediaMeta && Array.isArray(galleryData.items)) {
    for (const item of galleryData.items) {
      const mid = item.media_id ?? item.mediaId ?? item.id;
      if (!mid) continue;
      const md = mediaMeta[mid];
      if (!md) continue;

      const src = md.s || md.source || {};
      let u: string | undefined =
        src.u ||
        src.url ||
        (Array.isArray(md.p) && md.p.length
          ? md.p[md.p.length - 1].u || md.p[md.p.length - 1].url
          : undefined);

      u = decodeUrl(u);
      if (u && looksLikeImage(u)) {
        galleryImages.push(u);
      }
    }

    if (galleryImages.length > 0) {
      console.log("Gallery post images (raw JSON)", {
        galleryImages,
      });
      return galleryImages;
    }
  }

  // --- 4) Raw JSON-style inline media fallback -----------------------
  if (!hasDevvitMedia && mediaMeta && typeof mediaMeta === "object") {
    for (const key of Object.keys(mediaMeta)) {
      const md = mediaMeta[key];
      if (!md) continue;

      const src = md.s || md.source || {};
      let u: string | undefined =
        src.u ||
        src.url ||
        (Array.isArray(md.p) && md.p.length
          ? md.p[md.p.length - 1].u || md.p[md.p.length - 1].url
          : undefined);

      u = decodeUrl(u);
      if (u && looksLikeImage(u)) {
        mediaUrls.push(u);
      }
    }
  }

  if (!hasDevvitMedia && selftext) {
    const matches = selftext.match(/https?:\/\/\S+/g) || [];
    for (let candidate of matches) {
      candidate = candidate.replace(/[)\]]$/, "");
      const decoded = decodeUrl(candidate);
      if (decoded && looksLikeImage(decoded) && !mediaUrls.includes(decoded)) {
        mediaUrls.push(decoded);
      }
    }
  }

  if (mediaUrls.length > 0) {
    console.log("Text post inline images (raw JSON)", {
      mediaUrls,
    });
    return mediaUrls;
  }

  // --- 5) Single-image / generic fallback (your original logic) ------
  let imageUrl: string | undefined;

  if (looksLikeImage(urlOver)) {
    imageUrl = decodeUrl(urlOver);
  } else if (looksLikeImage(previewImage)) {
    imageUrl = decodeUrl(previewImage);
  } else if (looksLikeImage(baseUrl)) {
    imageUrl = decodeUrl(baseUrl);
  }

  console.log("Image candidates", {
    isGalleryPost,
    isTextWithInlineImage,
    hasDevvitGallery,
    hasDevvitMedia,
    urlOver,
    baseUrl,
    previewImage,
    galleryImages,
    mediaUrls,
    final: imageUrl,
  });

    if (!imageUrl) return undefined;
  return [imageUrl];
}

function fetchImageUrlForPost(
  _context: TriggerContext,
  post: Post
): Promise<string | undefined> {
  // We already have the full post object; just reuse the same logic
  return (async () => {
    try {
      console.log("Action called! Using Post object directly for image lookup.");

      // `getImageUrlFromRedditPostJson` only cares about certain fields
      // (url, url_overridden_by_dest, preview, media_metadata, gallery_data, selftext)
      // and the Devvit Post object has the same shape for these.
      const data: any = post;

      const imageUrl = getImageUrlFromRedditPostJson(data);

      if (!imageUrl) {
        console.log("No image found from Post data");
      }

      return imageUrl;
    } catch (e) {
      console.log("Error resolving image from Post object", e);
      return undefined;
    }
  })();
}

function fetchImageUrlsForPost(
  _context: TriggerContext,
  post: Post
): Promise<string[] | undefined> {
  // We already have the full post object; just reuse the same logic
  return (async () => {
    try {
      console.log("Action called! Using Post object directly for image lookup.");

      // `getImageUrlFromRedditPostJson` only cares about certain fields
      // (url, url_overridden_by_dest, preview, media_metadata, gallery_data, selftext)
      // and the Devvit Post object has the same shape for these.
      const data: any = post;

      const imageUrls = getImageUrlsFromRedditPostJson(data);

      if (!imageUrls) {
        console.log("No images found from Post data");
      }

      return imageUrls;
    } catch (e) {
      console.log("Error resolving image from Post object", e);
      return undefined;
    }
  })();
}

/** settings – unchanged from previous version **/
Devvit.addSettings([
  {
    label: "Discord Webhook URL",
    name: "webhook-url",
    onValidate: (event) => {
      if (event.value!.length == 0) {
        return "Please enter a webhook URL";
      }
    },
    type: "string",
  },
  {
    label: "Subreddits",
    name: "subreddit-only",
    type: "string",
    helpText:
      "Relay ONLY the content from specific subreddit(s). Separate each item with a comma to include multiple subreddits.",
  },
  {
    type: "group",
    label: "Discord Settings",
    fields: [
      {
        type: "boolean",
        name: "ping-role",
        label: "Ping a Discord role on every relay",
        defaultValue: false,
        helpText:
          "If enabled, the app will ask for the role ID to ping in the settings below.",
      },
      {
        type: "string",
        name: "ping-role-id",
        label: "Discord Role ID to ping",
        helpText:
          "The Discord Role ID to ping on every relay. To obtain this ID, enable Developer Mode in Discord, right-click the role, and click 'Copy ID'.",
      },
      {
        type: "boolean",
        name: "suppress-author-embed",
        label: "Suppress author link in embed",
        defaultValue: false,
        helpText:
          "If enabled, the author's name in the embed will not link to their Reddit profile.",
      },
      {
        type: "boolean",
        name: "suppress-item-embed",
        label: "Suppress Reddit item link in embed title",
        defaultValue: false,
        helpText:
          "If enabled, the embed title will not be a clickable link to the Reddit post/comment.",
      },
    ],
  },
    {
    type: "group",
    label: "Native Embed Post Settings",
    fields: [
      {
        type: "number",
        name: "image-embed-count",
        label: "Max number of images",
        defaultValue: 0,
        helpText: `Set max number of images to show`,
      },
      {
        type: "string",
        name: "post-embed-template",
        label: "Post embed description template",
        helpText:
          'Template for post embed descriptions. Use {title}, {selftext}, {url}, {author}, {subreddit}, {flair}. Leave blank to use default behavior.',
      },
      {
        type: "string",
        name: "comment-embed-template",
        label: "Comment embed description template",
        helpText:
          "Template for comment embed descriptions. Use {body}, {postTitle}, {url}, {author}, {subreddit}. Leave blank to use default behavior.",
      },
    ],
  },
  {
    type: "group",
    label: "Behavior",
    fields: [
      {
        type: "select",
        name: "content-type",
        label: "Content type",
        defaultValue: "all",
        options: [
          {
            label: "Posts and comments",
            value: "all",
          },
          {
            label: "Posts only",
            value: "post",
          },
          {
            label: "Comments only",
            value: "comment",
          },
        ],
      },
      {
        type: "select",
        name: "relay-mode",
        label: "Relay mode (when should the app relay content?)",
        defaultValue: "immediately",
        options: [
          {
            label: "Immediately when content is created",
            value: "immediately",
          },
          {
            label: "When content is on the front page of your subreddit",
            value: "front-page",
          },
        ],
      },
      {
        type: "number",
        name: "post-delay",
        label: "Post delay (in minutes)",
        defaultValue: 0,
        helpText: `If set to 0, the app will relay posts immediately. If greater than 0, the app will delay the relay by the specified number of minutes. Use this to allow time for the Reddit automoderator/safety system to review the content. Please enter at least ${MINIMUM_DELAY} minutes.`,
        onValidate: validateDelay,
      },
      {
        type: "number",
        name: "comment-delay",
        label: "Comment delay (in minutes)",
        defaultValue: 0,
        helpText: `If set to 0, the app will relay comments immediately. If greater than 0, the app will delay the relay by the specified number of minutes. Use this to allow time for the Reddit automoderator/safety system to review the content. Please enter at least ${MINIMUM_DELAY} minutes.`,
        onValidate: validateDelay,
      },
      {
        type: "number",
        name: "post-delay-after-approval",
        label: "Post delay after approval (in minutes)",
        defaultValue: 0,
        helpText: `If a post is approved after being held, delay relay by the specified number of minutes. Please enter at least ${MINIMUM_DELAY} minutes, or 0 to relay immediately after approval.`,
        onValidate: validateDelay,
      },
      {
        type: "number",
        name: "comment-delay-after-approval",
        label: "Comment delay after approval (in minutes)",
        defaultValue: 0,
        helpText: `If a comment is approved after being held, delay relay by the specified number of minutes. Please enter at least ${MINIMUM_DELAY} minutes, or 0 to relay immediately after approval.`,
        onValidate: validateDelay,
      },
      {
        type: "boolean",
        name: "retry-on-approval",
        label: "Retry relay when posts/comments are approved",
      },
      {
        type: "boolean",
        name: "skip-safety-checks",
        label: "Skip waiting for safety checks",
      },
      {
        type: "boolean",
        name: "ignore-removed",
        label: "Ignore items removed by automod/safety checks",
      },
      {
        type: "boolean",
        name: "suppress-submitter",
        label: "Suppress the name of the submitter in the relay message",
      },
      {
        type: "string",
        name: "specific-username",
        label: "Relay only content with specific usernames",
        helpText:
          "Relay ONLY the content from specific username(s). Separate each item with a comma to include multiple users.",
      },
      {
        type: "string",
        name: "user-flair",
        label: "Relay only content from users with specific flair",
        helpText:
          "User flair text to include. Separate each item with a comma to include multiple flairs.",
      },
      {
        type: "string",
        name: "post-flair",
        label: "Relay only posts with specific flair",
        helpText:
          "Post flair text to include. Separate each item with a comma to include multiple flairs.",
      },
      {
        type: "boolean",
        name: "approved-users-only",
        label: "Only relay content from approved users",
      },
      {
        type: "boolean",
        name: "moderators-only",
        label: "Only relay content from moderators",
      },
      {
        type: "string",
        name: "ignore-specific-username",
        label: "Ignore content from specific usernames",
        helpText:
          "Ignore items from specific users. Separate each item with a comma to include multiple users.",
      },
      {
        type: "string",
        name: "ignore-user-flair",
        label: "Ignore content from users with specific flair",
        helpText:
          "User flair text to ignore. Separate each item with a comma to include multiple flairs.",
      },
      {
        type: "string",
        name: "ignore-post-flair",
        label: "Ignore posts with specific flair",
        helpText:
          "Post flair text to ignore. Separate each item with a comma to include multiple flairs.",
      },
      {
        type: "boolean",
        name: "ignore-shadowbanned",
        label: "Ignore content from users who might be shadowbanned",
      },
      {
        type: "boolean",
        name: "relay-replies",
        label: "Only relay replies",
        helpText:
          "If enabled, only relay comments that are replies to other comments, not top-level comments.",
      },
    ],
  },
]);

Devvit.addSchedulerJob({
  name: RELAY_SCHEDULED_JOB,
  onRun: async (event: ScheduledJobEvent<any>, context: JobContext) => {
    const { reddit, settings } = context;
    const { data, itemId, itemType, uniqueId, webhookUrl } = event.data!;

    const item =
      itemType === "post"
        ? await reddit.getPostById(itemId)
        : await reddit.getCommentById(itemId);

    if ((await settings.get("ignore-removed")) && isRemoved(item)) {
      console.log(`Not relaying due to item removed: ${uniqueId}`);
      return;
    }

    console.log(`Relaying event ${uniqueId}`);

    await relay(context as unknown as TriggerContext, item, webhookUrl, data);
  },
});

Devvit.addSchedulerJob({
  name: FRONT_PAGE_CHECK_SCHEDULED_JOB,
  onRun: async (_event: ScheduledJobEvent<any>, context: JobContext) => {
    const { reddit, scheduler } = context;
    const subreddit = await reddit.getCurrentSubreddit();
    const frontPagePosts = await subreddit.getHotPosts({ limit: 50 }).all();

    for (const post of frontPagePosts) {
      const uniqueId = post.id;
      const hasBeenRelayed =
        (await context.redis.hGet(uniqueId, "relayed")) === "true";

      if (!hasBeenRelayed) {
        console.log(
          `Post ${uniqueId} is on front page and has not been relayed. Scheduling relay.`
        );
        await scheduler.runJob<ScheduledJobEvent<any>>({
          name: RELAY_SCHEDULED_JOB,
          data: {
            data: {},
            itemType: "post",
            itemId: post.id,
            uniqueId,
            webhookUrl: (await context.settings.get("webhook-url"))!.toString(),
          },
          runAt: new Date(),
        });
      }
    }
  },
});

Devvit.addTrigger({
  event: "PostCreate",
  onEvent: async (event, context) => {
    const { post, author } = event;
    const { reddit, scheduler, settings } = context;

    console.log("Received PostCreate event", {
      id: post.id,
      authorName: author.name,
      permalink: post.permalink,
    });

    if (!(await shouldRelay(event, context))) {
      console.log("Not relaying PostCreate event due to relay rules.");
      return;
    }

    const relayMode = (await settings.get("relay-mode")) || "immediately";

    if (relayMode === "front-page") {
      console.log(
        "Relay mode is 'front-page', scheduling FRONT_PAGE_CHECK_SCHEDULED_JOB."
      );
      await scheduler.runJob({
        name: FRONT_PAGE_CHECK_SCHEDULED_JOB,
        data: {},
        runAt: new Date(Date.now() + MINIMUM_DELAY * 60 * 1000),
      });
      return;
    }

    const approvalRetry = !!event.approved;
    console.log("Waiting for safety checks");
    if (!(await context.settings.get("skip-safety-checks"))) {
      try {
        await reddit.safeWaitFor(
          () => post,
          { maxAttempts: 10, safeBefore: true },
          (p) => p && !isRemoved(p)
        );
      } catch (e) {
        console.log("Error waiting for safety checks on post:", e);
      }
    }

    console.log("Scheduling relay for post");
    await scheduleRelay(context, post, "post", author.name, approvalRetry);
  },
});

Devvit.addTrigger({
  event: "CommentCreate",
  onEvent: async (event, context) => {
    const { comment, author } = event;
    const { reddit, settings } = context;

    console.log("Received CommentCreate event", {
      id: comment.id,
      authorName: author.name,
      permalink: comment.permalink,
    });

    if (!(await shouldRelay(event, context))) {
      console.log("Not relaying CommentCreate event due to relay rules.");
      return;
    }

    const relayMode = (await settings.get("relay-mode")) || "immediately";

    if (relayMode === "front-page") {
      console.log(
        "Relay mode is 'front-page'; this app only relays posts on front-page, not comments."
      );
      return;
    }

    const approvalRetry = !!event.approved;
    console.log("Waiting for safety checks");
    if (!(await context.settings.get("skip-safety-checks"))) {
      try {
        await reddit.safeWaitFor(
          () => comment,
          { maxAttempts: 10, safeBefore: true },
          (c) => c && !isRemoved(c)
        );
      } catch (e) {
        console.log("Error waiting for safety checks on comment:", e);
      }
    }

    console.log("Scheduling relay for comment");
    await scheduleRelay(context, comment, "comment", author.name, approvalRetry);
  },
});

Devvit.addTrigger({
  event: "ModAction",
  onEvent: async (event, context) => {
    const { action, target, details } = event;
    const { reddit, redis, scheduler, settings } = context;

    console.log("Received ModAction event", {
      action,
      targetFullname: target?.id,
      details,
    });

    const retryOnApproval = await settings.get("retry-on-approval");
    if (!retryOnApproval) {
      console.log(
        "Retry-on-approval is disabled. Ignoring ModAction event for retry."
      );
      return;
    }

    if (!target || (target.type !== "post" && target.type !== "comment")) {
      console.log(
        "ModAction target is not a post or comment. Ignoring ModAction event."
      );
      return;
    }

    const itemId = target.id;
    const itemType = target.type;

    const uniqueId =
      itemType === "post"
        ? itemId
        : `${(target as any).parentId ?? "unknown"}/${itemId}`;

    const hadScheduledJob = (await redis.hGet(itemId, "scheduled")) === "true";

    if (!hadScheduledJob) {
      console.log(
        `No scheduled job found for item ${uniqueId}. Not scheduling retry.`
      );
      return;
    }

    const status = await redis.hGet(itemId, "relayStatus");

    if (status === "relayed") {
      console.log(
        `Item ${uniqueId} has already been relayed. Not scheduling retry.`
      );
      return;
    }

    const delayKey =
      itemType === "post"
        ? "post-delay-after-approval"
        : "comment-delay-after-approval";
    let delay: number = (await settings.get(delayKey)) || 0;

    if (delay === 0) {
      delay = MINIMUM_DELAY;
    }

    const runAt = new Date(Date.now() + delay * 60 * 1000);

    console.log(
      `Scheduling retry relay for ${uniqueId} due to approval. Will run at ${runAt}.`
    );

    await scheduler.runJob({
      name: RELAY_SCHEDULED_JOB,
      data: {
        data: {},
        itemType,
        itemId,
        uniqueId,
        webhookUrl: (await settings.get("webhook-url"))!.toString(),
      },
      runAt,
    });
  },
});

// ---------- Relay + Embed ----------

async function relay(
  context: TriggerContext,
  item: Comment | Post,
  webhookUrl: string,
  data: any
) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  console.log(
    `Webhook response: ${response.status} ${await response.text().catch(() => "")}`
  );

  await context.redis.hSet(item.id, { relayed: "true" });
}

// Helper: convert "#RRGGBB" to Discord int color
function hexToInt(hex: string | undefined): number | undefined {
  if (!hex) return undefined;
  const clean = hex.replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) return undefined;
  return parseInt(clean, 16);
}

// Helper: map flair background color to a colored emoji block
function flairColorToEmoji(hex: string | undefined): string {
  if (!hex) return "⬜"; // default

  const clean = hex.replace("#", "");
  if (!/^[0-9A-Fa-f]{6}$/.test(clean)) return "⬜";

  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);

  // crude but good-enough nearest-color mapping
  if (r > 200 && g < 80 && b < 80) return "🟥"; // red
  if (g > 200 && r < 80 && b < 80) return "🟩"; // green
  if (b > 200 && r < 80 && g < 80) return "🟦"; // blue
  if (r > 200 && g > 200 && b < 80) return "🟨"; // yellow
  if (r < 80 && g < 80 && b < 80) return "⬛"; // dark
  if (r > 200 && g > 200 && b > 200) return "⬜"; // light

  return "⬜"; // fallback
}

async function scheduleRelay(
  context: TriggerContext,
  item: Comment | Post,
  itemType: "post" | "comment",
  authorName: string,
  approvalRetry: boolean
) {
  const { reddit, redis, settings } = context;

  const webhookUrl = (await settings.get("webhook-url"))!.toString();

  const username =
    authorName ||
    (item as any).authorName ||
    (item as any).author?.name ||
    "unknown";

  const suppressSubmitter =
    (await settings.get("suppress-submitter")) || false;
  const authorUrl = suppressSubmitter
    ? ""
    : `https://www.reddit.com/u/${username}`;

  const uniqueId =
    itemType === "post"
      ? item.id
      : `${(item as Comment).parentId ?? "unknown"}/${item.id}`;

  const delayKey =
    itemType === "post" ? "post-delay" : "comment-delay";
  let delay: number =
    (await settings.get(
      delayKey + (approvalRetry ? "-after-approval" : "")
    )) || 0;

  const suppressAuthorEmbed =
    (await settings.get("suppress-author-embed")) || false;
  const suppressItemEmbed =
    (await settings.get("suppress-item-embed")) || false;

  const redditUrl = `https://www.reddit.com${item.permalink}`;

  // 🔢 How many images to embed
  const rawImageEmbedCount = (await settings.get("image-embed-count")) ?? 1;
  const imageEmbedCount = Math.max(0, Number(rawImageEmbedCount) || 0);

  let message = `New [${itemType}](${
    suppressItemEmbed ? "<" : ""
  }${redditUrl}${suppressItemEmbed ? ">" : ""}) by [u/${username}](${
    suppressAuthorEmbed ? "<" : ""
  }${authorUrl}${suppressAuthorEmbed ? ">" : ""})!`;

  if (await settings.get("ping-role")) {
    const roleId = await settings.get("ping-role-id");
    if (roleId) {
      message = `${message}\n<@&${roleId}>`;
    }
  }

  const data: any = {
    content: message,
    allowed_mentions: {
      parse: ["roles", "users", "everyone"],
    },
  };

  // ---------- Embed building ----------
  if (!suppressItemEmbed) {
    const subreddit: Subreddit = await reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;

    let description = "";
    let imageUrls: string[] = [];

    // flair-related vars (used for posts only)
    let flairText = "";
    let flairBackground = "";
    let flairTextColor: "light" | "dark" | undefined;
    let flairLabel = "";
    let embedColor: number | undefined;

    if (itemType === "post") {
      const post = item as Post;

      // 🔹 Read flair from linkFlair (preferred) or flair (fallback)
      const linkFlair =
        (post as any).linkFlair ??
        (post as any).flair ??
        null;

      if (linkFlair) {
        flairText = linkFlair.text ?? "";
        flairBackground = linkFlair.backgroundColor ?? "";
        flairTextColor = linkFlair.textColor ?? "dark";
      }

      // 🔹 Default flair background if empty
      if (!flairBackground || flairBackground.trim() === "") {
        flairBackground = "#808080"; // default background color
      }

      // 🔹 Emoji color block based on flair background
      let flairEmoji = "";
      if (flairText) {
        flairEmoji = flairColorToEmoji(flairBackground);
        flairLabel = `${flairEmoji} **${flairText}**`;
      }

      // 🔹 Convert background hex to Discord color int (for embed border)
      embedColor = hexToInt(flairBackground);

      const template = (await settings.get(
        "post-embed-template"
      )) as string | undefined;

      let descBody = "";

      if (template && template.trim().length > 0) {
        const raw = renderTemplate(template, {
          title: post.title ?? "",
          selftext: (post.selftext as string) ?? "",
          url: redditUrl,
          author: username,
          subreddit: subredditName,
          flair: flairText ?? "",
        });
        descBody = truncateText(raw, 1024);
      } else if (post.selftext && (post.selftext as string).trim().length > 0) {
        const rawSelfText =
          ((post as any).selfText ?? (post as any).selftext ?? "") as string;

        const cleanedSelfText = rawSelfText
          // remove inline image markdown
          .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
          // remove excessive empty lines
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        descBody = truncateText(cleanedSelfText, 1024);
      } else {
        descBody = "";
      }

      // 🔹 Combine flair label + body into description
      if (flairLabel && descBody) {
        description = `${flairLabel}\n\n${descBody}`;
      } else if (flairLabel) {
        description = flairLabel;
      } else {
        description = descBody;
      }

      // 🔍 IMAGE LOGIC
      if (imageEmbedCount === 1) {
        // Single image mode → existing helper
        const single = await fetchImageUrlForPost(context, post);
        if (single) {
          imageUrls = [single];
        }
      } else if (imageEmbedCount > 1) {
        // Multi-image mode → multi helper
        const many = await fetchImageUrlsForPost(context, post);
        if (many && many.length > 0) {
          imageUrls = many.slice(0, imageEmbedCount);
        }
      }

      // If there is no body and no images, show the link so it’s at least clickable
      if (!description && post.url && imageUrls.length === 0) {
        description = `🔗 ${post.url}`;
      }

      console.log("Final image URLs for embed (post)", {
        id: post.id,
        permalink: post.permalink,
        imageEmbedCount,
        imageUrls,
      });
    } else {
      // Comment
      const comment = item as Comment;

      const linkId =
        (comment as any).linkId ??
        (comment as any).postId ??
        undefined;

      let parentPostTitle = "";
      if (linkId) {
        try {
          const parentPost = await reddit.getPostById(linkId);
          parentPostTitle = parentPost?.title ?? "";
        } catch (e) {
          console.log("Error fetching parent post for comment:", e);
        }
      }

      const template = (await settings.get(
        "comment-embed-template"
      )) as string | undefined;

      if (template && template.trim().length > 0) {
        const raw = renderTemplate(template, {
          body: (comment.body as string) ?? "",
          postTitle: parentPostTitle,
          url: redditUrl,
          author: username,
          subreddit: subredditName,
        });
        description = truncateText(raw, 2000);
      } else {
        description = truncateText(comment.body as string, 2000);
      }
    }

    // ---------- Shared title logic (with flair in title for posts) ----------
    let title: string;
    if (itemType === "post") {
      const post = item as Post;
      const baseTitle = post.title ?? "";
      title = truncateText(baseTitle, 256);
    } else {
      const comment = item as Comment;
      const linkId =
        (comment as any).linkId ??
        (comment as any).postId ??
        undefined;

      let parentPostTitle = "";
      if (linkId) {
        try {
          const parentPost = await reddit.getPostById(linkId);
          parentPostTitle = parentPost?.title ?? "";
        } catch (e) {
          console.log("Error fetching parent post title for comment:", e);
        }
      }
      title = truncateText(`New comment on: ${parentPostTitle}`, 256);
    }
    // -----------------------------------------------------------------

    const footer = {
      text: `r/${subredditName}`,
    };
    const timestamp = new Date().toISOString();

    const embed: any = {
      title,
      url: redditUrl,
      description,
      author: {
        name: `u/${username}`,
        ...(suppressAuthorEmbed ? {} : { url: authorUrl }),
      },
      ...(embedColor ? { color: embedColor } : {}), // flair-based border color for posts
      // footer + timestamp added to last embed below
    };

    // Attach first image (if any) to the main embed for posts
    if (itemType === "post" && imageUrls.length > 0) {
      embed.image = { url: imageUrls[0] };
    }

    if (data.embeds && data.embeds.length > 0) {
      data.embeds[0] = { ...data.embeds[0], ...embed };
    } else {
      data.embeds = [embed];
    }

    // Extra image embeds (post only, if more than 1 image)
    if (itemType === "post" && imageUrls.length > 1) {
      const extraEmbeds = imageUrls.slice(1).map((url) => ({
        image: { url },
        ...(embedColor ? { color: embedColor } : {}),
      }));
      data.embeds = [...(data.embeds || []), ...extraEmbeds];
    }

    // ✅ Footer + timestamp on the LAST embed only
    if (data.embeds && data.embeds.length > 0) {
      const lastIndex = data.embeds.length - 1;
      data.embeds[lastIndex] = {
        ...data.embeds[lastIndex],
        footer,
        timestamp,
      };
    }
  }
  // ---------- /Embed building ----------

  if (delay == 0) {
    console.log(`Relaying event ${uniqueId}`);
    if ((await settings.get("ignore-removed")) && isRemoved(item)) {
      console.log(`Not relaying due to item removed: ${uniqueId}`);
      return;
    }
    await relay(context, item, webhookUrl, data);
  } else {
    const runAt = new Date(Date.now() + delay * 60 * 1000);
    console.log(
      `Scheduling relay (${uniqueId}) for ${delay} minutes from now (${runAt})`
    );

    if ((await redis.hGet(item.id, "scheduled")) === "true") {
      console.log(`Relay job already scheduled for ${uniqueId}`);
      return;
    }

    await context.scheduler.runJob({
      name: RELAY_SCHEDULED_JOB,
      data: {
        data,
        itemType,
        itemId: item.id,
        uniqueId,
        webhookUrl,
      },
      runAt,
    });
  }

  await redis.hSet(item.id, { scheduled: "true" });
}


async function shouldRelay(
  event: any,
  context: TriggerContext
): Promise<boolean> {
  let itemType: string;
  let item: Post | Comment;
  let authorName: string;

  switch (event.type) {
    case "PostCreate":
      item = event.post;
      itemType = "post";
      authorName = event.author.name;
      break;
    case "CommentCreate":
      item = event.comment;
      itemType = "comment";
      authorName = event.author.name;
      break;
    default:
      return false;
  }

  console.log(
    `Checking if we should relay event (${
      item instanceof Comment ? `${item.parentId}/${item.id}` : item.id
    }).`
  );

  const { reddit, settings } = context;
  const contentType = (await settings.get("content-type")) || ["all"];

  const checks: boolean[] = [];
  let shouldRelay = false;

  if (contentType[0] === "all") {
    checks.push(true);
  } else {
    if (contentType[0] === "post") {
      checks.push(itemType === "post");
    } else {
      checks.push(itemType === "comment");
    }
  }

  const subredditOnly = await settings.get("subreddit-only");
  if (subredditOnly) {
    const subreddits = subredditOnly
      .split(",")
      .map((subreddit: string) => subreddit.trim().toLowerCase());
    const subreddit = await reddit.getCurrentSubreddit();
    shouldRelay = subreddits.includes(subreddit.name.toLowerCase());
    checks.push(shouldRelay);
  }

  const specificUsernames = await settings.get("specific-username");
  if (specificUsernames) {
    const usernames = specificUsernames
      .split(",")
      .map((username: string) => username.trim().toLowerCase());
    shouldRelay = usernames.includes(authorName.toLowerCase());
    checks.push(shouldRelay);
  }

  const userFlairs = await settings.get("user-flair");
  const subreddit = await reddit.getCurrentSubreddit();
  const flairMap = new Map<string, string>();

  if (userFlairs) {
    const flairs = userFlairs
      .split(",")
      .map((flair: string) => flair.trim().toLowerCase());

    if (item.authorFlairText) {
      shouldRelay = flairs.includes(item.authorFlairText.toLowerCase());
      checks.push(shouldRelay);
    } else if (item.authorFlairId) {
      if (!flairMap.has(item.authorFlairId)) {
        const userFlairsTemplates = await subreddit.getUserFlairTemplates();
        for (const flair of userFlairsTemplates) {
          flairMap.set(flair.id, flair.text);
        }
      }

      shouldRelay = flairs.includes(
        (flairMap.get(item.authorFlairId) ?? "").toLowerCase()
      );
      checks.push(shouldRelay);
    }
  }

  const postFlairs = await settings.get("post-flair");
  if (postFlairs) {
    const flairs = postFlairs
      .split(",")
      .map((flair: string) => flair.trim().toLowerCase());

    if (item instanceof Post && item.flair && item.flair.text) {
      const postFlair = item.flair.text.toLowerCase();
      shouldRelay = flairs.includes(postFlair);
      checks.push(shouldRelay);
    }
  }

  const approvedUsersOnly = await settings.get("approved-users-only");
  if (approvedUsersOnly) {
    const subreddit: Subreddit = await reddit.getCurrentSubreddit();
    const approvedUsers = await subreddit
      .getApprovedUsers({ username: authorName })
      .all();
    shouldRelay = approvedUsers.length > 0;
    checks.push(shouldRelay);
  }

  const moderatorsOnly = await settings.get("moderators-only");
  if (moderatorsOnly) {
    const subreddit: Subreddit = await reddit.getCurrentSubreddit();
    const moderators = await subreddit
      .getModerators({ username: authorName })
      .all();
    shouldRelay = moderators.length > 0;
    checks.push(shouldRelay);
  }

  const ignoreSpecificUsernames = await settings.get(
    "ignore-specific-username"
  );
  if (ignoreSpecificUsernames) {
    const usernames = ignoreSpecificUsernames
      .split(",")
      .map((username: string) => username.trim().toLowerCase());
    shouldRelay = !usernames.includes(authorName.toLowerCase());
    checks.push(shouldRelay);
  }

  const ignoreUserFlairs = await settings.get("ignore-user-flair");
  if (ignoreUserFlairs) {
    const flairs = ignoreUserFlairs
      .split(",")
      .map((flair: string) => flair.trim().toLowerCase());

    if (item.authorFlairText) {
      shouldRelay = !flairs.includes(item.authorFlairText.toLowerCase());
      checks.push(shouldRelay);
    } else if (item.authorFlairId) {
      if (!flairMap.has(item.authorFlairId)) {
        const userFlairsTemplates = await subreddit.getUserFlairTemplates();
        for (const flair of userFlairsTemplates) {
          flairMap.set(flair.id, flair.text);
        }
      }

      shouldRelay = !flairs.includes(
        (flairMap.get(item.authorFlairId) ?? "").toLowerCase()
      );
      checks.push(shouldRelay);
    }
  }

  const ignorePostFlairs = await settings.get("ignore-post-flair");
  if (ignorePostFlairs) {
    const flairs = ignorePostFlairs
      .split(",")
      .map((flair: string) => flair.trim().toLowerCase());

    if (item instanceof Post && item.flair && item.flair.text) {
      const postFlair = item.flair.text.toLowerCase();
      shouldRelay = !flairs.includes(postFlair);
      checks.push(shouldRelay);
    }
  }

  const ignoreShadowbanned = await settings.get("ignore-shadowbanned");
  if (ignoreShadowbanned) {
    const subreddit: Subreddit = await reddit.getCurrentSubreddit();
    const moderators = await subreddit
      .getModerators({ username: authorName })
      .all();
    const isModerator = moderators.length > 0;
    let shadowBanned = false;

    if (!isModerator) {
      shadowBanned = await isShadowBanned(context, item);
    }

    shouldRelay = !shadowBanned;
    checks.push(shouldRelay);
  }

  if (await settings.get("relay-replies")) {
    if (item instanceof Comment) {
      const parentId = item.parentId;
      const parent = await reddit.getCommentById(parentId);

      shouldRelay = parent && parent.parentId === item.parentId;
      checks.push(shouldRelay);
    }
  }

  if (checks.length == 0) {
    console.log(`Should relay event: ${shouldRelay}`);
    return shouldRelay;
  }

  shouldRelay = checks.includes(true);
  console.log(`Should relay event: ${shouldRelay}`);

  return shouldRelay;
}

function validateDelay(
  event: SettingsFormFieldValidatorEvent<number | undefined>
) {
  const inputValue = event.value || 0;

  if (inputValue != 0 && inputValue < MINIMUM_DELAY) {
    return `Please enter a delay of at least ${MINIMUM_DELAY} minutes`;
  }
}

export default Devvit;
