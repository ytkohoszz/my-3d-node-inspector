import { TFile } from "obsidian";

export interface NodePin {
  id: number;
  x: number;
  y: number;
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
