import { App, Modal, TFile, Notice, MarkdownRenderer, Component } from "obsidian";
import { NodeImageItem, CanvasElement, ToolType, RectElement, TextElement } from "./types";
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

  // Инструменты
  private currentTool: ToolType = "pan";
  private elementsByImageName: Map<string, CanvasElement[]> = new Map();
  private selectedElementId: string | null = null;

  // Рисование
  private isDrawing: boolean = false;
  private drawStartPoint: { x: number; y: number } = { x: 0, y: 0 };
  private previewEl: HTMLElement | null = null;

  // Перетаскивание (Drag & Drop)
  private isDraggingEl: boolean = false;
  private dragStartPoint: { x: number; y: number } = { x: 0, y: 0 };
  private elStartPos: { x: number, y: number } = { x: 0, y: 0 };

  // Undo / Redo
  private history: string[] = [];
  private historyIndex: number = -1;

  // DOM Элементы
  private layerEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private elementsLayerEl!: HTMLElement;
  private viewportEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

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

    this.undoBtn = actions.createEl("button", {
      cls: "mni-btn", text: "↩", attr: { type: "button", title: "Отменить (Ctrl+Z)" }
    });
    this.undoBtn.onclick = () => this.undo();

    this.redoBtn = actions.createEl("button", {
      cls: "mni-btn", text: "↪", attr: { type: "button", title: "Вернуть (Ctrl+Shift+Z)" }
    });
    this.redoBtn.onclick = () => this.redo();

    const fitBtn = actions.createEl("button", {
      cls: "mni-btn", text: "Вписать", attr: { type: "button", title: "Вписать схему в экран" }
    });
    fitBtn.onclick = () => this.fitToScreen();

    const closeBtn = actions.createEl("button", {
      cls: "mni-btn is-close", text: "✕", attr: { type: "button", title: "Закрыть инспектор (Esc)" }
    });
    closeBtn.onclick = () => this.close();

    // 2. Вьюпорт
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
      if (this.elementsByImageName.size === 0) {
        this.elementsByImageName = await this.manager.loadElements(
          this.imgEl.naturalWidth || 800, 
          this.imgEl.naturalHeight || 600
        );
        this.resetHistory();
      }
      this.renderElements();
      this.fitToScreen();
    };
    this.loadActiveImage();

    this.renderToolbar(container);
    this.bindPointerEvents(this.viewportEl);
    this.bindKeyboardEvents();
    this.setTool("pan");

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

  // --- ИСТОРИЯ ДЕЙСТВИЙ ---
  private resetHistory() {
    this.history = [];
    this.historyIndex = -1;
    this.commitHistory();
  }

  private commitHistory() {
    const currentState = JSON.stringify(Array.from(this.elementsByImageName.entries()));
    if (this.historyIndex === -1 || this.history[this.historyIndex] !== currentState) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(currentState);
      this.historyIndex++;
      this.manager.saveElements(this.elementsByImageName);
      this.updateUndoButtons();
    }
  }

  private undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.restoreStateFromHistory();
    }
  }

  private redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.restoreStateFromHistory();
    }
  }

  private restoreStateFromHistory() {
    const stateStr = this.history[this.historyIndex];
    if (stateStr) {
      this.elementsByImageName = new Map(JSON.parse(stateStr));
      this.selectedElementId = null;
      this.renderElements();
      this.manager.saveElements(this.elementsByImageName);
      this.updateUndoButtons();
    }
  }

  private updateUndoButtons() {
    if (this.undoBtn) this.undoBtn.disabled = this.historyIndex <= 0;
    if (this.redoBtn) this.redoBtn.disabled = this.historyIndex >= this.history.length - 1;
  }

  // --- ИНСТРУМЕНТЫ ---
  private renderToolbar(container: HTMLElement) {
    this.toolbarEl = container.createDiv({ cls: "mni-toolbar" });
    const tools: { id: ToolType; icon: string; label: string; hotkey: string }[] = [
      { id: "pan", icon: "🖐", label: "Панорама", hotkey: "V" },
      { id: "select", icon: "🖱️", label: "Выделение", hotkey: "S" },
      { id: "rect", icon: "⬜", label: "Прямоугольник", hotkey: "R" },
      { id: "text", icon: "T", label: "Текст", hotkey: "T" },
    ];

    tools.forEach(t => {
      const btn = this.toolbarEl.createEl("button", {
        cls: `mni-tool-btn`, text: t.icon, attr: { title: `${t.label} (${t.hotkey})` }
      });
      btn.dataset.tool = t.id;
      btn.onclick = () => this.setTool(t.id);
    });
  }

  private setTool(tool: ToolType) {
    this.currentTool = tool;
    this.selectedElementId = null;
    this.renderElements();
    this.viewportEl.classList.remove("is-pan-mode", "is-rect-mode", "is-text-mode", "is-select-mode");
    this.viewportEl.classList.add(`is-${tool}-mode`);
    
    this.toolbarEl.querySelectorAll(".mni-tool-btn").forEach((btn) => {
      const btnEl = btn as HTMLElement;
      btnEl.classList.toggle("is-active", btnEl.dataset.tool === tool);
    });
  }

  // --- РЕНДЕР ---
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
      const isSelected = this.selectedElementId === el.id;
      const wrapper = this.elementsLayerEl.createDiv({ 
        cls: `mni-el mni-el-${el.type} ${isSelected ? "is-selected" : ""}` 
      });
      wrapper.dataset.id = el.id;
      
      wrapper.style.left = `${el.x}px`;
      wrapper.style.top = `${el.y}px`;
      wrapper.style.width = `${el.width}px`;
      wrapper.style.height = `${el.height}px`;

      if (el.type === "rect") {
        wrapper.style.borderColor = el.stroke;
        wrapper.style.borderWidth = `${el.strokeWidth}px`;
        wrapper.style.backgroundColor = el.fill;
      } else if (el.type === "text") {
        wrapper.style.color = el.color;
        wrapper.style.fontSize = `${el.fontSize}px`;
        // Передаем new Component() для корректной работы в strict mode
        MarkdownRenderer.renderMarkdown(el.text, wrapper, this.noteFile.path, new Component());
      }
    });
  }

  // --- СОХРАНЕНИЕ ---
  private loadActiveImage(): void {
    const cur = this.images[this.activeIndex];
    if (cur && this.imgEl) {
      this.imgEl.src = cur.resourcePath;
      this.imgEl.onload = () => {
        this.syncLayersSize();
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

  // --- СОБЫТИЯ ---
  private bindKeyboardEvents() {
    this.modalEl.tabIndex = 0;
    this.modalEl.addEventListener("keydown", (e: KeyboardEvent) => {
      const isInput = ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
      if (isInput) return;

      if (e.key === "v" || e.key === "V" || e.key === "s" || e.key === "S") this.setTool(e.key.toLowerCase() === "v" ? "pan" : "select");
      if (e.key === "r" || e.key === "R") this.setTool("rect");
      if (e.key === "t" || e.key === "T") this.setTool("text");

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      }

      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedElementId) {
        e.preventDefault();
        this.deleteSelected();
      }
    });
  }

  private deleteSelected() {
    const curImg = this.images[this.activeIndex];
    if (!curImg || !this.selectedElementId) return;
    const list = this.elementsByImageName.get(curImg.name) || [];
    this.elementsByImageName.set(curImg.name, list.filter(el => el.id !== this.selectedElementId));
    this.selectedElementId = null;
    this.renderElements();
    this.commitHistory();
  }

  private bindPointerEvents(target: HTMLElement): void {
    let pointerMoved = false;

    target.addEventListener("pointerdown", (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".mni-toolbar, .mni-topbar, .mni-bottombar")) return;

      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pointerMoved = false;

      // --- ЛОГИКА ВЫДЕЛЕНИЯ И ПЕРЕТАСКИВАНИЯ ---
      if (this.currentTool === "select") {
        const clickedEl = (e.target as HTMLElement).closest(".mni-el") as HTMLElement;
        if (clickedEl) {
          this.selectedElementId = clickedEl.dataset.id || null;
          this.renderElements();
          
          const curImg = this.images[this.activeIndex];
          if (!curImg) return; // Защита от undefined
          
          const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.selectedElementId);
          if (el) {
            this.isDraggingEl = true;
            this.dragStartPoint = { x: e.clientX, y: e.clientY };
            this.elStartPos = { x: el.x, y: el.y };
          }
          return;
        } else {
          this.selectedElementId = null;
          this.renderElements();
        }
      }

      // --- ЛОГИКА РИСОВАНИЯ ---
      if (this.currentTool !== "pan" && this.currentTool !== "select" && this.activePointers.size === 1) {
        this.isDrawing = true;
        const coords = this.getImageCoords(e.clientX, e.clientY);
        this.drawStartPoint = coords;

        if (this.currentTool === "rect") {
          this.previewEl = this.elementsLayerEl.createDiv({ cls: "mni-el mni-el-rect is-preview" });
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

      // --- ЛОГИКА ПАНОРАМИРОВАНИЯ ---
      if (this.activePointers.size === 1 && !this.isDraggingEl) {
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

      if (Math.abs(e.clientX - this.startPanPoint.x) > 4 || Math.abs(e.clientY - this.startPanPoint.y) > 4) {
        pointerMoved = true;
      }

      // ПЕРЕТАСКИВАНИЕ
      if (this.isDraggingEl && this.selectedElementId) {
        const curImg = this.images[this.activeIndex];
        if (!curImg) return; // Защита от undefined

        const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.selectedElementId);
        if (el) {
          const dx = (e.clientX - this.dragStartPoint.x) / this.scale;
          const dy = (e.clientY - this.dragStartPoint.y) / this.scale;
          el.x = this.elStartPos.x + dx;
          el.y = this.elStartPos.y + dy;
          this.renderElements();
        }
        return;
      }

      // РИСОВАНИЕ
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

      // ПАНОРАМИРОВАНИЕ
      if (this.isPanning && this.activePointers.size === 1) {
        const moveDx = e.clientX - this.startPanPoint.x;
        const moveDy = e.clientY - this.startPanPoint.y;
        this.panX = this.startTransform.x + moveDx;
        this.panY = this.startTransform.y + moveDy;
        this.applyTransform();
        return;
      }

      // ЗУМ
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

      // Завершение перетаскивания
      if (this.isDraggingEl) {
        this.isDraggingEl = false;
        if (pointerMoved) this.commitHistory();
        return;
      }

      // Завершение рисования
      if (this.isDrawing && this.currentTool === "rect" && this.previewEl) {
        this.isDrawing = false;
        const current = this.getImageCoords(e.clientX, e.clientY);
        const width = Math.abs(current.x - this.drawStartPoint.x);
        const height = Math.abs(current.y - this.drawStartPoint.y);
        const left = Math.min(current.x, this.drawStartPoint.x);
        const top = Math.min(current.y, this.drawStartPoint.y);

        if (width > 10 && height > 10) {
          const curImg = this.images[this.activeIndex];
          if (curImg) {
            const list = this.elementsByImageName.get(curImg.name) || [];
            const newRect: RectElement = {
              id: `rect_${Date.now()}`,
              type: "rect",
              x: left, y: top, width, height,
              stroke: "#e5a158", strokeWidth: 2, fill: "rgba(229, 161, 88, 0.1)"
            };
            list.push(newRect);
            this.elementsByImageName.set(curImg.name, list);
            this.commitHistory();
          }
        }
        
        this.previewEl.remove();
        this.previewEl = null;
        this.renderElements();
        return;
      }

      // Клик инструментом Текст
      if (this.currentTool === "text" && !pointerMoved) {
        this.spawnTextInput(e.clientX, e.clientY);
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

  // --- ТЕКСТОВЫЙ ИНСТРУМЕНТ ---
  private spawnTextInput(clientX: number, clientY: number) {
    const coords = this.getImageCoords(clientX, clientY);
    const wrapper = this.elementsLayerEl.createDiv({ cls: "mni-el-input-wrapper" });
    wrapper.style.left = `${coords.x}px`;
    wrapper.style.top = `${coords.y}px`;

    const textarea = wrapper.createEl("textarea", { cls: "mni-text-input", attr: { placeholder: "Введите текст или [[ссылку]]..." } });
    textarea.focus();

    const finishEditing = () => {
      const text = textarea.value.trim();
      wrapper.remove();
      if (!text) return;

      const curImg = this.images[this.activeIndex];
      if (curImg) {
        const list = this.elementsByImageName.get(curImg.name) || [];
        const newText: TextElement = {
          id: `text_${Date.now()}`,
          type: "text",
          x: coords.x, y: coords.y, width: 200, height: 40,
          text, fontSize: 16, color: "#ffffff"
        };
        list.push(newText);
        this.elementsByImageName.set(curImg.name, list);
        this.commitHistory();
        this.renderElements();
      }
    };

    textarea.addEventListener("blur", finishEditing);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        textarea.blur();
      }
      if (e.key === "Escape") {
        textarea.value = "";
        textarea.blur();
      }
    });
  }

  private getImageCoords(clientX: number, clientY: number): { x: number, y: number } {
    const rect = this.imgEl.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.scale, y: (clientY - rect.top) / this.scale };
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
    return Math.sqrt(Math.pow(pts[0].x - pts[1].x, 2) + Math.pow(pts[0].y - pts[1].y, 2));
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