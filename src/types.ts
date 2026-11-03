import { TFile } from "obsidian";

// --- Старые типы (для миграции) ---
export interface NodePin {
  id: number;
  x: number; // 0..1
  y: number; // 0..1
  text: string;
}

// --- Новые типы для аннотаций (Mini-Excalidraw) ---
export type ToolType = "pan" | "text" | "rect";

export interface CanvasElementBase {
  id: string;
  type: "text" | "rect" | "arrow";
  x: number; // Абсолютные пиксели относительно картинки
  y: number;
  width: number;
  height: number;
}

export interface TextElement extends CanvasElementBase {
  type: "text";
  text: string;
  fontSize: number;
  color: string;
}

export interface RectElement extends CanvasElementBase {
  type: "rect";
  stroke: string;
  strokeWidth: number;
  fill: string;
}

export type CanvasElement = TextElement | RectElement;

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

export interface DslSocketLink {
  fromNode: string;
  fromSocket: string;
  toNode: string;
  toSocket: string;
}

export interface ParsedDslGraph {
  nodes: string[];
  links: DslSocketLink[];
}