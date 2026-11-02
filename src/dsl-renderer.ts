import type { ParsedDslGraph } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

const SOCKET_COLORS: Record<string, string> = {
  geometry: "#4aab80",
  mesh: "#4aab80",
  curve: "#4aab80",
  vector: "#5c8df6",
  normal: "#5c8df6",
  position: "#5c8df6",
  color: "#e5a158",
  image: "#e5a158",
  texture: "#e5a158",
  float: "#a0a5af",
  value: "#a0a5af",
  factor: "#a0a5af",
  distance: "#a0a5af",
  radius: "#a0a5af",
  material: "#e06c75",
  shader: "#9c83e8"
};

export function getSocketColor(name: string): string {
  const value = name.trim().toLowerCase();

  for (const [key, color] of Object.entries(SOCKET_COLORS)) {
    if (value.includes(key)) return color;
  }

  return "#a0a5af";
}

function readNodeName(value: string): string | null {
  const text = value.trim();

  if (!text.startsWith("[") || !text.endsWith("]")) {
    return null;
  }

  const name = text.slice(1, -1).trim();

  if (!name || name.includes("[") || name.includes("]")) {
    return null;
  }

  return name;
}

export function parseDslText(source: string): ParsedDslGraph {
  const nodes = new Set<string>();
  const links: ParsedDslGraph["links"] = [];
  const seenLinks = new Set<string>();

  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").trim();

    if (!line || line.startsWith("#") || line.startsWith("//")) {
      continue;
    }

    // Поддерживаются:
    // [A] -> [B]
    // [A] -> Geometry -> [B]
    // [A] : Output -> Input -> [B]
    const parts = line.split("->").map(part => part.trim());

    if (parts.length !== 2 && parts.length !== 3) {
      throw new Error(
        `Строка ${index + 1}: ожидается [A] -> Socket -> [B].`
      );
    }

    let fromPart = parts[0] ?? "";
    const toPart = parts[parts.length - 1] ?? "";

    let explicitOutput: string | null = null;
    const closingBracket = fromPart.indexOf("]");

    if (closingBracket >= 0) {
      const suffix = fromPart.slice(closingBracket + 1).trim();

      if (suffix) {
        if (!suffix.startsWith(":")) {
          throw new Error(
            `Строка ${index + 1}: после [ноды] допустимо : Выход.`
          );
        }

        explicitOutput = suffix.slice(1).trim();

        if (!explicitOutput) {
          throw new Error(
            `Строка ${index + 1}: не указано имя выходного сокета.`
          );
        }

        fromPart = fromPart.slice(0, closingBracket + 1);
      }
    }

    const fromNode = readNodeName(fromPart);
    const toNode = readNodeName(toPart);

    if (fromNode === null || toNode === null) {
      throw new Error(
        `Строка ${index + 1}: названия нод нужно заключить в [скобки].`
      );
    }

    const socket = parts.length === 3 ? parts[1] ?? "" : "";

    if (parts.length === 3 && !socket) {
      throw new Error(
        `Строка ${index + 1}: не указано имя сокета.`
      );
    }

    const fromSocket = explicitOutput ?? (socket || "Out");
    const toSocket = socket || "In";

    nodes.add(fromNode);
    nodes.add(toNode);

    const key = JSON.stringify([
      fromNode,
      fromSocket,
      toNode,
      toSocket
    ]);

    if (seenLinks.has(key)) continue;

    seenLinks.add(key);
    links.push({ fromNode, fromSocket, toNode, toSocket });
  }

  return { nodes: [...nodes], links };
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);

  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }

  return element;
}

