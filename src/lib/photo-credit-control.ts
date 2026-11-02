import type { IControl, Map } from "maplibre-gl";

/**
 * 左下角的实拍版权声明。
 *
 * 这版 MapLibre 的 attribution 默认是 compact：白底、12px 圆角、距边 10px、
 * 字号 12px/20px。非 compact 的贴边半透明条不会出现在右下角，所以这里沿用
 * attribution 的样式类，再把盒子改成和展开的胶囊一致（文字两侧 8px，不留信息按钮的空位）。
 * 窄屏里那条胶囊会横跨底边，盖住左下角时把声明抬到它上沿。
 */
export class PhotoCreditControl implements IControl {
  private map: Map | undefined;
  private container: HTMLElement | undefined;
  private observer: MutationObserver | undefined;
  private readonly place = () => {
    this.placeClearOfAttribution();
  };

  onAdd(map: Map) {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-attrib photo-credit";
    const inner = document.createElement("div");
    inner.className = "maplibregl-ctrl-attrib-inner";
    inner.append("© 2026 ");
    const link = document.createElement("a");
    link.href = "https://github.com/QiYuOr2";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "QiYuOr2";
    inner.append(link, " · 实拍照片版权所有");
    container.append(inner);
    container.style.margin = "10px";
    container.style.padding = "2px 8px";
    container.style.backgroundColor = "#fff";
    container.style.borderRadius = "12px";
    container.style.lineHeight = "20px";
    this.container = container;
    map.on("resize", this.place);
    map.on("idle", this.place);
    map.on("drag", this.place);
    requestAnimationFrame(this.place);
    return container;
  }

  onRemove() {
    this.observer?.disconnect();
    this.observer = undefined;
    this.map?.off("resize", this.place);
    this.map?.off("idle", this.place);
    this.map?.off("drag", this.place);
    this.container?.remove();
    this.container = undefined;
    this.map = undefined;
  }

  private attribution() {
    const attrib = this.map
      ?.getContainer()
      .querySelector(".maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib");
    if (!(attrib instanceof HTMLElement)) return undefined;
    if (!this.observer) {
      this.observer = new MutationObserver(this.place);
      this.observer.observe(attrib, {
        attributes: true,
        attributeFilter: ["class", "open"],
        childList: true,
        subtree: true,
      });
    }
    return attrib;
  }

  /** 以距边 10px 为常态；和右下角 attribution 重叠时，改贴在它上沿。 */
  private placeClearOfAttribution() {
    const el = this.container;
    const map = this.map;
    if (!el || !map) return;
    const attrib = this.attribution();
    const inset = 10;
    el.style.marginTop = `${inset}px`;
    el.style.marginRight = `${inset}px`;
    el.style.marginLeft = `${inset}px`;
    el.style.marginBottom = `${inset}px`;
    if (!attrib) return;
    const mapRect = map.getContainer().getBoundingClientRect();
    const attr = attrib.getBoundingClientRect();
    if (attr.width <= 0 || attr.height <= 0 || el.offsetWidth <= 0) return;
    const left = mapRect.left + inset;
    const right = left + el.offsetWidth;
    const bottom = mapRect.bottom - inset;
    const top = bottom - el.offsetHeight;
    const hits = left < attr.right && right > attr.left && top < attr.bottom && bottom > attr.top;
    if (!hits) return;
    el.style.marginBottom = `${Math.ceil(mapRect.bottom - attr.top)}px`;
  }
}
