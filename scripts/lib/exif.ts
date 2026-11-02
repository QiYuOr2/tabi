import exifr from "exifr";

export interface PhotoCapture {
  lat: number | null;
  lng: number | null;
  takenAt: string | null;
}

/**
 * EXIF 的 DateTimeOriginal 是拍摄地本地时间，不带时区（"2026:05:03 14:20:00"）。
 * 有 OffsetTimeOriginal 时拼成带偏移的 ISO；没有就保留不带时区的本地时间，
 * 避免被跑脚本的机器时区改写。
 */
export function exifTimeToISO(raw: unknown, offset: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return typeof offset === "string" && /^[+-]\d{2}:\d{2}$/.test(offset) ? local + offset : local;
}

/** 从原图读取 GPS 和拍摄时间。读失败时抛错，由调用方决定怎么处理。 */
export async function readPhotoCapture(path: string): Promise<PhotoCapture> {
  const gps = await exifr.gps(path);
  const meta = (await exifr.parse(path, {
    pick: ["DateTimeOriginal", "CreateDate", "OffsetTimeOriginal", "OffsetTime"],
    reviveValues: false,
  })) as Record<string, unknown> | undefined;
  return {
    lat: typeof gps?.latitude === "number" ? gps.latitude : null,
    lng: typeof gps?.longitude === "number" ? gps.longitude : null,
    takenAt: exifTimeToISO(
      meta?.DateTimeOriginal ?? meta?.CreateDate,
      meta?.OffsetTimeOriginal ?? meta?.OffsetTime,
    ),
  };
}

/** 文件里如果还能解析出 EXIF 或 GPS，返回原因；没有则返回 null。 */
export async function embeddedMetaKind(path: string): Promise<string | null> {
  const gps = await exifr.gps(path);
  if (gps && (typeof gps.latitude === "number" || typeof gps.longitude === "number")) return "GPS";
  const parsed = (await exifr.parse(path, { reviveValues: false })) as
    | Record<string, unknown>
    | undefined;
  if (parsed && Object.keys(parsed).length > 0) return "EXIF";
  return null;
}
