import type { IControl, Map } from "maplibre-gl";

/**
 * 左下角的实拍版权声明。
 *
 * 盒子和右下角 attribution 共用图例面板那套尺寸（白底、4px 圆角、12px/20px、
 * 左右 10px 上下 4px、2px 的 10% 黑描边）。底边距固定，不跟着 attribution
 * 展开或收起上下挪。attribution 能用的最大宽度写在地图容器上，避免盖住这条声明。
 */
export class PhotoCreditControl implements IControl {
  private map: Map | undefined;
  private container: HTMLElement | undefined;
  private observer: ResizeObserver | undefined;
  private readonly sync = () => {
    this.syncAttribRoom();
  };

  onAdd(map: Map) {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl photo-credit";
    const inner = document.createElement("div");
    inner.className = "photo-credit-inner";
    inner.append("© 2026 ");
    const link = document.createElement("a");
    link.href = "https://github.com/QiYuOr2";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "QiYuOr2";
    inner.append(link, " · 实拍照片版权所有");
    container.append(inner);
    this.container = container;
    this.observer = new ResizeObserver(this.sync);
    this.observer.observe(container);
    map.on("resize", this.sync);
    requestAnimationFrame(this.sync);
    return container;
  }

  onRemove() {
    this.observer?.disconnect();
    this.observer = undefined;
    this.map?.off("resize", this.sync);
    this.map?.getContainer().style.removeProperty("--photo-credit-width");
    this.map?.getContainer().style.removeProperty("--map-width");
    this.container?.remove();
    this.container = undefined;
    this.map = undefined;
  }

  /** 声明自身的宽度，加上左右边距和缝，从地图宽度里扣掉。 */
  private syncAttribRoom() {
    const el = this.container;
    const map = this.map;
    if (!el || !map) return;
    const mapEl = map.getContainer();
    const width = el.getBoundingClientRect().width;
    if (width <= 0) return;
    mapEl.style.setProperty("--photo-credit-width", `${Math.ceil(width)}px`);
    mapEl.style.setProperty("--map-width", `${mapEl.clientWidth}px`);
  }
}
