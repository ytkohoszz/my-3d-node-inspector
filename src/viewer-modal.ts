import { App, Modal, TFile, Notice } from "obsidian";
import { NodeImageItem, CanvasElement, ToolType, RectElement } from "./types";
import { AnnotationManager } from "./pin-manager";

export class NodeInspectorModal extends Modal {
  private noteFile: TFile;
  private images: NodeImageItem[] = [];
  private activeIndex: number = 0;
  private currentTitle: string = "";
  private manager: AnnotationManager;

  // Трансформация холста
  private scale: number = 1;
  private panX: number = 0;
  private panY: number = 0;

  // Жесты
  private activePointers: Map<number, { x: number; y: number }> = new Map();
  private prevPinchDistance: number | null = null;
  private isPanning: boolean = false;
  private startPanPoint: { x: number; y: number } = { x: 0, y: 0 };
  private startTransform: { x: number; y: number } = { x: 0, y: 0 };

  // Инструменты и аннотации
  private currentTool: ToolType = "pan";
  private elementsByImageName: Map<string, CanvasElement[]> = new Map();
  private isDrawing: boolean = false;
  private drawStartPoint: { x: number; y: number } = { x: 0, y: 0 };
  private previewEl: HTMLElement | null = null;

  // DOM Элементы
  private layerEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private elementsLayerEl!: HTMLElement; // Новый слой для фигур
  private viewportEl!: HTMLElement;
  private toolbarEl!: HTMLElement;

