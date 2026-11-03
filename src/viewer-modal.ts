import { App, Modal, TFile, Notice, MarkdownRenderer, Component } from "obsidian";
import { NodeImageItem, CanvasElement, ToolType, RectElement, TextElement, ArrowElement } from "./types";
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
  private currentTool: ToolType = "select";
  private elementsByImageName: Map<string, CanvasElement[]> = new Map();
  private selectedElementId: string | null = null;

  // Рисование
  private isDrawing: boolean = false;
  private drawStartPoint: { x: number; y: number } = { x: 0, y: 0 };
  private previewEl: HTMLElement | SVGElement | null = null;

  // Перетаскивание (Drag & Drop)
  private isDraggingEl: boolean = false;
  private isDraggingHandle: boolean = false;
  private draggedHandleType: "start" | "end" | null = null;
  private dragStartPoint: { x: number; y: number } = { x: 0, y: 0 };
  private elStartPos: { x: number, y: number } = { x: 0, y: 0 };
  private elStartArrow: { x1: number, y1: number, x2: number, y2: number } | null = null;
  private draggedDOMEl: HTMLElement | SVGElement | null = null;

  // Undo / Redo
  private history: string[] = [];
  private historyIndex: number = -1;
  private readonly MAX_HISTORY = 50;

  // DOM Элементы
  private layerEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private elementsLayerEl!: HTMLElement;
  private svgLayerEl!: SVGSVGElement;
  private viewportEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;
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
    modalEl.tabIndex = 0; // Важно для перехвата клавиатуры
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
    
    this.svgLayerEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svgLayerEl.classList.add("mni-svg-layer");
    this.layerEl.appendChild(this.svgLayerEl);
    
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
    this.setTool("select"); // По умолчанию - выделение

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

      if (this.history.length > this.MAX_HISTORY) {
        this.history.shift();
        this.historyIndex--;
      }

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
    this.updateDeleteButton();
  }

  private updateDeleteButton() {
    if (this.deleteBtn) {
      this.deleteBtn.disabled = !this.selectedElementId;
      this.deleteBtn.classList.toggle("is-disabled", !this.selectedElementId);
    }
  }

  // --- ИНСТРУМЕНТЫ ---
  private renderToolbar(container: HTMLElement) {
    this.toolbarEl = container.createDiv({ cls: "mni-toolbar" });
    const tools: { id: ToolType; icon: string; label: string; hotkey: string }[] = [
      { id: "select", icon: "🖐️", label: "Выделение", hotkey: "V" },
      { id: "pan", icon: "✥", label: "Панорама", hotkey: "H" },
      { id: "rect", icon: "⬜", label: "Прямоугольник", hotkey: "R" },
      { id: "arrow", icon: "↗️", label: "Стрелка", hotkey: "A" },
      { id: "text", icon: "T", label: "Текст", hotkey: "T" },
    ];

    tools.forEach(t => {
      const btn = this.toolbarEl.createEl("button", {
        cls: `mni-tool-btn`, text: t.icon, attr: { title: `${t.label} (${t.hotkey})` }
      });
      btn.dataset.tool = t.id;
      btn.onclick = () => this.setTool(t.id);
    });

    // Кнопка удаления (красный крестик)
    this.deleteBtn = this.toolbarEl.createEl("button", {
      cls: `mni-tool-btn mni-tool-delete is-disabled`, text: "✖", attr: { title: "Удалить выбранное (Delete)" }
    });
    this.deleteBtn.disabled = true;
    this.deleteBtn.onclick = () => this.deleteSelected();
  }

  private setTool(tool: ToolType) {
    this.currentTool = tool;
    this.selectedElementId = null;
    this.updateDeleteButton();
    this.renderElements();
    
    this.viewportEl.classList.remove("is-pan-mode", "is-rect-mode", "is-text-mode", "is-select-mode", "is-arrow-mode");
    this.viewportEl.classList.add(`is-${tool}-mode`);
    
    this.toolbarEl.querySelectorAll(".mni-tool-btn").forEach((btn) => {
      const btnEl = btn as HTMLElement;
      if (btnEl === this.deleteBtn) return;
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
    this.svgLayerEl.style.width = `${w}px`;
    this.svgLayerEl.style.height = `${h}px`;
  }

  private renderElements(): void {
    if (!this.elementsLayerEl) return;
    this.elementsLayerEl.empty();
    
    this.svgLayerEl.innerHTML = `
      <defs>
        <marker id="mni-arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#e5a158" />
        </marker>
        <marker id="mni-arrowhead-selected" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#ffffff" />
        </marker>
      </defs>
    `;

    const curImg = this.images[this.activeIndex];
    if (!curImg) return;

    const elements = this.elementsByImageName.get(curImg.name) || [];

    elements.forEach(el => {
      const isSelected = this.selectedElementId === el.id;

      if (el.type === "arrow") {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", el.x1.toString());
        line.setAttribute("y1", el.y1.toString());
        line.setAttribute("x2", el.x2.toString());
        line.setAttribute("y2", el.y2.toString());
        line.setAttribute("stroke", isSelected ? "#ffffff" : el.stroke);
        line.setAttribute("stroke-width", el.strokeWidth.toString());
        line.setAttribute("marker-end", isSelected ? "url(#mni-arrowhead-selected)" : "url(#mni-arrowhead)");
        line.dataset.id = el.id;
        line.classList.add("mni-el-svg");
        if (isSelected) line.classList.add("is-selected");
        
        this.svgLayerEl.appendChild(line);

        // Рисуем маркеры (кружочки) на концах, если стрелка выделена
        if (isSelected) {
          const drawHandle = (cx: number, cy: number, type: "start" | "end") => {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute("cx", cx.toString());
            circle.setAttribute("cy", cy.toString());
            circle.setAttribute("r", "6");
            circle.setAttribute("fill", "#e5a158");
            circle.setAttribute("stroke", "#fff");
            circle.setAttribute("stroke-width", "2");
            circle.classList.add("mni-arrow-handle");
            circle.dataset.handle = type;
            circle.dataset.id = el.id;
            this.svgLayerEl.appendChild(circle);
          };
          drawHandle(el.x1, el.y1, "start");
          drawHandle(el.x2, el.y2, "end");
        }
        return;
      }

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
    const keyHandler = (e: KeyboardEvent) => {
      if (!this.containerEl.isConnected) return;
      
      const isInput = ["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName);
      if (isInput) return;

      if (e.key.toLowerCase() === "v") this.setTool("select");
      if (e.key.toLowerCase() === "h") this.setTool("pan");
      if (e.key.toLowerCase() === "r") this.setTool("rect");
      if (e.key.toLowerCase() === "a") this.setTool("arrow");
      if (e.key.toLowerCase() === "t") this.setTool("text");

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      }

      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedElementId) {
        e.preventDefault();
        this.deleteSelected();
      }
    };

    window.addEventListener("keydown", keyHandler);
    this.onClose = () => {
      window.removeEventListener("keydown", keyHandler);
      this.contentEl.empty();
    };
  }

  private deleteSelected() {
    const curImg = this.images[this.activeIndex];
    if (!curImg || !this.selectedElementId) return;
    const list = this.elementsByImageName.get(curImg.name) || [];
    this.elementsByImageName.set(curImg.name, list.filter(el => el.id !== this.selectedElementId));
    this.selectedElementId = null;
    this.updateDeleteButton();
    this.renderElements();
    this.commitHistory();
  }

  private bindPointerEvents(target: HTMLElement): void {
    let pointerMoved = false;

    target.addEventListener("dblclick", (e: MouseEvent) => {
      if (this.currentTool !== "select") return;
      const clickedEl = (e.target as HTMLElement).closest(".mni-el-text") as HTMLElement;
      if (!clickedEl) return;
      e.stopPropagation();
      const id = clickedEl.dataset.id;
      if (id) this.spawnTextInput(e.clientX, e.clientY, id);
    });

    target.addEventListener("pointerdown", (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".mni-toolbar, .mni-topbar, .mni-bottombar")) return;

      this.modalEl.focus();
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pointerMoved = false;

      // --- ЛОГИКА ВЫДЕЛЕНИЯ, ПЕРЕТАСКИВАНИЯ И МАРКЕРОВ ---
      if (this.currentTool === "select") {
        const svgTarget = e.target as SVGElement;
        const clickedEl = (e.target as HTMLElement).closest(".mni-el, .mni-el-svg") as HTMLElement | SVGElement;

        if (svgTarget.classList.contains("mni-arrow-handle")) {
          // Тащим за маркер стрелки
          this.isDraggingHandle = true;
          this.draggedHandleType = svgTarget.dataset.handle as "start" | "end";
          this.selectedElementId = svgTarget.dataset.id || null;
          return;
        }

        if (clickedEl) {
          this.selectedElementId = clickedEl.dataset.id || null;
          this.updateDeleteButton();
          this.renderElements();
          
          const curImg = this.images[this.activeIndex];
          if (!curImg) return;
          
          const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.selectedElementId);
          if (el) {
            this.isDraggingEl = true;
            this.dragStartPoint = { x: e.clientX, y: e.clientY };
            if (el.type === "arrow") {
              this.elStartArrow = { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 };
              this.draggedDOMEl = this.svgLayerEl.querySelector(`line[data-id="${this.selectedElementId}"]`);
            } else {
              this.elStartPos = { x: el.x, y: el.y };
              this.draggedDOMEl = this.elementsLayerEl.querySelector(`[data-id="${this.selectedElementId}"]`);
            }
          }
          return;
        } else {
          this.selectedElementId = null;
          this.updateDeleteButton();
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
        } else if (this.currentTool === "arrow") {
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", coords.x.toString());
          line.setAttribute("y1", coords.y.toString());
          line.setAttribute("x2", coords.x.toString());
          line.setAttribute("y2", coords.y.toString());
          line.setAttribute("stroke", "#e5a158");
          line.setAttribute("stroke-width", "2");
          line.setAttribute("marker-end", "url(#mni-arrowhead)");
          line.classList.add("mni-el-svg-preview");
          this.svgLayerEl.appendChild(line);
          this.previewEl = line;
        }
        return;
      }

      // --- ЛОГИКА ПАНОРАМИРОВАНИЯ ---
      if (this.activePointers.size === 1 && !this.isDraggingEl && !this.isDraggingHandle) {
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

      // ТАЩИМ ЗА МАРКЕР СТРЕЛКИ (Начало или Конец)
      if (this.isDraggingHandle && this.selectedElementId && this.draggedHandleType) {
        const curImg = this.images[this.activeIndex];
        if (!curImg) return;
        const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.selectedElementId) as ArrowElement;
        if (el && el.type === "arrow") {
          const current = this.getImageCoords(e.clientX, e.clientY);
          if (this.draggedHandleType === "start") {
            el.x1 = current.x; el.y1 = current.y;
          } else {
            el.x2 = current.x; el.y2 = current.y;
          }
          
          // Быстрое обновление SVG без полной перерисовки
          const line = this.svgLayerEl.querySelector(`line[data-id="${el.id}"]`);
          if (line) {
            line.setAttribute("x1", el.x1.toString());
            line.setAttribute("y1", el.y1.toString());
            line.setAttribute("x2", el.x2.toString());
            line.setAttribute("y2", el.y2.toString());
          }
          const handle = this.svgLayerEl.querySelector(`.mni-arrow-handle[data-handle="${this.draggedHandleType}"][data-id="${el.id}"]`);
          if (handle) {
            handle.setAttribute("cx", (this.draggedHandleType === "start" ? el.x1 : el.x2).toString());
            handle.setAttribute("cy", (this.draggedHandleType === "start" ? el.y1 : el.y2).toString());
          }
        }
        return;
      }

      // ПЕРЕТАСКИВАНИЕ ЦЕЛОГО ОБЪЕКТА
      if (this.isDraggingEl && this.selectedElementId && this.draggedDOMEl) {
        const curImg = this.images[this.activeIndex];
        if (!curImg) return;

        const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.selectedElementId);
        if (el) {
          const dx = (e.clientX - this.dragStartPoint.x) / this.scale;
          const dy = (e.clientY - this.dragStartPoint.y) / this.scale;

          if (el.type === "arrow" && this.elStartArrow) {
            el.x1 = this.elStartArrow.x1 + dx;
            el.y1 = this.elStartArrow.y1 + dy;
            el.x2 = this.elStartArrow.x2 + dx;
            el.y2 = this.elStartArrow.y2 + dy;
            
            const svgEl = this.draggedDOMEl as SVGLineElement;
            svgEl.setAttribute("x1", el.x1.toString());
            svgEl.setAttribute("y1", el.y1.toString());
            svgEl.setAttribute("x2", el.x2.toString());
            svgEl.setAttribute("y2", el.y2.toString());
            
            // Обновляем и маркеры
            this.svgLayerEl.querySelector(`.mni-arrow-handle[data-handle="start"]`)?.setAttribute("cx", el.x1.toString());
            this.svgLayerEl.querySelector(`.mni-arrow-handle[data-handle="start"]`)?.setAttribute("cy", el.y1.toString());
            this.svgLayerEl.querySelector(`.mni-arrow-handle[data-handle="end"]`)?.setAttribute("cx", el.x2.toString());
            this.svgLayerEl.querySelector(`.mni-arrow-handle[data-handle="end"]`)?.setAttribute("cy", el.y2.toString());

          } else if (el.type !== "arrow") {
            el.x = this.elStartPos.x + dx;
            el.y = this.elStartPos.y + dy;
            this.draggedDOMEl.style.left = `${el.x}px`;
            this.draggedDOMEl.style.top = `${el.y}px`;
          }
        }
        return;
      }

      // РИСОВАНИЕ
      if (this.isDrawing && this.previewEl) {
        const current = this.getImageCoords(e.clientX, e.clientY);
        
        if (this.currentTool === "rect") {
          const width = Math.abs(current.x - this.drawStartPoint.x);
          const height = Math.abs(current.y - this.drawStartPoint.y);
          const left = Math.min(current.x, this.drawStartPoint.x);
          const top = Math.min(current.y, this.drawStartPoint.y);

          (this.previewEl as HTMLElement).style.left = `${left}px`;
          (this.previewEl as HTMLElement).style.top = `${top}px`;
          (this.previewEl as HTMLElement).style.width = `${width}px`;
          (this.previewEl as HTMLElement).style.height = `${height}px`;
        } else if (this.currentTool === "arrow") {
          const line = this.previewEl as SVGLineElement;
          line.setAttribute("x2", current.x.toString());
          line.setAttribute("y2", current.y.toString());
        }
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

      // Завершение перетаскивания маркера
      if (this.isDraggingHandle) {
        this.isDraggingHandle = false;
        this.draggedHandleType = null;
        this.commitHistory();
        return;
      }

      // Завершение перетаскивания объекта
      if (this.isDraggingEl) {
        this.isDraggingEl = false;
        this.draggedDOMEl = null;
        this.elStartArrow = null;
        if (pointerMoved) this.commitHistory();
        return;
      }

      // Завершение рисования
      if (this.isDrawing && this.previewEl) {
        this.isDrawing = false;
        const current = this.getImageCoords(e.clientX, e.clientY);
        const curImg = this.images[this.activeIndex];
        
        if (curImg) {
          const list = this.elementsByImageName.get(curImg.name) || [];
          if (this.currentTool === "rect") {
            const width = Math.abs(current.x - this.drawStartPoint.x);
            const height = Math.abs(current.y - this.drawStartPoint.y);
            const left = Math.min(current.x, this.drawStartPoint.x);
            const top = Math.min(current.y, this.drawStartPoint.y);

            if (width > 10 && height > 10) {
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
          } else if (this.currentTool === "arrow") {
            const dist = Math.sqrt(Math.pow(current.x - this.drawStartPoint.x, 2) + Math.pow(current.y - this.drawStartPoint.y, 2));
            if (dist > 10) {
              const newArrow: ArrowElement = {
                id: `arrow_${Date.now()}`,
                type: "arrow",
                x1: this.drawStartPoint.x, y1: this.drawStartPoint.y,
                x2: current.x, y2: current.y,
                stroke: "#e5a158", strokeWidth: 2
              };
              list.push(newArrow);
              this.elementsByImageName.set(curImg.name, list);
              this.commitHistory();
            }
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
  private spawnTextInput(clientX: number, clientY: number, editElementId?: string) {
    const curImg = this.images[this.activeIndex];
    if (!curImg) return;
    const list = this.elementsByImageName.get(curImg.name) || [];

    let initialText = "";
    let coords = this.getImageCoords(clientX, clientY);

    if (editElementId) {
      const existing = list.find(el => el.id === editElementId) as TextElement | undefined;
      if (existing) {
        initialText = existing.text;
        coords = { x: existing.x, y: existing.y };
      }
    }

    const wrapper = this.elementsLayerEl.createDiv({ cls: "mni-el-input-wrapper" });
    wrapper.style.left = `${coords.x}px`;
    wrapper.style.top = `${coords.y}px`;

    const textarea = wrapper.createEl("textarea", { cls: "mni-text-input", attr: { placeholder: "Введите текст или [[ссылку]]..." } });
    textarea.value = initialText;
    textarea.focus();

    const finishEditing = () => {
      const text = textarea.value.trim();
      wrapper.remove();

      if (!text) {
        if (editElementId) this.deleteSelected();
        return;
      }

      if (editElementId) {
        const existing = list.find(el => el.id === editElementId);
        if (existing && existing.type === "text") {
          existing.text = text;
        }
      } else {
        const newText: TextElement = {
          id: `text_${Date.now()}`,
          type: "text",
          x: coords.x, y: coords.y, width: 200, height: 40,
          text, fontSize: 16, color: "#ffffff"
        };
        list.push(newText);
      }
      
      this.elementsByImageName.set(curImg.name, list);
      this.commitHistory();
      this.renderElements();
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