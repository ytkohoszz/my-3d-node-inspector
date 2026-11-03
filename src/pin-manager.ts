import { App, TFile, Notice } from "obsidian";
import { CanvasElement, NodePin, TextElement } from "./types";

export class AnnotationManager {
  private app: App;
  private file: TFile;

  constructor(app: App, file: TFile) {
    this.app = app;
    this.file = file;
  }

  /**
   * Загружает аннотации из YAML.
   * Если находит старые пины (схемы_пины), конвертирует их в текстовые аннотации.
   */
  async loadElements(imageWidth: number, imageHeight: number): Promise<Map<string, CanvasElement[]>> {
    const cache = this.app.metadataCache.getFileCache(this.file);
    const frontmatter = cache?.frontmatter || {};
    
    // Новый формат
    const rawAnnotations = (frontmatter["схемы_аннотации"] || {}) as Record<string, unknown>;
    // Старый формат
    const rawPins = (frontmatter["схемы_пины"] || {}) as Record<string, unknown>;

    const resultMap = new Map<string, CanvasElement[]>();
    let needsMigration = false;

    for (const [imgName, elements] of Object.entries(rawAnnotations)) {
      if (Array.isArray(elements)) {
        resultMap.set(imgName, elements as CanvasElement[]);
      }
    }

    // Миграция старых пинов в текстовые блоки
    if (Object.keys(rawPins).length > 0) {
      for (const [imgName, pins] of Object.entries(rawPins)) {
        if (Array.isArray(pins) && !resultMap.has(imgName)) {
          const migratedElements: TextElement[] = pins.map((p, idx) => {
            const oldPin = p as NodePin;
            // Переводим относительные координаты (0..1) в абсолютные пиксели
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
      // Удаляем старый ключ
      await this.app.fileManager.processFrontMatter(this.file, fm => {
        delete fm["схемы_пины"];
      });
      new Notice("Старые пины успешно перенесены в новый формат аннотаций!");
    }

    return resultMap;
  }

  async saveElements(elementsMap: Map<string, CanvasElement[]>): Promise<void> {
    const rawToSave: Record<string, CanvasElement[]> = {};
    
    for (const [imgName, list] of elementsMap.entries()) {
      if (list.length > 0) {
        // Округляем координаты для чистоты YAML
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