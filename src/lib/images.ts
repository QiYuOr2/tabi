const PLAN = /([?&])plan=[^&]*/;

/** anitabi 只提供 h160 和 h360。缩略图用 h160，弹层用 h360。其它地址原样返回。 */
export function imagePlan(url: string | null, plan: "h160" | "h360"): string | null {
  if (!url) return null;
  if (!url.includes("image.anitabi.cn")) return url;
  if (PLAN.test(url)) return url.replace(PLAN, `$1plan=${plan}`);
  return `${url}${url.includes("?") ? "&" : "?"}plan=${plan}`;
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
