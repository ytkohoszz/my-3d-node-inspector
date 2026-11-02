import { TFile } from "obsidian";

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
