import { App, Modal, TFile } from "obsidian";
import { NodeImageItem } from "./types";

export class NodeInspectorModal extends Modal {
  private images: NodeImageItem[] = [];
  private activeIndex: number = 0;
  private currentTitle: string = "";

  // Параметры трансформации холста
  private scale: number = 1;
  private panX: number = 0;
  private panY: number = 0;

  // Управление жестами Pointer Events (iPad pinch + pan)
  private activePointers: Map<number, { x: number; y: number }> = new Map();
  private prevPinchDistance: number | null = null;
  private isPanning: boolean = false;
  private startPanPoint: { x: number; y: number } = { x: 0, y: 0 };
  private startTransform: { x: number; y: number } = { x: 0, y: 0 };

  private layerEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private viewportEl!: HTMLElement;
  private scaleBadgeEl!: HTMLElement;

  constructor(app: App, images: NodeImageItem[], title: string, initialIndex: number = 0) {
    super(app);
    this.images = images;
    this.currentTitle = title;
    this.activeIndex = Math.max(0, Math.min(images.length - 1, initialIndex));
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("mod-3d-node-inspector");
    contentEl.empty();

    const container = contentEl.createDiv({ cls: "mni-container" });

    // 1. Верхняя плавающая панель
    const topbar = container.createDiv({ cls: "mni-topbar" });
    const titleBox = topbar.createDiv({ cls: "mni-title-box" });
    titleBox.createSpan({ cls: "mni-icon", text: "☊" });
    titleBox.createSpan({ cls: "mni-title", text: this.currentTitle });

    const actions = topbar.createDiv({ cls: "mni-top-actions" });

    this.scaleBadgeEl = actions.createEl("button", {
      cls: "mni-btn",
      text: "100%",
      attr: { type: "button", title: "Сбросить масштаб к 100%" }
    });
    this.scaleBadgeEl.onclick = () => this.resetScale();

    const fitBtn = actions.createEl("button", {
      cls: "mni-btn",
      text: "Вписать",
      attr: { type: "button", title: "Вписать схему в экран" }
    });
    fitBtn.onclick = () => this.fitToScreen();

    const closeBtn = actions.createEl("button", {
      cls: "mni-btn is-close",
      text: "✕",
      attr: { type: "button", title: "Закрыть инспектор (Esc)" }
    });
    closeBtn.onclick = () => this.close();

    // 2. Вьюпорт и интерактивный слой
    this.viewportEl = container.createDiv({ cls: "mni-viewport" });
    this.layerEl = this.viewportEl.createDiv({ cls: "mni-canvas-layer" });

    if (this.images.length === 0) {
      container.createDiv({
        cls: "mni-empty-msg",
        text: "В этой заметке не найдено прикреплённых скриншотов нод или схем."
      });
      return;
    }

    this.imgEl = this.layerEl.createEl("img", { cls: "mni-image" });
    this.imgEl.onload = () => this.fitToScreen();
    this.loadActiveImage();

    // 3. Подключение Pointer Events (тач, стилус, мышь)
    this.bindPointerEvents(this.viewportEl);

    // 4. Нижняя панель, если скриншотов несколько
    if (this.images.length > 1) {
      const bottombar = container.createDiv({ cls: "mni-bottombar" });
      this.images.forEach((item, idx) => {
        const thumbBtn = bottombar.createEl("button", {
          cls: `mni-thumb-btn ${idx === this.activeIndex ? "is-active" : ""}`,
          text: `Схема ${idx + 1}`,
          attr: { type: "button" }
        });
        thumbBtn.onclick = () => {
          this.activeIndex = idx;
          bottombar.querySelectorAll(".mni-thumb-btn").forEach((b, i) => {
            b.classList.toggle("is-active", i === idx);
          });
          this.loadActiveImage();
        };
      });
    }
  }

  private loadActiveImage(): void {
    const cur = this.images[this.activeIndex];
    if (cur && this.imgEl) {
      this.imgEl.src = cur.resourcePath;
    }
  }

