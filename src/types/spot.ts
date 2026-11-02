/** 坐标来源 */
export type SpotSource = "exif" | "anitabi" | "geocode" | "manual";

/** 一条巡礼记录：一个地点 + 一组对比图 */
export interface Spot {
  /** 唯一 ID，建议 `${bangumiId}-${anitabiPointId}` 或照片文件名哈希 */
  id: string;
  /** Bangumi 条目 ID（同时也是 anitabi 的作品 ID），未知时为 null */
  bangumiId: number | null;
  /** 作品名（中文优先） */
  animeName: string;
  /** 地点名 */
  pointName: string;
  /** 浮窗里的补充说明，可选 */
  note?: string;
  /** 纬度（WGS84） */
  lat: number;
  /** 经度（WGS84） */
  lng: number;
  /** 动画截图 URL，可为空 */
  animeImage: string | null;
  /** 实拍图 URL，可为空 */
  photo: string | null;
  /** 实拍缩略图。地图图钉用它，加载失败时回退到 photo。可为空 */
  photoThumb?: string | null;
  /** 拍摄时间 ISO 8601，可为空 */
  takenAt: string | null;
  /** 坐标来源 */
  source: SpotSource;
  /** 对应的 anitabi 地标 ID，可为空 */
  anitabiPointId: string | null;
  /** 截图来源署名（anitabi 要求标注 origin 并可跳转 originURL），可选 */
  origin?: string | null;
  originURL?: string | null;
}

/** import-photos 产出的待定位记录（没有 GPS） */
export interface PendingPhoto {
  file: string;
  photo: string;
  takenAt: string | null;
  /** 需要人工或 match-anitabi 补齐 */
  bangumiId: number | null;
  animeName: string | null;
  pointName: string | null;
}
