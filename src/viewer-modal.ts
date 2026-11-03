import { App, Modal, TFile, Notice, MarkdownRenderer, Component } from "obsidian";
import { NodeImageItem, CanvasElement, ToolType, RectElement, TextElement, ArrowElement, ArrowRouting, ArrowHead, AnchorType } from "./types";
import { AnnotationManager } from "./pin-manager";

export class NodeInspectorModal extends Modal {
  private noteFile: TFile;
  private images: NodeImageItem[] = [];
  private activeIndex: number = 0;
  private currentTitle: string = "";
  private manager: AnnotationManager;

  private scale: number = 1;
  private panX: number = 0;
  private panY: number = 0;

  private activePointers: Map<number, { x: number; y: number }> = new Map();
  private prevPinchDistance: number | null = null;
  private isPanning: boolean = false;
  private startPanPoint: { x: number; y: number } = { x: 0, y: 0 };
  private startTransform: { x: number; y: number } = { x: 0, y: 0 };

  private currentTool: ToolType = "pan";
  private elementsByImageName: Map<string, CanvasElement[]> = new Map();
  
  private selectedElementIds: Set<string> = new Set();
  private lastSelectedId: string | null = null;

  private isDrawing: boolean = false;
  private drawStartPoint: { x: number; y: number } = { x: 0, y: 0 };
  private previewEl: HTMLElement | SVGElement | null = null;

  private isMarquee: boolean = false;
  private marqueeStart: { x: number; y: number } = { x: 0, y: 0 };
  private marqueeEl: HTMLElement | null = null;

  private isDraggingEl: boolean = false;
  private isDraggingHandle: boolean = false;
  private draggedHandleType: string | null = null;
  
  private isResizing: boolean = false;
  private activeResizeHandle: "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | null = null;
  private resizeStartBBox = { x: 0, y: 0, w: 0, h: 0, fontSize: 0 };

  private dragStartPoint: { x: number; y: number } = { x: 0, y: 0 };
  private groupDragStartPositions: Map<string, any> = new Map();

  private history: string[] = [];
  private historyIndex: number = -1;
  private readonly MAX_HISTORY = 50;

  private layerEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private elementsLayerEl!: HTMLElement;
  private svgLayerEl!: SVGSVGElement;
  private viewportEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private propertiesPanelEl!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private keyHandler?: (e: KeyboardEvent) => void;

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
    modalEl.tabIndex = 0;
    contentEl.empty();

    const container = contentEl.createDiv({ cls: "mni-container" });

    const topbar = container.createDiv({ cls: "mni-topbar" });
    const titleBox = topbar.createDiv({ cls: "mni-title-box" });
    titleBox.createSpan({ cls: "mni-icon", text: "☊" });
    titleBox.createSpan({ cls: "mni-title", text: this.currentTitle });

    const actions = topbar.createDiv({ cls: "mni-top-actions" });

    this.undoBtn = actions.createEl("button", { cls: "mni-btn", text: "↩" });
    this.undoBtn.onclick = () => this.undo();
    this.redoBtn = actions.createEl("button", { cls: "mni-btn", text: "↪" });
    this.redoBtn.onclick = () => this.redo();
    const fitBtn = actions.createEl("button", { cls: "mni-btn", text: "Вписать" });
    fitBtn.onclick = () => this.fitToScreen();
    const closeBtn = actions.createEl("button", { cls: "mni-btn is-close", text: "✕" });
    closeBtn.onclick = () => this.close();

    this.viewportEl = container.createDiv({ cls: "mni-viewport" });
    this.layerEl = this.viewportEl.createDiv({ cls: "mni-canvas-layer" });

    if (this.images.length === 0) {
      container.createDiv({ cls: "mni-empty-msg", text: "В этой заметке нет скриншотов." });
      return;
    }

    this.imgEl = this.layerEl.createEl("img", { cls: "mni-image" });
    this.svgLayerEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svgLayerEl.classList.add("mni-svg-layer");
    this.layerEl.appendChild(this.svgLayerEl);
    this.elementsLayerEl = this.layerEl.createDiv({ cls: "mni-elements-layer" });

    await this.loadCurrentImageAndElements();

    this.renderToolbar(container);
    this.propertiesPanelEl = container.createDiv({ cls: "mni-properties-panel is-hidden" });
    
    this.bindPointerEvents(this.viewportEl);
    this.bindKeyboardEvents();
    this.setTool("pan");

