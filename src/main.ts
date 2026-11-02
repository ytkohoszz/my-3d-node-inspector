import { Plugin, TFile, Notice } from "obsidian";
import { NodeInspectorModal } from "./viewer-modal";
import { InspectorOpenOptions, NodeImageItem } from "./types";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

export default class My3DNodeInspectorPlugin extends Plugin {
  async onload(): Promise<void> {
    // Команда для открытия инспектора активной заметки
    this.addCommand({
      id: "open-active-3d-node-inspector",
      name: "3D: Открыть схему нод текущей заметки",
      checkCallback: (checking: boolean) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || activeFile.extension !== "md") return false;
        if (checking) return true;
        this.openInspector({ file: activeFile });
        return true;
      }
    });

    // Регистрация на объекте плагина для быстрого вызова из 3d.js
    (window as unknown as Record<string, unknown>).__my3DNodeInspector = this;
  }

  onunload(): void {
    delete (window as unknown as Record<string, unknown>).__my3DNodeInspector;
  }

  /**
   * Публичный API для вызова из DataviewJS (3d.js) или других плагинов.
   */
  public openInspector(options: InspectorOpenOptions = {}): void {
    const file = options.file || this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile)) {
      new Notice("Открой или выбери заметку со скриншотом нод.");
      return;
    }

    const images = this.extractImagesFromNote(file);
    if (images.length === 0) {
      new Notice("В заметке «" + file.basename + "» нет прикреплённых изображений.");
      return;
    }

    const modal = new NodeInspectorModal(
      this.app,
      images,
      file.basename,
      options.imageIndex || 0
    );
    modal.open();
  }

  /**
   * Сканирует метаданные и тело заметки на вложенные скриншоты.
   */
  public extractImagesFromNote(file: TFile): NodeImageItem[] {
    const items: NodeImageItem[] = [];
    const seen = new Set<string>();

    const cache = this.app.metadataCache.getFileCache(file);
    const embeds = cache?.embeds || [];

    for (const em of embeds) {
      const linkPath = em.link.split("#")[0]?.split("|")[0]?.trim();
      if (!linkPath) continue;

      const targetFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
      if (targetFile && targetFile instanceof TFile && IMAGE_EXTENSIONS.has(targetFile.extension.toLowerCase())) {
        if (!seen.has(targetFile.path)) {
          seen.add(targetFile.path);
          items.push({
            file: targetFile,
            path: targetFile.path,
            name: targetFile.name,
            resourcePath: this.app.vault.adapter.getResourcePath(targetFile.path)
          });
        }
      }
    }

    return items;
  }
}
