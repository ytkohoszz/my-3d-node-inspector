import { App, TFile, Notice } from "obsidian";
import { CanvasElement, NodePin, TextElement } from "./types";

export class AnnotationManager {
  private app: App;
  private file: TFile;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(app: App, file: TFile) {
    this.app = app;
    this.file = file;
  }

  async loadElements(imageWidth: number, imageHeight: number): Promise<Map<string, CanvasElement[]>> {
    const cache = this.app.metadataCache.getFileCache(this.file);
    const frontmatter = cache?.frontmatter || {};
    
    const rawAnnotations = (frontmatter["схемы_аннотации"] || {}) as Record<string, unknown>;
    const rawPins = (frontmatter["схемы_пины"] || {}) as Record<string, unknown>;

    const resultMap = new Map<string, CanvasElement[]>();
    let needsMigration = false;

    for (const [imgName, elements] of Object.entries(rawAnnotations)) {
      if (Array.isArray(elements)) {
        // Приводим старые стрелки к новому формату (если они были без routing)
        const typedElements = (elements as CanvasElement[]).map(el => {
          if (el.type === "arrow" && !el.routing) {
            return {
              ...el,
              routing: "straight",
              startHead: "none",
              endHead: "arrow"
            } as CanvasElement;
          }
          return el;
        });
        resultMap.set(imgName, typedElements);
      }
    }

    if (Object.keys(rawPins).length > 0) {
      for (const [imgName, pins] of Object.entries(rawPins)) {
        if (Array.isArray(pins) && !resultMap.has(imgName)) {
          const migratedElements: TextElement[] = pins.map((p, idx) => {
            const oldPin = p as NodePin;
            return {
              id: `migrated_${idx}_${Date.now()}`,
              type: "text",
              x: oldPin.x * imageWidth,
              y: oldPin.y * imageHeight,
              width: 200,
              height: 60,
              text: oldPin.text,
              fontSize: 16,
              color: "#e5a158",
            };
          });
          resultMap.set(imgName, migratedElements);
          needsMigration = true;
        }
      }
    }

    if (needsMigration) {
      await this.saveElements(resultMap);
      await this.app.fileManager.processFrontMatter(this.file, fm => {
        delete fm["схемы_пины"];
      });
      new Notice("Старые пины перенесены в новый формат!");
    }

    return resultMap;
  }

  async saveElements(elementsMap: Map<string, CanvasElement[]>): Promise<void> {
    const rawToSave: Record<string, CanvasElement[]> = {};
    
    for (const [imgName, list] of elementsMap.entries()) {
      if (list.length > 0) {
        rawToSave[imgName] = list.map(el => {
          if (el.type === "arrow") {
            const res: any = { 
              ...el, 
              x1: Math.round(el.x1), y1: Math.round(el.y1), 
              x2: Math.round(el.x2), y2: Math.round(el.y2) 
            };
            if (el.cx1 !== undefined) res.cx1 = Math.round(el.cx1);
            if (el.cy1 !== undefined) res.cy1 = Math.round(el.cy1);
            if (el.cx2 !== undefined) res.cx2 = Math.round(el.cx2);
            if (el.cy2 !== undefined) res.cy2 = Math.round(el.cy2);
            return res;
          } else {
            return { 
              ...el, 
              x: Math.round(el.x), y: Math.round(el.y), 
              width: Math.round(el.width), height: Math.round(el.height) 
            };
          }
        });
      }
    }

    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(async () => {
        await this.app.fileManager.processFrontMatter(this.file, fm => {
          if (Object.keys(rawToSave).length === 0) {
            delete fm["схемы_аннотации"];
          } else {
            fm["схемы_аннотации"] = rawToSave;
          }
        });
      });

    try {
      await this.saveQueue;
    } catch (e) {
      new Notice("Ошибка сохранения аннотаций: " + (e instanceof Error ? e.message : String(e)));
    }
  }
}