/** 归一化：全角转半角、小写、去掉空白和常见标点 */
export function normalize(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_・·、。,.()（）「」『』【】[\]~〜!！?？'"]/g, "");
}

function bigrams(s: string): string[] {
  if (s.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 0~1 的相似度：完全相同 1，包含关系 0.9，否则 bigram Dice 系数 */
export function similarity(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  const A = bigrams(x);
  const B = bigrams(y);
  const pool = [...B];
  let hit = 0;
  for (const g of A) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}
