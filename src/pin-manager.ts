import { App, TFile, Notice } from "obsidian";
import { CanvasElement, NodePin, TextElement } from "./types";

export class AnnotationManager {
  private app: App;
  private file: TFile;

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
        resultMap.set(imgName, elements as CanvasElement[]);
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
        rawToSave[imgName] = list.map(el => ({
          ...el,
          x: Math.round(el.x),
          y: Math.round(el.y),
          width: Math.round(el.width),
          height: Math.round(el.height)
        }));
      }
    }

    try {
      await this.app.fileManager.processFrontMatter(this.file, fm => {
        if (Object.keys(rawToSave).length === 0) {
          delete fm["схемы_аннотации"];
        } else {
          fm["схемы_аннотации"] = rawToSave;
        }
      });
    } catch (e) {
      new Notice("Ошибка сохранения аннотаций: " + (e instanceof Error ? e.message : String(e)));
    }
  }
}