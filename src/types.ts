import { TFile } from "obsidian";

export interface NodePin {
  id: number;
  x: number;
  y: number;
  text: string;
}

export type ToolType = "pan" | "select" | "text" | "rect" | "arrow";

export type ResizeHandleType = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type ArrowHandleType = "start" | "end" | "curve1" | "curve2";

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasElementBase {
  id: string;
  type: "text" | "rect" | "arrow";
}

export interface TextElement extends CanvasElementBase {
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  fontSize: number;
  color: string;
}

export interface RectElement extends CanvasElementBase {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  fill: string;
  borderRadius?: number;
}

export type ArrowRouting = "straight" | "curved" | "orthogonal";
export type ArrowHead = "none" | "arrow";
export type AnchorType = "top" | "bottom" | "left" | "right";

export interface ArrowElement extends CanvasElementBase {
  type: "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx1?: number;
  cy1?: number;
  cx2?: number;
  cy2?: number;

  routing: ArrowRouting;
  startHead: ArrowHead;
  endHead: ArrowHead;
  stroke: string;
  strokeWidth: number;

  startElementId?: string;
  startAnchor?: AnchorType;
  endElementId?: string;
  endAnchor?: AnchorType;
}

export type CanvasElement = TextElement | RectElement | ArrowElement;

export type ElementDragSnapshot =
  | {
      type: "box";
      x: number;
      y: number;
    }
  | {
      type: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      cx1?: number;
      cy1?: number;
      cx2?: number;
      cy2?: number;
    };

export interface ResizeSnapshot {
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

export interface SnapAnchorMatch {
  id: string;
  anchor: AnchorType;
  x: number;
  y: number;
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