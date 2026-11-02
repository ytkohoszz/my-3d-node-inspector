import { TFile } from "obsidian";

export interface NodePin {
  id: number;
  x: number; // 0.0 - 1.0 (относительно оригинальной ширины картинки)
  y: number; // 0.0 - 1.0 (относительно оригинальной высоты картинки)
  text: string;
}

export interface NodeImageItem {
  file: TFile;
  path: string;
  name: string;
  resourcePath: string;
}

export interface InspectorOpenOptions {
  file?: TFile;
  imageIndex?: number;
}
