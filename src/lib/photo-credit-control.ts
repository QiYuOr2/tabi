import type { IControl, Map } from "maplibre-gl";

/** 与图例窄屏断点一致：小于 640px。 */
const NARROW_MAX = 640;
/** 展开时声明底边和 attribution 顶边之间的缝。 */
const STACK_GAP = 8;
const RAISE_MS = 200;

/**
 * 左下角的实拍版权声明。
 *
 * 桌面：和右下角 attribution 并排贴在底边，共用图例面板那套胶囊。
 * 窄屏：attribution 展开时横跨底边（一两行），声明上移到它上面；
 * 收成信息按钮时声明落回同一条底边。上移用 transform，避免和署名重叠。
 */
export class PhotoCreditControl implements IControl {
  private map: Map | undefined;
  private container: HTMLElement | undefined;
  private attribEl: HTMLElement | undefined;
  private mutation: MutationObserver | undefined;
  private attribSize: ResizeObserver | undefined;
  private creditSize: ResizeObserver | undefined;
  private seenExpanded = false;
  private animateNext = false;
  private hold = false;
  private token = 0;
  private releaseTimer = 0;
  private readonly onResize = () => {
    this.sync(false);
  };
  private readonly onClass = () => {
    const expanded = this.isExpanded();
    if (expanded === this.seenExpanded) return;
    this.seenExpanded = expanded;
    if (!this.animateNext) return;
    this.sync(true);
  };
  private readonly onAttribResize = () => {
    if (this.hold || !this.animateNext) return;
    const el = this.container;
    const attrib = this.attribEl;
    if (!el || !attrib || !el.classList.contains("is-raised")) return;
    if (!this.isNarrow() || !this.isExpanded()) return;
    this.setRaise(el, attrib.getBoundingClientRect().height, true);
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
    this.creditSize = new ResizeObserver(this.onResize);
    this.creditSize.observe(container);
    map.on("resize", this.onResize);
    requestAnimationFrame(() => {
      this.sync(false);
      this.animateNext = true;
    });
    return container;
  }

  onRemove() {
    this.token += 1;
    window.clearTimeout(this.releaseTimer);
    this.mutation?.disconnect();
    this.attribSize?.disconnect();
    this.creditSize?.disconnect();
    this.mutation = undefined;
    this.attribSize = undefined;
    this.creditSize = undefined;
    this.attribEl?.classList.remove("is-hold");
    this.map?.off("resize", this.onResize);
    const mapEl = this.map?.getContainer();
    mapEl?.style.removeProperty("--photo-credit-width");
    mapEl?.style.removeProperty("--map-width");
    this.container?.remove();
    this.container = undefined;
    this.attribEl = undefined;
    this.map = undefined;
  }

  private isNarrow() {
    const width = this.map?.getContainer().clientWidth ?? 0;
    return width > 0 && width < NARROW_MAX;
  }

  private isExpanded() {
    return this.attribEl?.classList.contains("maplibregl-compact-show") ?? false;
  }

  private ensureAttrib() {
    const found = this.map
      ?.getContainer()
      .querySelector(".maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib");
    if (!(found instanceof HTMLElement) || found === this.attribEl) return;
    this.mutation?.disconnect();
    this.attribSize?.disconnect();
    this.attribEl = found;
    this.mutation = new MutationObserver(this.onClass);
    this.mutation.observe(found, { attributes: true, attributeFilter: ["class"] });
    this.attribSize = new ResizeObserver(this.onAttribResize);
    this.attribSize.observe(found);
  }

  private publishWidths() {
    const map = this.map;
    const el = this.container;
    if (!map || !el) return;
    const mapEl = map.getContainer();
    mapEl.style.setProperty("--map-width", `${mapEl.clientWidth}px`);
    const width = el.getBoundingClientRect().width;
    if (width > 0) mapEl.style.setProperty("--photo-credit-width", `${Math.ceil(width)}px`);
  }

  private setRaise(el: HTMLElement, height: number, instant: boolean) {
    if (height <= 0) return;
    const px = `${Math.ceil(height) + STACK_GAP}px`;
    if (el.style.getPropertyValue("--credit-raise") === px && el.classList.contains("is-raised")) {
      return;
    }
    if (instant) el.classList.add("is-instant");
    el.style.setProperty("--credit-raise", px);
    if (instant) requestAnimationFrame(() => el.classList.remove("is-instant"));
  }

  private lowerPill() {
    this.token += 1;
    this.hold = false;
    window.clearTimeout(this.releaseTimer);
    this.attribEl?.classList.remove("is-hold");
    this.container?.classList.remove("is-raised");
  }

  /** 先把声明抬上去，再让署名横展开，中间不叠在一起。 */
  private raisePill(animate: boolean) {
    const el = this.container;
    const attrib = this.attribEl;
    if (!el || !attrib) return;
    // 测量时先拿掉 is-hold，否则读到的是信息按钮的 28px，不是横条高度。
    attrib.classList.remove("is-hold");
    const height = attrib.getBoundingClientRect().height;
    if (height <= 0) return;
    if (!animate || el.classList.contains("is-raised")) {
      this.hold = false;
      this.setRaise(el, height, true);
      el.classList.add("is-raised");
      return;
    }
    this.hold = true;
    attrib.classList.add("is-hold");
    this.setRaise(el, height, false);
    const token = ++this.token;
    const finish = () => {
      if (token !== this.token) return;
      this.hold = false;
      if (!this.isNarrow() || !this.isExpanded()) {
        attrib.classList.remove("is-hold");
        return;
      }
      attrib.classList.remove("is-hold");
      const real = attrib.getBoundingClientRect().height;
      this.setRaise(el, real, true);
    };
    const onEnd = (ev: TransitionEvent) => {
      if (ev.propertyName !== "transform" || ev.target !== el) return;
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(this.releaseTimer);
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = window.setTimeout(() => {
      el.removeEventListener("transitionend", onEnd);
      finish();
    }, RAISE_MS + 80);
    el.classList.add("is-raised");
  }

  private sync(animate: boolean) {
    this.ensureAttrib();
    this.publishWidths();
    const expanded = this.isExpanded();
    this.seenExpanded = expanded;
    if (!this.isNarrow() || !expanded) {
      this.lowerPill();
      return;
    }
    this.raisePill(animate);
  }
}