    if (this.images.length > 1) {
      const bottombar = container.createDiv({ cls: "mni-bottombar" });
      this.images.forEach((item, idx) => {
        const thumbBtn = bottombar.createEl("button", {
          cls: `mni-thumb-btn ${idx === this.activeIndex ? "is-active" : ""}`,
          text: `Схема ${idx + 1}`
        });
        thumbBtn.onclick = async () => {
          if (this.activeIndex === idx) return;
          this.activeIndex = idx;
          this.selectedElementIds.clear();
          this.lastSelectedId = null;
          bottombar.querySelectorAll(".mni-thumb-btn").forEach((b, i) => b.classList.toggle("is-active", i === idx));
          await this.switchImage(idx);
        };
      });
    }
  }

  private async loadCurrentImageAndElements(): Promise<void> {
    const cur = this.images[this.activeIndex];
    if (!cur || !this.imgEl) return;

    await this.setImageSrc(cur.resourcePath);
    this.syncLayersSize();

    this.elementsByImageName = await this.manager.loadElements(this.imgEl.naturalWidth || 800, this.imgEl.naturalHeight || 600);
    this.syncArrowsToBlocks();
    this.resetHistory();
    this.renderElements();
    this.fitToScreen();
  }

  private async switchImage(_idx: number): Promise<void> {
    const cur = this.images[this.activeIndex];
    if (!cur || !this.imgEl) return;

    await this.setImageSrc(cur.resourcePath);
    this.syncLayersSize();
    this.syncArrowsToBlocks();
    this.updatePropertiesPanel();
    this.updateDeleteButton();
    this.renderElements();
    this.fitToScreen();
  }

  private setImageSrc(src: string): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.imgEl) { resolve(); return; }
      const cleanup = () => { this.imgEl?.removeEventListener("load", onLoad); this.imgEl?.removeEventListener("error", onError); };
      const onLoad = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); resolve(); };
      this.imgEl.addEventListener("load", onLoad, { once: true });
      this.imgEl.addEventListener("error", onError, { once: true });
      this.imgEl.src = src;
    });
  }

  private getAnchorPoint(rect: RectElement, anchor: AnchorType): { x: number, y: number } {
    switch (anchor) {
      case "top": return { x: rect.x + rect.width / 2, y: rect.y };
      case "bottom": return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
      case "left": return { x: rect.x, y: rect.y + rect.height / 2 };
      case "right": return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    }
  }

  private syncArrowsToBlocks() {
    const curImg = this.images[this.activeIndex];
    if (!curImg) return;
    const list = this.elementsByImageName.get(curImg.name) || [];

    list.forEach(el => {
      if (el.type === "arrow") {
        if (el.startElementId) {
          const target = list.find(x => x.id === el.startElementId) as RectElement;
          if (target && target.type === "rect" && el.startAnchor) {
            const pt = this.getAnchorPoint(target, el.startAnchor);
            el.x1 = pt.x; el.y1 = pt.y;
          }
        }
        if (el.endElementId) {
          const target = list.find(x => x.id === el.endElementId) as RectElement;
          if (target && target.type === "rect" && el.endAnchor) {
            const pt = this.getAnchorPoint(target, el.endAnchor);
            el.x2 = pt.x; el.y2 = pt.y;
          }
        }
      }
    });
  }

  private resetHistory() { this.history = []; this.historyIndex = -1; this.commitHistory(); }

  private commitHistory() {
    const currentState = JSON.stringify(Array.from(this.elementsByImageName.entries()));
    if (this.historyIndex === -1 || this.history[this.historyIndex] !== currentState) {
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(currentState);
      this.historyIndex++;
      if (this.history.length > this.MAX_HISTORY) { this.history.shift(); this.historyIndex--; }
      this.manager.saveElements(this.elementsByImageName).catch(e => new Notice("Ошибка: " + e.message));
      this.updateUndoButtons();
    }
  }

  private undo() { if (this.historyIndex > 0) { this.historyIndex--; this.restoreStateFromHistory(); } }
  private redo() { if (this.historyIndex < this.history.length - 1) { this.historyIndex++; this.restoreStateFromHistory(); } }

  private restoreStateFromHistory() {
    const stateStr = this.history[this.historyIndex];
    if (stateStr) {
      this.elementsByImageName = new Map(JSON.parse(stateStr));
      this.selectedElementIds.clear();
      this.lastSelectedId = null;
      this.updatePropertiesPanel();
      this.renderElements();
      this.manager.saveElements(this.elementsByImageName).catch(() => {});
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
      const has = this.selectedElementIds.size > 0;
      this.deleteBtn.disabled = !has;
      this.deleteBtn.classList.toggle("is-disabled", !has);
    }
  }

  private renderToolbar(container: HTMLElement) {
    this.toolbarEl = container.createDiv({ cls: "mni-toolbar" });
    const tools: { id: ToolType; icon: string; label: string; hotkey: string }[] = [
      { id: "pan", icon: "✥", label: "Панорама", hotkey: "H" },
      { id: "select", icon: "🖐️", label: "Выделение", hotkey: "V" },
      { id: "rect", icon: "⬜", label: "Прямоугольник", hotkey: "R" },
      { id: "arrow", icon: "↗️", label: "Стрелка", hotkey: "A" },
      { id: "text", icon: "T", label: "Текст", hotkey: "T" },
    ];

    tools.forEach(t => {
      const btn = this.toolbarEl.createEl("button", { cls: `mni-tool-btn`, text: t.icon, attr: { title: `${t.label} (${t.hotkey})` } });
      btn.dataset.tool = t.id;
      btn.onclick = () => this.setTool(t.id);
    });

    this.deleteBtn = this.toolbarEl.createEl("button", { cls: `mni-tool-btn mni-tool-delete is-disabled`, text: "✖" });
    this.deleteBtn.onclick = () => this.deleteSelected();
  }

  private setTool(tool: ToolType) {
    this.currentTool = tool;
    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.updateDeleteButton();
    this.updatePropertiesPanel();
    this.renderElements();
    
    this.viewportEl.classList.remove("is-pan-mode", "is-rect-mode", "is-text-mode", "is-select-mode", "is-arrow-mode");
    this.viewportEl.classList.add(`is-${tool}-mode`);
    
    this.toolbarEl.querySelectorAll(".mni-tool-btn").forEach((btn) => {
      const btnEl = btn as HTMLElement;
      if (btnEl === this.deleteBtn) return;
      btnEl.classList.toggle("is-active", btnEl.dataset.tool === tool);
    });
  }

  private updatePropertiesPanel() {
    if (!this.propertiesPanelEl) return;
    this.propertiesPanelEl.empty();

    if (!this.lastSelectedId) { this.propertiesPanelEl.classList.add("is-hidden"); return; }
    const curImg = this.images[this.activeIndex];
    if (!curImg) return;

    const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.lastSelectedId);
    if (!el) { this.propertiesPanelEl.classList.add("is-hidden"); return; }

    this.propertiesPanelEl.classList.remove("is-hidden");
    this.propertiesPanelEl.createEl("h4", { text: "Свойства", cls: "mni-prop-title" });

    const addColorRow = (label: string, current: string, onChange: (v: string) => void) => {
      const row = this.propertiesPanelEl.createDiv({ cls: "mni-prop-row" });
      row.createSpan({ text: label });
      const input = row.createEl("input", { type: "color" });
      input.value = current;
      input.oninput = (e) => onChange((e.target as HTMLInputElement).value);
      input.onchange = () => this.commitHistory();
    };

    const addRangeRow = (label: string, min: number, max: number, current: number, onChange: (v: number) => void) => {
      const row = this.propertiesPanelEl.createDiv({ cls: "mni-prop-row" });
      row.createSpan({ text: label });
      const input = row.createEl("input", { type: "range", attr: { min, max } });
      input.value = current.toString();
      input.oninput = (e) => onChange(Number((e.target as HTMLInputElement).value));
      input.onchange = () => this.commitHistory();
    };

    const addSelectRow = <T extends string>(label: string, current: T, options: {val: T, lbl: string}[], onChange: (v: T) => void) => {
      const row = this.propertiesPanelEl.createDiv({ cls: "mni-prop-row" });
      row.createSpan({ text: label });
      const select = row.createEl("select", { cls: "mni-prop-select" });
      options.forEach(opt => {
        const o = select.createEl("option", { text: opt.lbl, value: opt.val });
        if (opt.val === current) o.selected = true;
      });
      select.onchange = (e) => { onChange((e.target as HTMLSelectElement).value as T); this.commitHistory(); };
    };

    if (el.type === "rect") {
      addColorRow("Обводка", el.stroke, (val) => { el.stroke = val; this.renderElements(); });
      addColorRow("Заливка", el.fill === "transparent" ? "#000000" : el.fill, (val) => { el.fill = val; this.renderElements(); });
      addRangeRow("Толщина", 1, 10, el.strokeWidth, (val) => { el.strokeWidth = val; this.renderElements(); });
      
      addRangeRow("Скругление", 0, 50, el.borderRadius || 0, (val) => { 
        el.borderRadius = val; 
        this.renderElements(); 
      });
    } else if (el.type === "arrow") {
      addColorRow("Цвет", el.stroke, (val) => { el.stroke = val; this.renderElements(); });
      addRangeRow("Толщина", 1, 10, el.strokeWidth, (val) => { el.strokeWidth = val; this.renderElements(); });
      
      addSelectRow<ArrowRouting>("Линия", el.routing, [
        { val: "straight", lbl: "Прямая" },
        { val: "curved", lbl: "Кривая" },
        { val: "orthogonal", lbl: "Ортогональная" }
      ], (val) => { 
        el.routing = val; 
        if (val === "curved" && (el.cx1 === undefined || el.cx2 === undefined)) {
          el.cx1 = (el.x1 + el.x2) / 2; el.cy1 = el.y1; 
          el.cx2 = (el.x1 + el.x2) / 2; el.cy2 = el.y2;
        }
        this.renderElements(); 
      });

      addSelectRow<ArrowHead>("Начало", el.startHead || "none", [
        { val: "none", lbl: "Нет" }, { val: "arrow", lbl: "Стрелка" }
      ], (val) => { el.startHead = val; this.renderElements(); });

      addSelectRow<ArrowHead>("Конец", el.endHead || "arrow", [
        { val: "none", lbl: "Нет" }, { val: "arrow", lbl: "Стрелка" }
      ], (val) => { el.endHead = val; this.renderElements(); });

    } else if (el.type === "text") {
      addColorRow("Цвет текста", el.color, (val) => { el.color = val; this.renderElements(); });
      addRangeRow("Размер", 10, 72, el.fontSize, (val) => { el.fontSize = val; this.renderElements(); });
    }
  }

  private syncLayersSize(): void {
    if (!this.imgEl || !this.elementsLayerEl) return;
    const w = this.imgEl.naturalWidth || 800, h = this.imgEl.naturalHeight || 600;
    this.elementsLayerEl.style.width = `${w}px`; this.elementsLayerEl.style.height = `${h}px`;
    this.svgLayerEl.style.width = `${w}px`; this.svgLayerEl.style.height = `${h}px`;
  }

  private getArrowPath(el: ArrowElement): string {
    if (el.routing === "curved") {
      const cx1 = el.cx1 ?? (el.x1 + el.x2) / 2;
      const cy1 = el.cy1 ?? el.y1;
      const cx2 = el.cx2 ?? (el.x1 + el.x2) / 2;
      const cy2 = el.cy2 ?? el.y2;
      return `M ${el.x1} ${el.y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${el.x2} ${el.y2}`;
    } else if (el.routing === "orthogonal") {
      const midX = (el.x1 + el.x2) / 2;
      if (Math.abs(el.y1 - el.y2) < 5) return `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2}`;
      if (Math.abs(el.x1 - el.x2) < 5) return `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2}`;
      if (el.x2 > el.x1) {
        return `M ${el.x1} ${el.y1} L ${midX} ${el.y1} L ${midX} ${el.y2} L ${el.x2} ${el.y2}`;
      } else {
        const offX = Math.max(el.x1, el.x2) + 40;
        return `M ${el.x1} ${el.y1} L ${offX} ${el.y1} L ${offX} ${el.y2} L ${el.x2} ${el.y2}`;
      }
    }
    return `M ${el.x1} ${el.y1} L ${el.x2} ${el.y2}`;
  }

  private renderElements(): void {
    if (!this.elementsLayerEl) return;
    this.elementsLayerEl.empty();
    
    this.svgLayerEl.innerHTML = `
      <defs>
        <marker id="mni-head-end" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <polygon points="0 0, 10 3.5, 0 7" fill="#e5a158" />
        </marker>
        <marker id="mni-head-start" markerWidth="10" markerHeight="7" refX="1" refY="3.5" orient="auto-start-reverse">
          <polygon points="0 0, 10 3.5, 0 7" fill="#e5a158" />
        </marker>
      </defs>
    `;

    const curImg = this.images[this.activeIndex];
    if (!curImg) return;

    const elements = this.elementsByImageName.get(curImg.name) || [];

    elements.forEach(el => {
      const isSelected = this.selectedElementIds.has(el.id);

      if (el.type === "arrow") {
        const pathStr = this.getArrowPath(el);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathStr);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", isSelected ? "#ffffff" : el.stroke);
        path.setAttribute("stroke-width", el.strokeWidth.toString());
        
        if (el.endHead === "arrow") path.setAttribute("marker-end", "url(#mni-head-end)");
        if (el.startHead === "arrow") path.setAttribute("marker-start", "url(#mni-head-start)");

        path.dataset.id = el.id;
        path.classList.add("mni-el-svg");
        if (isSelected) path.classList.add("is-selected");
        this.svgLayerEl.appendChild(path);

        if (isSelected && this.selectedElementIds.size === 1) {
          const drawHandle = (cx: number, cy: number, type: any) => {
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

          if (el.routing === "curved") {
            const cx1 = el.cx1 ?? (el.x1 + el.x2) / 2;
            const cy1 = el.cy1 ?? el.y1;
            const cx2 = el.cx2 ?? (el.x1 + el.x2) / 2;
            const cy2 = el.cy2 ?? el.y2;
            
            const drawCtrl = (cx: number, cy: number, type: any) => {
              const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
              circle.setAttribute("cx", cx.toString());
              circle.setAttribute("cy", cy.toString());
              circle.setAttribute("r", "5");
              circle.setAttribute("fill", "#5c8df6");
              circle.setAttribute("stroke", "#fff");
              circle.classList.add("mni-arrow-handle", "is-control");
              circle.dataset.handle = type;
              circle.dataset.id = el.id;
              this.svgLayerEl.appendChild(circle);
            };
            drawCtrl(cx1, cy1, "curve1");
            drawCtrl(cx2, cy2, "curve2");

            const line1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line1.setAttribute("x1", el.x1.toString()); line1.setAttribute("y1", el.y1.toString());
            line1.setAttribute("x2", cx1.toString()); line1.setAttribute("y2", cy1.toString());
            line1.setAttribute("stroke", "rgba(255,255,255,0.2)"); line1.setAttribute("stroke-dasharray", "4");
            this.svgLayerEl.appendChild(line1);

            const line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line2.setAttribute("x1", el.x2.toString()); line2.setAttribute("y1", el.y2.toString());
            line2.setAttribute("x2", cx2.toString()); line2.setAttribute("y2", cy2.toString());
            line2.setAttribute("stroke", "rgba(255,255,255,0.2)"); line2.setAttribute("stroke-dasharray", "4");
            this.svgLayerEl.appendChild(line2);
          }
        }
        return;
      }

      const wrapper = this.elementsLayerEl.createDiv({ cls: `mni-el mni-el-${el.type} ${isSelected ? "is-selected" : ""}` });
      wrapper.dataset.id = el.id;
      wrapper.style.left = `${el.x}px`; wrapper.style.top = `${el.y}px`;
      wrapper.style.width = `${el.width}px`; wrapper.style.height = `${el.height}px`;

      if (el.type === "rect") {
        wrapper.style.borderColor = el.stroke;
        wrapper.style.borderWidth = `${el.strokeWidth}px`;
        wrapper.style.backgroundColor = el.fill;
        if (el.borderRadius !== undefined) wrapper.style.borderRadius = `${el.borderRadius}px`;
      } else if (el.type === "text") {
        wrapper.style.color = el.color;
        wrapper.style.fontSize = `${el.fontSize}px`;
        MarkdownRenderer.renderMarkdown(el.text, wrapper, this.noteFile.path, new Component());
      }

      if (isSelected && this.selectedElementIds.size === 1) {
        const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
        handles.forEach(h => {
          let cx = el.x, cy = el.y;
          if (h.includes("e")) cx = el.x + el.width;
          else if (h !== "nw" && h !== "w" && h !== "sw") cx = el.x + el.width / 2;
          
          if (h.includes("s")) cy = el.y + el.height;
          else if (h !== "nw" && h !== "n" && h !== "ne") cy = el.y + el.height / 2;

          const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          circle.setAttribute("cx", cx.toString());
          circle.setAttribute("cy", cy.toString());
          circle.setAttribute("r", "5");
          circle.setAttribute("fill", "#e5a158");
          circle.setAttribute("stroke", "#fff");
          circle.setAttribute("stroke-width", "1.5");
          circle.classList.add("mni-resize-handle");
          circle.dataset.handle = h;
          circle.dataset.id = el.id;
          this.svgLayerEl.appendChild(circle);
        });
      }
    });
  }

  private applyTransform(): void {
    if (!this.layerEl) return;
    this.layerEl.style.transform = `translate3d(${this.panX}px, ${this.panY}px, 0) scale(${this.scale})`;
  }

  private fitToScreen(): void {
    if (!this.imgEl || !this.viewportEl) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const imgW = this.imgEl.naturalWidth || 1, imgH = this.imgEl.naturalHeight || 1;
    const pad = 40;
    const availW = Math.max(100, rect.width - pad * 2), availH = Math.max(100, rect.height - pad * 2);
    const fitScale = Math.min(availW / imgW, availH / imgH, 1.5);
    this.scale = Math.max(0.1, Number(fitScale.toFixed(2)));
    this.panX = Math.round((rect.width - imgW * this.scale) / 2);
    this.panY = Math.round((rect.height - imgH * this.scale) / 2);
    this.applyTransform();
  }

  private bindKeyboardEvents() {
    this.keyHandler = (e: KeyboardEvent) => {
      if (!this.containerEl.isConnected) return;
      const isInput = ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName);
      if (isInput) return;

      if (e.key.toLowerCase() === "v") this.setTool("select");
      if (e.key.toLowerCase() === "h") this.setTool("pan");
      if (e.key.toLowerCase() === "r") this.setTool("rect");
      if (e.key.toLowerCase() === "a") this.setTool("arrow");
      if (e.key.toLowerCase() === "t") this.setTool("text");

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
      }

      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedElementIds.size > 0) {
        e.preventDefault(); this.deleteSelected();
      }
    };
    window.addEventListener("keydown", this.keyHandler);
  }

  private deleteSelected() {
    const curImg = this.images[this.activeIndex];
    if (!curImg || this.selectedElementIds.size === 0) return;
    const list = this.elementsByImageName.get(curImg.name) || [];
    this.elementsByImageName.set(curImg.name, list.filter(el => !this.selectedElementIds.has(el.id)));
    this.selectedElementIds.clear();
    this.lastSelectedId = null;
    this.updateDeleteButton();
    this.updatePropertiesPanel();
    this.renderElements();
    this.commitHistory();
  }

  private getElementBBox(el: CanvasElement) {
    if (el.type === "arrow") {
      return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), width: Math.abs(el.x1 - el.x2), height: Math.abs(el.y1 - el.y2) };
    }
    return { x: el.x, y: el.y, width: el.width, height: el.height };
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
      if ((e.target as HTMLElement).closest(".mni-toolbar, .mni-topbar, .mni-bottombar, .mni-properties-panel")) return;

      this.modalEl.focus();
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pointerMoved = false;

      if (this.currentTool === "select") {
        const svgTarget = e.target as SVGElement;
        const clickedEl = (e.target as HTMLElement).closest(".mni-el, .mni-el-svg") as HTMLElement | SVGElement;

        if (svgTarget.classList.contains("mni-resize-handle")) {
          this.isResizing = true;
          this.activeResizeHandle = svgTarget.dataset.handle as any;
          this.selectedElementIds.clear();
          this.selectedElementIds.add(svgTarget.dataset.id || "");
          this.lastSelectedId = svgTarget.dataset.id || null;
          
          const curImg = this.images[this.activeIndex];
          if (curImg) {
            const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.lastSelectedId);
            // ФИКС: Проверяем, что el — не стрелка, прежде чем читать x/y/width/height
            if (el && el.type !== "arrow") {
              this.resizeStartBBox = { 
                x: el.x, y: el.y, w: el.width, h: el.height, 
                fontSize: (el as TextElement).fontSize || 16 
              };
              this.dragStartPoint = this.getImageCoords(e.clientX, e.clientY);
            }
          }
          return;
        }

        if (svgTarget.classList.contains("mni-arrow-handle")) {
          this.isDraggingHandle = true;
          this.draggedHandleType = svgTarget.dataset.handle as any;
          this.selectedElementIds.clear();
          this.selectedElementIds.add(svgTarget.dataset.id || "");
          this.lastSelectedId = svgTarget.dataset.id || null;
          return;
        }

        if (clickedEl) {
          const clickedId = clickedEl.dataset.id;
          if (clickedId) {
            if (!this.selectedElementIds.has(clickedId)) {
              this.selectedElementIds.clear();
              this.selectedElementIds.add(clickedId);
            }
            this.lastSelectedId = clickedId;
            this.updateDeleteButton();
            this.updatePropertiesPanel();
            this.renderElements();
            
            this.isDraggingEl = true;
            this.dragStartPoint = this.getImageCoords(e.clientX, e.clientY);
            this.groupDragStartPositions.clear();
            
            const curImg = this.images[this.activeIndex];
            if (curImg) {
              const list = this.elementsByImageName.get(curImg.name) || [];
              this.selectedElementIds.forEach(id => {
                const el = list.find(x => x.id === id);
                if (el) {
                  if (el.type === "arrow") {
                    this.groupDragStartPositions.set(id, { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 });
                  } else {
                    this.groupDragStartPositions.set(id, { x: el.x, y: el.y });
                  }
                }
              });
            }
          }
          return;
        } else {
          this.isMarquee = true;
          this.marqueeStart = this.getImageCoords(e.clientX, e.clientY);
          this.selectedElementIds.clear();
          this.lastSelectedId = null;
          this.marqueeEl = this.elementsLayerEl.createDiv({ cls: "mni-marquee" });
          this.marqueeEl.style.left = `${this.marqueeStart.x}px`;
          this.marqueeEl.style.top = `${this.marqueeStart.y}px`;
          this.marqueeEl.style.width = "0px";
          this.marqueeEl.style.height = "0px";
          this.updateDeleteButton();
          this.updatePropertiesPanel();
          this.renderElements();
          if (this.marqueeEl) this.elementsLayerEl.appendChild(this.marqueeEl);
          return;
        }
      }

      if (this.currentTool !== "pan" && this.activePointers.size === 1) {
        this.isDrawing = true;
        const coords = this.getImageCoords(e.clientX, e.clientY);
        this.drawStartPoint = coords;

        if (this.currentTool === "rect") {
          this.previewEl = this.elementsLayerEl.createDiv({ cls: "mni-el mni-el-rect is-preview" });
          this.previewEl.style.left = `${coords.x}px`; this.previewEl.style.top = `${coords.y}px`;
          this.previewEl.style.width = "0px"; this.previewEl.style.height = "0px";
          this.previewEl.style.borderColor = "#e5a158"; this.previewEl.style.borderWidth = "2px";
          this.previewEl.style.backgroundColor = "rgba(229, 161, 88, 0.1)";
        } else if (this.currentTool === "arrow") {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", `M ${coords.x} ${coords.y} L ${coords.x} ${coords.y}`);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", "#e5a158"); path.setAttribute("stroke-width", "2");
          path.setAttribute("marker-end", "url(#mni-head-end)");
          path.classList.add("mni-el-svg-preview");
          this.svgLayerEl.appendChild(path);
          this.previewEl = path;
        }
        return;
      }

      if (this.activePointers.size === 1 && !this.isDraggingEl && !this.isDraggingHandle && !this.isMarquee && !this.isResizing) {
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

      if (Math.abs(e.clientX - this.startPanPoint.x) > 4 || Math.abs(e.clientY - this.startPanPoint.y) > 4) pointerMoved = true;

      if (this.isResizing && this.lastSelectedId && this.activeResizeHandle) {
        const curImg = this.images[this.activeIndex];
        if (!curImg) return;
        const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.lastSelectedId);
        // ФИКС: Проверяем, что el существует и не стрелка
        if (!el || el.type === "arrow") return;

        const current = this.getImageCoords(e.clientX, e.clientY);
        const dx = current.x - this.dragStartPoint.x;
        const dy = current.y - this.dragStartPoint.y;

        let nx = this.resizeStartBBox.x;
        let ny = this.resizeStartBBox.y;
        let nw = this.resizeStartBBox.w;
        let nh = this.resizeStartBBox.h;

        if (this.activeResizeHandle.includes("w")) { nx = this.resizeStartBBox.x + dx; nw = this.resizeStartBBox.w - dx; }
        if (this.activeResizeHandle.includes("e")) { nw = this.resizeStartBBox.w + dx; }
        if (this.activeResizeHandle.includes("n")) { ny = this.resizeStartBBox.y + dy; nh = this.resizeStartBBox.h - dy; }
        if (this.activeResizeHandle.includes("s")) { nh = this.resizeStartBBox.h + dy; }

        // Пропорциональное масштабирование шрифта для текста (только если тянем за угол)
        if (el.type === "text" && this.activeResizeHandle.length === 2) {
          const scaleX = nw / this.resizeStartBBox.w;
          const scaleY = nh / this.resizeStartBBox.h;
          const scale = Math.max(scaleX, scaleY);
          
          el.fontSize = Math.max(8, this.resizeStartBBox.fontSize * scale);
          nh = this.resizeStartBBox.h * scale;
          
          if (this.activeResizeHandle.includes("n")) {
            ny = this.resizeStartBBox.y + this.resizeStartBBox.h - nh;
          }
        }

        el.x = nx;
        el.y = ny;
        el.width = Math.max(20, nw);
        el.height = Math.max(20, nh);

        this.renderElements();
        return;
      }

      if (this.isMarquee && this.marqueeEl) {
        const current = this.getImageCoords(e.clientX, e.clientY);
        const x = Math.min(this.marqueeStart.x, current.x), y = Math.min(this.marqueeStart.y, current.y);
        const w = Math.abs(this.marqueeStart.x - current.x), h = Math.abs(this.marqueeStart.y - current.y);
        
        this.marqueeEl.style.left = `${x}px`; this.marqueeEl.style.top = `${y}px`;
        this.marqueeEl.style.width = `${w}px`; this.marqueeEl.style.height = `${h}px`;
        
        const curImg = this.images[this.activeIndex];
        if (curImg) {
          const list = this.elementsByImageName.get(curImg.name) || [];
          this.selectedElementIds.clear();
          list.forEach(el => {
            const bbox = this.getElementBBox(el);
            if (!(x > bbox.x + bbox.width || x + w < bbox.x || y > bbox.y + bbox.height || y + h < bbox.y)) {
              this.selectedElementIds.add(el.id);
            }
          });
          this.elementsLayerEl.querySelectorAll('.mni-el').forEach(node => {
            const htmlEl = node as HTMLElement;
            htmlEl.classList.toggle('is-selected', this.selectedElementIds.has(htmlEl.dataset.id || ''));
          });
          this.svgLayerEl.querySelectorAll('.mni-el-svg').forEach(node => {
            const svgEl = node as SVGElement;
            svgEl.classList.toggle('is-selected', this.selectedElementIds.has(svgEl.dataset.id || ''));
            svgEl.setAttribute("stroke", this.selectedElementIds.has(svgEl.dataset.id || '') ? "#ffffff" : "#e5a158");
          });
          this.lastSelectedId = this.selectedElementIds.size > 0 ? (Array.from(this.selectedElementIds)[0] || null) : null;
          this.updateDeleteButton();
        }
        return;
      }

      if (this.isDraggingHandle && this.lastSelectedId && this.draggedHandleType) {
        const curImg = this.images[this.activeIndex];
        if (!curImg) return;
        const el = this.elementsByImageName.get(curImg.name)?.find(x => x.id === this.lastSelectedId) as ArrowElement;
        if (el && el.type === "arrow") {
          const current = this.getImageCoords(e.clientX, e.clientY);
          
          if (this.draggedHandleType === "start") {
            el.x1 = current.x; el.y1 = current.y;
            const rects = (this.elementsByImageName.get(curImg.name) || []).filter(x => x.type === "rect") as RectElement[];
            let bestDist = 30;
            let bestAnchor: {id: string, anchor: AnchorType, x: number, y: number} | null = null;

            for (const r of rects) {
              for (const anc of ["top", "bottom", "left", "right"] as AnchorType[]) {
                const pt = this.getAnchorPoint(r, anc);
                const dist = Math.hypot(current.x - pt.x, current.y - pt.y);
                if (dist < bestDist) { bestDist = dist; bestAnchor = { id: r.id, anchor: anc, x: pt.x, y: pt.y }; }
              }
            }
            if (bestAnchor) { el.x1 = bestAnchor.x; el.y1 = bestAnchor.y; el.startElementId = bestAnchor.id; el.startAnchor = bestAnchor.anchor; }
            else { el.startElementId = undefined; el.startAnchor = undefined; }
          } else if (this.draggedHandleType === "end") {
            el.x2 = current.x; el.y2 = current.y;
            const rects = (this.elementsByImageName.get(curImg.name) || []).filter(x => x.type === "rect") as RectElement[];
            let bestDist = 30;
            let bestAnchor: {id: string, anchor: AnchorType, x: number, y: number} | null = null;

            for (const r of rects) {
              for (const anc of ["top", "bottom", "left", "right"] as AnchorType[]) {
                const pt = this.getAnchorPoint(r, anc);
                const dist = Math.hypot(current.x - pt.x, current.y - pt.y);
                if (dist < bestDist) { bestDist = dist; bestAnchor = { id: r.id, anchor: anc, x: pt.x, y: pt.y }; }
              }
            }
            if (bestAnchor) { el.x2 = bestAnchor.x; el.y2 = bestAnchor.y; el.endElementId = bestAnchor.id; el.endAnchor = bestAnchor.anchor; }
            else { el.endElementId = undefined; el.endAnchor = undefined; }
          } else if (this.draggedHandleType === "curve1") {
            el.cx1 = current.x; el.cy1 = current.y;
          } else if (this.draggedHandleType === "curve2") {
            el.cx2 = current.x; el.cy2 = current.y;
          }
          this.renderElements();
        }
        return;
      }

      if (this.isDraggingEl && this.groupDragStartPositions.size > 0) {
        const curImg = this.images[this.activeIndex];
        if (!curImg) return;
        const list = this.elementsByImageName.get(curImg.name) || [];
        const current = this.getImageCoords(e.clientX, e.clientY);
        const dx = current.x - this.dragStartPoint.x, dy = current.y - this.dragStartPoint.y;

        this.selectedElementIds.forEach(id => {
          const el = list.find(x => x.id === id);
          const start = this.groupDragStartPositions.get(id);
          if (el && start) {
            if (el.type === "arrow") {
              el.x1 = start.x1 + dx; el.y1 = start.y1 + dy;
              el.x2 = start.x2 + dx; el.y2 = start.y2 + dy;
              if (el.cx1 !== undefined) { el.cx1 = start.cx1 + dx; el.cy1 = start.cy1 + dy; }
              if (el.cx2 !== undefined) { el.cx2 = start.cx2 + dx; el.cy2 = start.cy2 + dy; }
            } else {
              el.x = start.x + dx; el.y = start.y + dy;
            }
          }
        });
        this.syncArrowsToBlocks();
        this.renderElements();
        return;
      }

      if (this.isDrawing && this.previewEl) {
        const current = this.getImageCoords(e.clientX, e.clientY);
        
        if (this.currentTool === "rect") {
          const width = Math.abs(current.x - this.drawStartPoint.x), height = Math.abs(current.y - this.drawStartPoint.y);
          const left = Math.min(current.x, this.drawStartPoint.x), top = Math.min(current.y, this.drawStartPoint.y);
          (this.previewEl as HTMLElement).style.left = `${left}px`;
          (this.previewEl as HTMLElement).style.top = `${top}px`;
          (this.previewEl as HTMLElement).style.width = `${width}px`;
          (this.previewEl as HTMLElement).style.height = `${height}px`;
        } else if (this.currentTool === "arrow") {
          let snapX = current.x, snapY = current.y;
          const curImg = this.images[this.activeIndex];
          if (curImg) {
            const rects = (this.elementsByImageName.get(curImg.name) || []).filter(x => x.type === "rect") as RectElement[];
            let bestDist = 30;
            let bestAnchor: {x: number, y: number} | null = null;
            for (const r of rects) {
              for (const anc of ["top", "bottom", "left", "right"] as AnchorType[]) {
                const pt = this.getAnchorPoint(r, anc);
                const dist = Math.hypot(current.x - pt.x, current.y - pt.y);
                if (dist < bestDist) { bestDist = dist; bestAnchor = pt; }
              }
            }
            if (bestAnchor) { snapX = bestAnchor.x; snapY = bestAnchor.y; }
          }
          const path = this.previewEl as SVGPathElement;
          path.setAttribute("d", `M ${this.drawStartPoint.x} ${this.drawStartPoint.y} L ${snapX} ${snapY}`);
        }
        return;
      }

      if (this.isPanning && this.activePointers.size === 1) {
        const moveDx = e.clientX - this.startPanPoint.x, moveDy = e.clientY - this.startPanPoint.y;
        this.panX = this.startTransform.x + moveDx; this.panY = this.startTransform.y + moveDy;
        this.applyTransform();
        return;
      }

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

      if (this.isResizing) {
        this.isResizing = false;
        this.activeResizeHandle = null;
        this.commitHistory();
        return;
      }

      if (this.isMarquee) {
        this.isMarquee = false;
        if (this.marqueeEl) { this.marqueeEl.remove(); this.marqueeEl = null; }
        this.updatePropertiesPanel();
        this.updateDeleteButton();
        this.renderElements();
        return;
      }

      if (this.isDraggingHandle) {
        this.isDraggingHandle = false;
        this.draggedHandleType = null;
        this.commitHistory();
        return;
      }

      if (this.isDraggingEl) {
        this.isDraggingEl = false;
        this.groupDragStartPositions.clear();
        if (pointerMoved) this.commitHistory();
        return;
      }

      if (this.isDrawing && this.previewEl) {
        this.isDrawing = false;
        const current = this.getImageCoords(e.clientX, e.clientY);
        const curImg = this.images[this.activeIndex];
        
        if (curImg) {
          const list = this.elementsByImageName.get(curImg.name) || [];
          if (this.currentTool === "rect") {
            const width = Math.abs(current.x - this.drawStartPoint.x), height = Math.abs(current.y - this.drawStartPoint.y);
            const left = Math.min(current.x, this.drawStartPoint.x), top = Math.min(current.y, this.drawStartPoint.y);
            if (width > 10 && height > 10) {
              const newRect: RectElement = { id: `rect_${Date.now()}`, type: "rect", x: left, y: top, width, height, stroke: "#e5a158", strokeWidth: 2, fill: "rgba(229, 161, 88, 0.1)", borderRadius: 0 };
              list.push(newRect);
              this.elementsByImageName.set(curImg.name, list);
              this.commitHistory();
            }
          } else if (this.currentTool === "arrow") {
            const dist = Math.hypot(current.x - this.drawStartPoint.x, current.y - this.drawStartPoint.y);
            if (dist > 10) {
              let finalX = current.x, finalY = current.y;
              let endId = undefined, endAnc = undefined;

              const rects = list.filter(x => x.type === "rect") as RectElement[];
              let bestDist = 30;
              let bestAnchor: {id: string, anchor: AnchorType, x: number, y: number} | null = null;
              
              for (const r of rects) {
                for (const anc of ["top", "bottom", "left", "right"] as AnchorType[]) {
                  const pt = this.getAnchorPoint(r, anc);
                  const dist = Math.hypot(current.x - pt.x, current.y - pt.y);
                  if (dist < bestDist) { bestDist = dist; bestAnchor = { id: r.id, anchor: anc, x: pt.x, y: pt.y }; }
                }
              }
              if (bestAnchor) { finalX = bestAnchor.x; finalY = bestAnchor.y; endId = bestAnchor.id; endAnc = bestAnchor.anchor; }

              const newArrow: ArrowElement = {
                id: `arrow_${Date.now()}`, type: "arrow",
                x1: this.drawStartPoint.x, y1: this.drawStartPoint.y, x2: finalX, y2: finalY,
                routing: "straight", startHead: "none", endHead: "arrow",
                endElementId: endId, endAnchor: endAnc as AnchorType | undefined,
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

  private spawnTextInput(clientX: number, clientY: number, editElementId?: string) {
    const curImg = this.images[this.activeIndex];
    if (!curImg) return;
    const list = this.elementsByImageName.get(curImg.name) || [];
    
    let initialText = "";
    let coords = this.getImageCoords(clientX, clientY);
    let initialFontSize = Math.max(12, Math.round(16 / this.scale));
    let initialWidth = Math.max(100, Math.round(200 / this.scale));

    if (editElementId) {
      const existing = list.find(el => el.id === editElementId) as TextElement | undefined;
      if (existing) { 
        initialText = existing.text; 
        coords = { x: existing.x, y: existing.y }; 
        initialFontSize = existing.fontSize;
        initialWidth = existing.width;
      }
    }

    const wrapper = this.elementsLayerEl.createDiv({ cls: "mni-el-input-wrapper" });
    wrapper.style.left = `${coords.x}px`; 
    wrapper.style.top = `${coords.y}px`;
    wrapper.style.width = `${initialWidth}px`;
    
    const textarea = wrapper.createEl("textarea", { cls: "mni-text-input" });
    textarea.value = initialText;
    textarea.style.fontSize = `${initialFontSize}px`;
    textarea.focus();

    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
      wrapper.style.height = textarea.scrollHeight + "px";
    });
    if (initialText) {
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
      wrapper.style.height = textarea.scrollHeight + "px";
    }

    const finishEditing = () => {
      const text = textarea.value.trim();
      
      const finalWidth = wrapper.offsetWidth || initialWidth;
      const finalHeight = wrapper.offsetHeight || 40;
      
      wrapper.remove();
      
      if (!text) { 
        if (editElementId) { this.selectedElementIds.delete(editElementId); this.deleteSelected(); } 
        return; 
      }

      if (editElementId) {
        const existing = list.find(el => el.id === editElementId);
        if (existing && existing.type === "text") {
          existing.text = text;
          existing.width = finalWidth;
          existing.height = finalHeight;
        }
      } else {
        const newText: TextElement = { 
          id: `text_${Date.now()}`, type: "text", 
          x: coords.x, y: coords.y, 
          width: finalWidth, height: finalHeight, 
          text, fontSize: initialFontSize, color: "#ffffff" 
        };
        list.push(newText);
      }
      
      this.elementsByImageName.set(curImg.name, list);
      this.commitHistory();
      this.renderElements();
    };

    textarea.addEventListener("blur", finishEditing);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); textarea.blur(); }
      if (e.key === "Escape") { textarea.value = ""; textarea.blur(); }
    });
  }

  private getImageCoords(clientX: number, clientY: number): { x: number, y: number } {
    const rect = this.imgEl.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.scale, y: (clientY - rect.top) / this.scale };
  }

  private zoomAtPoint(clientX: number, clientY: number, factor: number): void {
    const nextScale = Math.max(0.1, Math.min(6.0, this.scale * factor));
    const rect = this.viewportEl.getBoundingClientRect();
    const originX = clientX - rect.left, originY = clientY - rect.top;
    this.panX = originX - (originX - this.panX) * (nextScale / this.scale);
    this.panY = originY - (originY - this.panY) * (nextScale / this.scale);
    this.scale = nextScale;
    this.applyTransform();
  }

  private getPinchDistance(): number {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2 || !pts[0] || !pts[1]) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private getPinchCenter(): { x: number; y: number } {
    const pts = Array.from(this.activePointers.values());
    if (pts.length < 2 || !pts[0] || !pts[1]) return { x: 0, y: 0 };
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  onClose(): void {
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = undefined;
    }
    this.manager.saveElements(this.elementsByImageName).catch(() => {});
    this.contentEl.empty();
  }
}