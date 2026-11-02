import { App, Modal, TFile, Notice } from "obsidian";
import { NodeImageItem, NodePin } from "./types";

export class NodeInspectorModal extends Modal {
  private noteFile: TFile;
  private images: NodeImageItem[] = [];
  private activeIndex: number = 0;
  private currentTitle: string = "";

  // Трансформация холста
  private scale: number = 1;
  private panX: number = 0;
  private panY: number = 0;

  // Жесты Pointer Events
  private activePointers: Map<number, { x: number; y: number }> = new Map();
  private prevPinchDistance: number | null = null;
  private isPanning: boolean = false;
  private startPanPoint: { x: number; y: number } = { x: 0, y: 0 };
  private startTransform: { x: number; y: number } = { x: 0, y: 0 };

  // Режим аннотаций-пинов
  private isPinMode: boolean = false;
  private pinsByImageName: Map<string, NodePin[]> = new Map();

  private layerEl!: HTMLElement;
  private imgEl!: HTMLImageElement;
  private pinsLayerEl!: HTMLElement;
  private viewportEl!: HTMLElement;
  private scaleBadgeEl!: HTMLElement;
  private pinToggleBtn!: HTMLElement;

  constructor(app: App, noteFile: TFile, images: NodeImageItem[], title: string, initialIndex: number = 0) {
    super(app);
    this.noteFile = noteFile;
    this.images = images;
    this.currentTitle = title;
    this.activeIndex = Math.max(0, Math.min(images.length - 1, initialIndex));
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass("mod-3d-node-inspector");
    contentEl.empty();

    await this.loadPinsFromFrontmatter();

    const container = contentEl.createDiv({ cls: "mni-container" });

    // 1. Верхняя панель
    const topbar = container.createDiv({ cls: "mni-topbar" });
    const titleBox = topbar.createDiv({ cls: "mni-title-box" });
    titleBox.createSpan({ cls: "mni-icon", text: "☊" });
    titleBox.createSpan({ cls: "mni-title", text: this.currentTitle });

    const actions = topbar.createDiv({ cls: "mni-top-actions" });

    // Кнопка переключения режима пина
    this.pinToggleBtn = actions.createEl("button", {
      cls: "mni-btn mni-pin-toggle",
      text: "📍 Пин",
      attr: { type: "button", title: "Режим добавления меток-пинов" }
    });
    this.pinToggleBtn.onclick = () => this.togglePinMode();

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

    // 2. Вьюпорт и трансформируемый слой
    this.viewportEl = container.createDiv({ cls: "mni-viewport" });
    this.layerEl = this.viewportEl.createDiv({ cls: "mni-canvas-layer" });

    if (this.images.length === 0) {
      container.createDiv({
        cls: "mni-empty-msg",
        text: "В этой заметке не найдено прикреплённых скриншотов нод."
      });
      return;
    }

    this.imgEl = this.layerEl.createEl("img", { cls: "mni-image" });
    this.pinsLayerEl = this.layerEl.createDiv({ cls: "mni-pins-layer" });

    this.imgEl.onload = () => {
      this.syncPinsLayerSize();
      this.renderPins();
      this.fitToScreen();
    };
    this.loadActiveImage();

    // 3. Обработка жестов и кликов для добавления пинов
    this.bindPointerEvents(this.viewportEl);

    // 4. Нижняя панель переключения скриншотов
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

  private async loadPinsFromFrontmatter(): Promise<void> {
    const cache = this.app.metadataCache.getFileCache(this.noteFile);
    const rawMap = (cache?.frontmatter?.["схемы_пины"] || {}) as Record<string, unknown>;
    this.pinsByImageName.clear();

    for (const [imgName, pinsRaw] of Object.entries(rawMap)) {
      if (Array.isArray(pinsRaw)) {
        const validPins: NodePin[] = [];
        pinsRaw.forEach((p, idx) => {
          if (p && typeof p === "object") {
            const pinObj = p as Record<string, unknown>;
            const x = Number(pinObj.x);
            const y = Number(pinObj.y);
            const text = String(pinObj.текст || pinObj.text || "").trim();
            if (Number.isFinite(x) && Number.isFinite(y)) {
              validPins.push({
                id: Number(pinObj.id) || idx + 1,
                x: Math.max(0, Math.min(1, x)),
                y: Math.max(0, Math.min(1, y)),
                text: text || "Метка " + (idx + 1)
              });
            }
          }
        });
        this.pinsByImageName.set(imgName, validPins);
      }
    }
  }

  private async savePinsToFrontmatter(): Promise<void> {
    const rawToSave: Record<string, Array<{ id: number; x: number; y: number; текст: string }>> = {};
    for (const [imgName, list] of this.pinsByImageName.entries()) {
      if (list.length > 0) {
        rawToSave[imgName] = list.map(p => ({
          id: p.id,
          x: Math.round(p.x * 1000) / 1000,
          y: Math.round(p.y * 1000) / 1000,
          текст: p.text
        }));
      }
    }

    try {
      await this.app.fileManager.processFrontMatter(this.noteFile, fm => {
        if (Object.keys(rawToSave).length === 0) {
          delete fm["схемы_пины"];
        } else {
          fm["схемы_пины"] = rawToSave;
        }
      });
    } catch (e) {
      new Notice("Ошибка сохранения пинов: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  private togglePinMode(): void {
    this.isPinMode = !this.isPinMode;
    this.pinToggleBtn.classList.toggle("is-active", this.isPinMode);
    this.viewportEl.classList.toggle("is-pin-mode", this.isPinMode);
    if (this.isPinMode) {
      new Notice("Тапни в любое место схемы нод, чтобы поставить метку.");
    }
  }

  private syncPinsLayerSize(): void {
    if (!this.imgEl || !this.pinsLayerEl) return;
    const w = this.imgEl.naturalWidth || 800;
    const h = this.imgEl.naturalHeight || 600;
    this.pinsLayerEl.style.width = `${w}px`;
    this.pinsLayerEl.style.height = `${h}px`;
  }

  private renderPins(): void {
    if (!this.pinsLayerEl) return;
    this.pinsLayerEl.empty();

    const curImg = this.images[this.activeIndex];
    if (!curImg) return;

    const pins = this.pinsByImageName.get(curImg.name) || [];

    pins.forEach(pin => {
      const pinWrapper = this.pinsLayerEl.createDiv({ cls: "mni-pin-wrap" });
      pinWrapper.style.left = `${(pin.x * 100).toFixed(2)}%`;
      pinWrapper.style.top = `${(pin.y * 100).toFixed(2)}%`;

      const marker = pinWrapper.createEl("button", {
        cls: "mni-pin-marker",
        text: String(pin.id),
        attr: { type: "button", title: pin.text }
      });

      marker.onclick = (e) => {
        e.stopPropagation();
        this.openPinCard(pinWrapper, pin, curImg.name);
      };
    });
  }

  private openPinCard(parentWrapper: HTMLElement, pin: NodePin, imgName: string): void {
    this.viewportEl.querySelectorAll(".mni-pin-card").forEach(el => el.remove());

    const card = parentWrapper.createDiv({ cls: "mni-pin-card" });
    card.onclick = (e) => e.stopPropagation();

    const head = card.createDiv({ cls: "mni-pin-card-head" });
    head.createSpan({ cls: "mni-pin-card-badge", text: `Метка ${pin.id}` });

    const closeCardBtn = head.createEl("button", { cls: "mni-pin-action-btn", text: "✕", attr: { type: "button" } });
    closeCardBtn.onclick = () => card.remove();

    card.createDiv({ cls: "mni-pin-card-body", text: pin.text });

    const actions = card.createDiv({ cls: "mni-pin-card-actions" });

    const editBtn = actions.createEl("button", { cls: "mni-pin-action-btn", text: "✎ Изменить", attr: { type: "button" } });
    editBtn.onclick = () => {
      card.empty();
      const editInput = card.createEl("textarea", { cls: "mni-pin-edit-input" });
      editInput.value = pin.text;
      const actRow = card.createDiv({ cls: "mni-pin-card-actions" });

      const saveBtn = actRow.createEl("button", { cls: "mni-pin-action-btn", text: "Сохранить", attr: { type: "button" } });
      saveBtn.onclick = async () => {
        pin.text = editInput.value.trim() || `Метка ${pin.id}`;
        card.remove();
        this.renderPins();
        await this.savePinsToFrontmatter();
      };

      const cancelBtn = actRow.createEl("button", { cls: "mni-pin-action-btn", text: "Отмена", attr: { type: "button" } });
      cancelBtn.onclick = () => card.remove();
      editInput.focus();
    };

    const delBtn = actions.createEl("button", { cls: "mni-pin-action-btn is-danger", text: "Удалить", attr: { type: "button" } });
    delBtn.onclick = async () => {
      const list = this.pinsByImageName.get(imgName) || [];
      const updated = list.filter(p => p.id !== pin.id);
      this.pinsByImageName.set(imgName, updated);
      card.remove();
      this.renderPins();
      await this.savePinsToFrontmatter();
    };
  }

  private async handleCreatePin(relX: number, relY: number): Promise<void> {
    const curImg = this.images[this.activeIndex];
    if (!curImg) return;

    const list = this.pinsByImageName.get(curImg.name) || [];
    const nextId = list.length > 0 ? Math.max(...list.map(p => p.id)) + 1 : 1;

    const promptModal = new PinPromptModal(this.app, nextId, async (noteText) => {
      if (!noteText) return;
      const newPin: NodePin = {
        id: nextId,
        x: relX,
        y: relY,
        text: noteText
      };
      list.push(newPin);
      this.pinsByImageName.set(curImg.name, list);
      this.renderPins();
      await this.savePinsToFrontmatter();
      this.togglePinMode();
    });
    promptModal.open();
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
    let pointerDownTime = 0;
    let pointerMoved = false;

    target.addEventListener("pointerdown", (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".mni-pin-card, .mni-pin-marker")) return;

      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      pointerDownTime = Date.now();
      pointerMoved = false;

      if (this.activePointers.size === 1) {
        this.isPanning = !this.isPinMode;
        if (this.isPanning) target.classList.add("is-dragging");
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

      if (this.isPanning && this.activePointers.size === 1) {
        const moveDx = e.clientX - this.startPanPoint.x;
        const moveDy = e.clientY - this.startPanPoint.y;
        this.panX = this.startTransform.x + moveDx;
        this.panY = this.startTransform.y + moveDy;
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

    const onPointerEnd = (e: PointerEvent) => {
      const wasPinClick = this.isPinMode && !pointerMoved && (Date.now() - pointerDownTime < 350);
      this.activePointers.delete(e.pointerId);

      if (this.activePointers.size < 2) {
        this.prevPinchDistance = null;
      }
      if (this.activePointers.size === 1) {
        const remaining = Array.from(this.activePointers.values())[0];
        if (remaining) {
          this.isPanning = !this.isPinMode;
          this.startPanPoint = { x: remaining.x, y: remaining.y };
          this.startTransform = { x: this.panX, y: this.panY };
        }
      } else if (this.activePointers.size === 0) {
        this.isPanning = false;
        target.classList.remove("is-dragging");
      }

      if (wasPinClick && this.imgEl) {
        const rect = this.imgEl.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          const relX = (e.clientX - rect.left) / rect.width;
          const relY = (e.clientY - rect.top) / rect.height;
          this.handleCreatePin(relX, relY);
        }
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

class PinPromptModal extends Modal {
  private pinNumber: number;
  private onSubmit: (text: string) => void;

  constructor(app: App, pinNumber: number, onSubmit: (text: string) => void) {
    super(app);
    this.pinNumber = pinNumber;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `📍 Метка ${this.pinNumber} на схеме нод` });

    const input = contentEl.createEl("textarea", {
      attr: {
        placeholder: "Например: Сюда подключается профиль кривой…",
        style: "width: 100%; height: 80px; margin: 10px 0; border-radius: 8px; padding: 8px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); color: var(--text-normal);"
      }
    });

    const actRow = contentEl.createDiv({ attr: { style: "display: flex; gap: 8px; justify-content: flex-end;" } });
    const saveBtn = actRow.createEl("button", { cls: "mod-cta", text: "Поставить метку" });
    saveBtn.onclick = () => {
      const text = input.value.trim();
      this.close();
      this.onSubmit(text);
    };

    const cancelBtn = actRow.createEl("button", { text: "Отмена" });
    cancelBtn.onclick = () => this.close();

    setTimeout(() => input.focus(), 30);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