  private applyTransform(): void {
    if (!this.layerEl) return;
    this.layerEl.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
    if (this.scaleBadgeEl) {
      this.scaleBadgeEl.setText(`${Math.round(this.scale * 100)}%`);
    }
  }

  private resetScale(): void {
    this.scale = 1;
    const rect = this.viewportEl.getBoundingClientRect();
    const imgW = this.imgEl.naturalWidth || 800;
    const imgH = this.imgEl.naturalHeight || 600;
    this.panX = Math.round((rect.width - imgW) / 2);
    this.panY = Math.round((rect.height - imgH) / 2);
    this.applyTransform();
  }

  private fitToScreen(): void {
    if (!this.imgEl || !this.viewportEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const imgW = this.imgEl.naturalWidth || 1;
    const imgH = this.imgEl.naturalHeight || 1;

    const pad = 40;
    const availW = Math.max(100, rect.width - pad * 2);
    const availH = Math.max(100, rect.height - pad * 2);

    const fitScale = Math.min(availW / imgW, availH / imgH, 1.5);
    this.scale = Math.max(0.1, Number(fitScale.toFixed(2)));
    this.panX = Math.round((rect.width - imgW * this.scale) / 2);
    this.panY = Math.round((rect.height - imgH * this.scale) / 2);
    this.applyTransform();
  }

  private bindPointerEvents(target: HTMLElement): void {
    target.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this.activePointers.size === 1) {
        this.isPanning = true;
        target.classList.add("is-dragging");
        this.startPanPoint = { x: e.clientX, y: e.clientY };
        this.startTransform = { x: this.panX, y: this.panY };
      } else if (this.activePointers.size === 2) {
        this.isPanning = false;
        this.prevPinchDistance = this.getPinchDistance();
      }
    });

    target.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.activePointers.has(e.pointerId)) return;
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Панорамирование одним пальцем / мышью
      if (this.isPanning && this.activePointers.size === 1) {
        const dx = e.clientX - this.startPanPoint.x;
        const dy = e.clientY - this.startPanPoint.y;
        this.panX = this.startTransform.x + dx;
        this.panY = this.startTransform.y + dy;
        this.applyTransform();
        return;
      }

      // Pinch-to-zoom двумя пальцами
      if (this.activePointers.size === 2) {
        const dist = this.getPinchDistance();
        if (this.prevPinchDistance && dist > 0) {
          const factor = dist / this.prevPinchDistance;
          const center = this.getPinchCenter();
          this.zoomAtPoint(center.x, center.y, factor);
        }
        this.prevPinchDistance = dist;
      }
    });

    const onPointerEnd = (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) {
        this.prevPinchDistance = null;
      }
      if (this.activePointers.size === 1) {
        const remaining = Array.from(this.activePointers.values())[0];
        if (remaining) {
          this.isPanning = true;
          this.startPanPoint = { x: remaining.x, y: remaining.y };
          this.startTransform = { x: this.panX, y: this.panY };
        }
      } else if (this.activePointers.size === 0) {
        this.isPanning = false;
        target.classList.remove("is-dragging");
      }
    };

    target.addEventListener("pointerup", onPointerEnd);
    target.addEventListener("pointercancel", onPointerEnd);

    // Колёсико мыши для десктопа
    target.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoomAtPoint(e.clientX, e.clientY, factor);
    }, { passive: false });
  }

  private zoomAtPoint(clientX: number, clientY: number, factor: number): void {
    const nextScale = Math.max(0.1, Math.min(6.0, this.scale * factor));
    const rect = this.viewportEl.getBoundingClientRect();
    const originX = clientX - rect.left;
    const originY = clientY - rect.top;

    this.panX = originX - (originX - this.panX) * (nextScale / this.scale);
    this.panY = originY - (originY - this.panY) * (nextScale / this.scale);
    this.scale = nextScale;
    this.applyTransform();
  }

  private getPinchDistance(): number {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2 || !pts[0] || !pts[1]) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private getPinchCenter(): { x: number; y: number } {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2 || !pts[0] || !pts[1]) return { x: 0, y: 0 };
    return {
      x: (pts[0].x + pts[1].x) / 2,
      y: (pts[0].y + pts[1].y) / 2
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