  constructor(app: App, noteFile: TFile, images: NodeImageItem[], title: string, initialIndex: number = 0) {
    super(app);
    this.noteFile = noteFile;
    this.images = images;
    this.currentTitle = title;
    this.activeIndex = Math.max(0, Math.min(images.length - 1, initialIndex));
    this.manager = new AnnotationManager(app, noteFile);
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass("mod-3d-node-inspector");
    contentEl.empty();

    const container = contentEl.createDiv({ cls: "mni-container" });

    // 1. Верхняя панель
    const topbar = container.createDiv({ cls: "mni-topbar" });
    const titleBox = topbar.createDiv({ cls: "mni-title-box" });
    titleBox.createSpan({ cls: "mni-icon", text: "☊" });
    titleBox.createSpan({ cls: "mni-title", text: this.currentTitle });

    const actions = topbar.createDiv({ cls: "mni-top-actions" });

    const fitBtn = actions.createEl("button", {
      cls: "mni-btn", text: "Вписать", attr: { type: "button", title: "Вписать схему в экран" }
    });
    fitBtn.onclick = () => this.fitToScreen();

    const closeBtn = actions.createEl("button", {
      cls: "mni-btn is-close", text: "✕", attr: { type: "button", title: "Закрыть инспектор (Esc)" }
    });
    closeBtn.onclick = () => this.close();

    // 2. Вьюпорт и слои
    this.viewportEl = container.createDiv({ cls: "mni-viewport" });
    this.layerEl = this.viewportEl.createDiv({ cls: "mni-canvas-layer" });

    if (this.images.length === 0) {
      container.createDiv({ cls: "mni-empty-msg", text: "В этой заметке не найдено прикреплённых скриншотов." });
      return;
    }

    this.imgEl = this.layerEl.createEl("img", { cls: "mni-image" });
    this.elementsLayerEl = this.layerEl.createDiv({ cls: "mni-elements-layer" });

    this.imgEl.onload = async () => {
      this.syncLayersSize();
      // Загружаем и мигрируем данные
      this.elementsByImageName = await this.manager.loadElements(
        this.imgEl.naturalWidth || 800, 
        this.imgEl.naturalHeight || 600
      );
      this.renderElements();
      this.fitToScreen();
    };
    this.loadActiveImage();

    // 3. Панель инструментов (Слева)
    this.renderToolbar(container);

    // 4. Обработка жестов и рисования
    this.bindPointerEvents(this.viewportEl);

    // 5. Нижняя панель
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

  private renderToolbar(container: HTMLElement) {
    this.toolbarEl = container.createDiv({ cls: "mni-toolbar" });

    const tools: { id: ToolType; icon: string; label: string; hotkey: string }[] = [
      { id: "pan", icon: "🖐", label: "Курсор (Pan)", hotkey: "V" },
      { id: "rect", icon: "⬜", label: "Прямоугольник", hotkey: "R" },
      { id: "text", icon: "T", label: "Текст", hotkey: "T" },
    ];

    tools.forEach(t => {
      const btn = this.toolbarEl.createEl("button", {
        cls: `mni-tool-btn ${this.currentTool === t.id ? "is-active" : ""}`,
        text: t.icon,
        attr: { title: `${t.label} (${t.hotkey})` }
      });
      btn.onclick = () => this.setTool(t.id);
    });
  }

  private setTool(tool: ToolType) {
    this.currentTool = tool;
    this.viewportEl.classList.remove("is-pan-mode", "is-rect-mode", "is-text-mode");
    this.viewportEl.classList.add(`is-${tool}-mode`);
    
    // Обновляем кнопки
    this.toolbarEl.querySelectorAll(".mni-tool-btn").forEach((btn, idx) => {
      const tools: ToolType[] = ["pan", "rect", "text"];
      btn.classList.toggle("is-active", tools[idx] === tool);
    });
  }

  private syncLayersSize(): void {
    if (!this.imgEl || !this.elementsLayerEl) return;
    const w = this.imgEl.naturalWidth || 800;
    const h = this.imgEl.naturalHeight || 600;
    this.elementsLayerEl.style.width = `${w}px`;
    this.elementsLayerEl.style.height = `${h}px`;
  }

  private renderElements(): void {
    if (!this.elementsLayerEl) return;
    this.elementsLayerEl.empty();

    const curImg = this.images[this.activeIndex];
    if (!curImg) return;

    const elements = this.elementsByImageName.get(curImg.name) || [];

    elements.forEach(el => {
      if (el.type === "rect") {
        const div = this.elementsLayerEl.createDiv({ cls: "mni-el-rect" });
        div.style.left = `${el.x}px`;
        div.style.top = `${el.y}px`;
        div.style.width = `${el.width}px`;
        div.style.height = `${el.height}px`;
        div.style.borderColor = el.stroke;
        div.style.borderWidth = `${el.strokeWidth}px`;
        div.style.backgroundColor = el.fill;
      } else if (el.type === "text") {
        const div = this.elementsLayerEl.createDiv({ cls: "mni-el-text" });
        div.style.left = `${el.x}px`;
        div.style.top = `${el.y}px`;
        div.style.minWidth = `${el.width}px`;
        div.style.color = el.color;
        div.style.fontSize = `${el.fontSize}px`;
        div.textContent = el.text;
        // TODO: В 3-м этапе заменим на MarkdownRenderer
      }
    });
  }

  private async saveAnnotations() {
    await this.manager.saveElements(this.elementsByImageName);
  }

  private loadActiveImage(): void {
    const cur = this.images[this.activeIndex];
    if (cur && this.imgEl) {
      this.imgEl.src = cur.resourcePath;
      // При смене картинки перерисовываем аннотации (после загрузки)
      this.imgEl.onload = async () => {
        this.syncLayersSize();
        if (this.elementsByImageName.size === 0) {
           // Повторная загрузка из YAML, если еще не загружали
           this.elementsByImageName = await this.manager.loadElements(
             this.imgEl.naturalWidth || 800, 
             this.imgEl.naturalHeight || 600
           );
        }
        this.renderElements();
        this.fitToScreen();
      };
    }
  }

  private applyTransform(): void {
    if (!this.layerEl) return;
    this.layerEl.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
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
    let pointerDownTime = 0;
    let pointerMoved = false;

    target.addEventListener("pointerdown", (e: PointerEvent) => {
      // Клики по тулбару игнорируем
      if ((e.target as HTMLElement).closest(".mni-toolbar, .mni-topbar, .mni-bottombar")) return;

      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      pointerDownTime = Date.now();
      pointerMoved = false;

      if (this.currentTool !== "pan" && this.activePointers.size === 1) {
        // Начинаем рисовать
        this.isDrawing = true;
        const coords = this.getImageCoords(e.clientX, e.clientY);
        this.drawStartPoint = coords;

        if (this.currentTool === "rect") {
          this.previewEl = this.elementsLayerEl.createDiv({ cls: "mni-el-rect is-preview" });
          this.previewEl.style.left = `${coords.x}px`;
          this.previewEl.style.top = `${coords.y}px`;
          this.previewEl.style.width = "0px";
          this.previewEl.style.height = "0px";
          this.previewEl.style.borderColor = "#e5a158";
          this.previewEl.style.borderWidth = "2px";
          this.previewEl.style.backgroundColor = "rgba(229, 161, 88, 0.1)";
        }
        return;
      }

      // Иначе это Pan (перетаскивание)
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

      const dx = Math.abs(e.clientX - this.startPanPoint.x);
      const dy = Math.abs(e.clientY - this.startPanPoint.y);
      if (dx > 4 || dy > 4) pointerMoved = true;

      // Рисование прямоугольника
      if (this.isDrawing && this.currentTool === "rect" && this.previewEl) {
        const current = this.getImageCoords(e.clientX, e.clientY);
        const width = Math.abs(current.x - this.drawStartPoint.x);
        const height = Math.abs(current.y - this.drawStartPoint.y);
        const left = Math.min(current.x, this.drawStartPoint.x);
        const top = Math.min(current.y, this.drawStartPoint.y);

        this.previewEl.style.left = `${left}px`;
        this.previewEl.style.top = `${top}px`;
        this.previewEl.style.width = `${width}px`;
        this.previewEl.style.height = `${height}px`;
        return;
      }

      // Панорамирование
      if (this.isPanning && this.activePointers.size === 1) {
        const moveDx = e.clientX - this.startPanPoint.x;
        const moveDy = e.clientY - this.startPanPoint.y;
        this.panX = this.startTransform.x + moveDx;
        this.panY = this.startTransform.y + moveDy;
        this.applyTransform();
        return;
      }

      // Зум
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

    const onPointerEnd = async (e: PointerEvent) => {
      this.activePointers.delete(e.pointerId);

      if (this.isDrawing && this.currentTool === "rect" && this.previewEl) {
        // Фиксируем фигуру
        this.isDrawing = false;
        const current = this.getImageCoords(e.clientX, e.clientY);
        const width = Math.abs(current.x - this.drawStartPoint.x);
        const height = Math.abs(current.y - this.drawStartPoint.y);
        const left = Math.min(current.x, this.drawStartPoint.x);
        const top = Math.min(current.y, this.drawStartPoint.y);

        // Если слишком маленький — отменяем
        if (width > 10 && height > 10) {
          const curImg = this.images[this.activeIndex];
          if (curImg) {
            const list = this.elementsByImageName.get(curImg.name) || [];
            const newRect: RectElement = {
              id: `rect_${Date.now()}`,
              type: "rect",
              x: left,
              y: top,
              width: width,
              height: height,
              stroke: "#e5a158",
              strokeWidth: 2,
              fill: "rgba(229, 161, 88, 0.1)"
            };
            list.push(newRect);
            this.elementsByImageName.set(curImg.name, list);
            await this.saveAnnotations();
          }
        }
        
        this.previewEl.remove();
        this.previewEl = null;
        this.renderElements();
        return;
      }

      if (this.activePointers.size < 2) this.prevPinchDistance = null;
      if (this.activePointers.size === 1) {
        const remaining = Array.from(this.activePointers.values())[0];
        if (remaining) {
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

    target.addEventListener("wheel", (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      this.zoomAtPoint(e.clientX, e.clientY, factor);
    }, { passive: false });
  }

  private getImageCoords(clientX: number, clientY: number): { x: number, y: number } {
    const rect = this.imgEl.getBoundingClientRect();
    const x = (clientX - rect.left) / this.scale;
    const y = (clientY - rect.top) / this.scale;
    return { x, y };
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
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}