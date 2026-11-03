import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到仓库根目录（pnpm-workspace.yaml）");
    dir = parent;
  }
}

/** 仓库根目录。`pnpm --filter` 会把 cwd 改到包目录，文件路径仍相对这里。 */
export const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

/** 绝对路径原样返回，相对路径相对仓库根目录。 */
export function fromRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}
