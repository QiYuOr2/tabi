/** 地址栏里的作品 / 照片。只替换当前记录，不新增历史。 */

export interface MapLink {
  /** bangumi 条目 id。没有则为 null。 */
  work: string | null;
  /** spots.json 里的照片 id。没有则为 null。 */
  spot: string | null;
}

export function readMapLink(search: string): MapLink {
  const params = new URLSearchParams(search);
  const work = params.get("work");
  const spot = params.get("spot");
  return {
    work: work && work.length > 0 ? work : null,
    spot: spot && spot.length > 0 ? spot : null,
  };
}

/** 只改 work 和 spot，其它查询参数保留。值没变时不写历史。 */
export function replaceMapLink(next: MapLink) {
  const url = new URL(window.location.href);
  if (url.searchParams.get("work") === next.work && url.searchParams.get("spot") === next.spot) {
    return;
  }
  if (next.work) url.searchParams.set("work", next.work);
  else url.searchParams.delete("work");
  if (next.spot) url.searchParams.set("spot", next.spot);
  else url.searchParams.delete("spot");
  const href = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (href === current) return;
  history.replaceState(history.state, "", href);
}
