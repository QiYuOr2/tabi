const PLAN = /([?&])plan=[^&]*/;

/** anitabi 只提供 h160 和 h360。弹层里的动画截图用 h360。其它地址原样返回。 */
export function imagePlan(url: string | null, plan: "h160" | "h360"): string | null {
  if (!url) return null;
  if (!url.includes("image.anitabi.cn")) return url;
  if (PLAN.test(url)) return url.replace(PLAN, `$1plan=${plan}`);
  return `${url}${url.includes("?") ? "&" : "?"}plan=${plan}`;
}

const TABI_PHOTO = /^(.*\/tabi\/[^/]+)\/([^/]+)$/;

/**
 * 实拍 640 中图。
 * `.../tabi/<bangumiId>/<file>` → `.../tabi/<bangumiId>/mid/<file>`，文件名和扩展名不变。
 * 路径不在这一层（缩略图、中图、动画截图等子目录）时返回 null。
 */
export function photoMedium(url: string | null): string | null {
  if (!url) return null;
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const path = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const match = TABI_PHOTO.exec(path);
  if (!match) return null;
  const dir = match[1];
  const file = match[2];
  if (!dir || !file) return null;
  return `${dir}/mid/${file}${url.slice(path.length)}`;
}

const warmed = new Set<string>();

/** 提前拉一张图。页面 referrer 为 never，这里再标明 no-referrer。 */
export function prefetchImage(url: string | null) {
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  const img = new Image();
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  img.src = url;
}