export function renderGraphToSvg(
  graph: ParsedDslGraph
): SVGSVGElement {
  const nodeWidth = 200;
  const nodeHeight = 64;
  const columnStep = 280;
  const rowStep = 104;

  const ranks = new Map<string, number>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const name of graph.nodes) {
    ranks.set(name, 0);
    incoming.set(name, 0);
    outgoing.set(name, []);
  }

  for (const link of graph.links) {
    if (
      !incoming.has(link.fromNode) ||
      !incoming.has(link.toNode)
    ) {
      continue;
    }

    outgoing.get(link.fromNode)?.push(link.toNode);
    incoming.set(
      link.toNode,
      (incoming.get(link.toNode) ?? 0) + 1
    );
  }

  // Для ациклической схемы — раскладка по зависимостям.
  const queue = graph.nodes.filter(
    name => incoming.get(name) === 0
  );
  const processed = new Set<string>();

  for (let index = 0; index < queue.length; index++) {
    const name = queue[index];
    if (name === undefined) continue;

    processed.add(name);

    for (const target of outgoing.get(name) ?? []) {
      ranks.set(
        target,
        Math.max(
          ranks.get(target) ?? 0,
          (ranks.get(name) ?? 0) + 1
        )
      );

      const remaining = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, remaining);

      if (remaining === 0) queue.push(target);
    }
  }

  // Циклы не вызывают бесконечного роста рангов.
  // Неразложенную часть выводим в дополнительной колонке.
  const remainingNodes = graph.nodes.filter(
    name => !processed.has(name)
  );

  if (remainingNodes.length > 0) {
    let fallbackRank = 0;

    for (const name of processed) {
      fallbackRank = Math.max(
        fallbackRank,
        (ranks.get(name) ?? 0) + 1
      );
    }

    for (const name of remainingNodes) {
      ranks.set(name, fallbackRank);
    }
  }

  const columns = new Map<number, string[]>();

  for (const name of graph.nodes) {
    const rank = ranks.get(name) ?? 0;
    const column = columns.get(rank) ?? [];
    column.push(name);
    columns.set(rank, column);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let width = 480;
  let height = 160;

  for (const [column, names] of columns) {
    names.forEach((name, row) => {
      const x = 32 + column * columnStep;
      const y = 32 + row * rowStep;

      positions.set(name, { x, y });
      width = Math.max(width, x + nodeWidth + 32);
      height = Math.max(height, y + nodeHeight + 32);
    });
  }

  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "mni-dsl-svg",
    width: "100%",
    role: "img",
    "aria-label": `Схема: ${graph.nodes.length} нод`
  });

  const wires = svgElement("g", { class: "mni-dsl-links" });
  svg.appendChild(wires);

  for (const link of graph.links) {
    const start = positions.get(link.fromNode);
    const end = positions.get(link.toNode);
    if (!start || !end) continue;

    const x1 = start.x + nodeWidth;
    const y1 = start.y + nodeHeight / 2;
    const x2 = end.x;
    const y2 = end.y + nodeHeight / 2;
    const bend = Math.max(48, Math.abs(x2 - x1) * 0.45);

    const wire = svgElement("path", {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      class: "mni-dsl-wire",
      stroke: getSocketColor(link.toSocket)
    });

    const title = svgElement("title", {});
    title.textContent =
      `${link.fromNode}: ${link.fromSocket} → ` +
      `${link.toNode}: ${link.toSocket}`;

    wire.appendChild(title);
    wires.appendChild(wire);
  }

  for (const [name, position] of positions) {
    const group = svgElement("g", {
      transform: `translate(${position.x}, ${position.y})`
    });

    group.appendChild(svgElement("rect", {
      width: String(nodeWidth),
      height: String(nodeHeight),
      rx: "7",
      class: "mni-dsl-node-bg"
    }));

    group.appendChild(svgElement("rect", {
      width: String(nodeWidth),
      height: "18",
      rx: "7",
      class: "mni-dsl-node-head"
    }));

    const title = svgElement("title", {});
    title.textContent = name;
    group.appendChild(title);

    const label = svgElement("text", {
      x: "12",
      y: "42",
      class: "mni-dsl-node-text"
    });

    label.textContent =
      name.length > 26 ? name.slice(0, 25) + "…" : name;

    group.appendChild(label);

    for (const x of [0, nodeWidth]) {
      group.appendChild(svgElement("circle", {
        cx: String(x),
        cy: String(nodeHeight / 2),
        r: "5",
        class: "mni-dsl-socket"
      }));
    }

    svg.appendChild(group);
  }

  return svg;
}
