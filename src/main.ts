import { Plugin, TFile, Notice, FuzzySuggestModal, App } from "obsidian";
import { NodeInspectorModal } from "./viewer-modal";
import { InspectorOpenOptions, NodeImageItem } from "./types";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

class NoteSelectModal extends FuzzySuggestModal<TFile> {
  private plugin: My3DNodeInspectorPlugin;

  constructor(app: App, plugin: My3DNodeInspectorPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Выбери заметку со скриншотом нод…");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter(file => {
      const cache = this.app.metadataCache.getFileCache(file);
      const embeds = cache?.embeds || [];
      return embeds.some(e => {
        const ext = e.link.split(".").pop()?.toLowerCase() || "";
        return IMAGE_EXTENSIONS.has(ext);
      });
    });
  }

  getItemText(item: TFile): string {
    return item.basename;
  }

  onChooseItem(item: TFile): void {
    this.plugin.openInspector({ file: item });
  }
}

export default class My3DNodeInspectorPlugin extends Plugin {
  async onload(): Promise<void> {
    this.addRibbonIcon("share-2", "3D: Инспектор схем нод", () => {
      this.triggerInspectorFlow();
    });

    this.addCommand({
      id: "open-3d-node-inspector",
      name: "3D: Открыть схему нод (инспектор)",
      callback: () => {
        this.triggerInspectorFlow();
      }
    });

    (window as unknown as Record<string, unknown>).__my3DNodeInspector = this;
  }

  onunload(): void {
    delete (window as unknown as Record<string, unknown>).__my3DNodeInspector;
  }

  private triggerInspectorFlow(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      const images = this.extractImagesFromNote(activeFile);
      if (images.length > 0) {
        this.openInspector({ file: activeFile });
        return;
      }
    }
    new NoteSelectModal(this.app, this).open();
  }

  public openInspector(options: InspectorOpenOptions = {}): void {
    const file = options.file || this.app.workspace.getActiveFile();
    if (!file || !(file instanceof TFile)) {
      new NoteSelectModal(this.app, this).open();
      return;
    }

    const images = this.extractImagesFromNote(file);
    if (images.length === 0) {
      new Notice("В заметке «" + file.basename + "» не найдено прикреплённых картинок.");
      return;
    }

    const modal = new NodeInspectorModal(
      this.app,
      file,
      images,
      file.basename,
      options.imageIndex || 0
    );
    modal.open();
  }

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
