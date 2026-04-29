import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import * as d3 from "d3";
import { Copy, Download, Filter, LogOut, Search, Share2, SlidersHorizontal, Trash2, X } from "lucide-react";
import { API_BASE_URL, api, clearToken, getToken } from "./api/client";
import { FriendsPanel } from "./components/FriendsPanel";
import { GraphCanvas } from "./components/GraphCanvas";
import { LoginScreen } from "./components/LoginScreen";
import { PlaylistPanel } from "./components/PlaylistPanel";
import { SyncPanel } from "./components/SyncPanel";
import { LEGAL_VERSION } from "./legal";
import type { Friend, GraphOverlayMatch, GraphResponse, User } from "./types/api";

const overlayPalette = ["#cf4b3f", "#2f6fbd", "#d79b28", "#7b61ff", "#e26d3d", "#139f8f"];
const PENDING_INVITE_CODE_KEY = "music_graph_pending_invite_code";
const SHARE_MAX_GRAPH_PARAMS = {
  limit: "5000",
  min_listens: "1",
  depth: "3",
  edge_types: "collab,catalog_collab,similar"
};

type FriendGraphOverlay = {
  userId: string;
  label: string;
  color: string;
  graph: GraphResponse;
};

type ClusterIslandsPanelProps = {
  graph: GraphResponse | null;
  enabled: boolean;
  activeClusterId: string | null;
  onHoverCluster: (clusterId: string | null) => void;
  onSelectCluster: (clusterId: string | null) => void;
};

function captureRangePointer(event: PointerEvent<HTMLInputElement>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is unavailable for a few synthetic/browser-specific range events.
  }
}

function releaseRangePointer(event: PointerEvent<HTMLInputElement>) {
  try {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  } catch {
    // Keep range commits resilient across browsers.
  }
}

function shouldCommitRangeKey(event: KeyboardEvent<HTMLInputElement>) {
  return event.key === "Enter";
}

function overlayColorFor(userId: string): string {
  const hash = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return overlayPalette[hash % overlayPalette.length];
}

function readStoredInviteCode(): string | null {
  if (typeof window === "undefined") return null;

  try {
    return window.sessionStorage.getItem(PENDING_INVITE_CODE_KEY);
  } catch {
    return null;
  }
}

function storePendingInviteCode(code: string): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.setItem(PENDING_INVITE_CODE_KEY, code);
  } catch {
    // If sessionStorage is unavailable, keep the code in React state for this page load.
  }
}

function clearPendingInviteCode(): void {
  if (typeof window === "undefined") return;

  try {
    window.sessionStorage.removeItem(PENDING_INVITE_CODE_KEY);
  } catch {
    // Nothing else to clear.
  }
}

function readInviteCodeFromUrl(): string | null {
  if (typeof window === "undefined") return null;

  const match = window.location.pathname.match(/^\/invite\/([^/?#]+)/);
  if (!match) return null;

  const code = decodeURIComponent(match[1]);
  storePendingInviteCode(code);
  window.history.replaceState({}, "", "/");
  return code;
}

function normalizeArtistName(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeTrackTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function commonTrackTitles(leftTracks: string[] = [], rightTracks: string[] = []): string[] {
  const rightNormalized = new Set(rightTracks.map(normalizeTrackTitle).filter(Boolean));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const track of leftTracks) {
    const normalized = normalizeTrackTitle(track);
    if (!normalized || !rightNormalized.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(track);
  }
  return result;
}

const dashboardGuide = [
  {
    title: "Размер пузырька",
    text: "Показывает, сколько знакомых треков артиста нашел Яндекс. Если данных нет, берем локальные прослушивания."
  },
  {
    title: "Зеленые связи",
    text: "Это реальные коллабы из твоих лайков, истории, Моей волны и знакомых треков артиста."
  },
  {
    title: "Синие связи",
    text: "Дискография: найденные коллабы, которые можно включить чекбоксом, чтобы искать новые переходы."
  },
  {
    title: "Друзья",
    text: "Приглашение открывает сравнение графов: общие артисты подсвечиваются, а процент показывает пересечение вкусов."
  }
];

function graphNodeScore(node: GraphResponse["nodes"][number]) {
  if (typeof node.knownTrackCount === "number" && node.knownTrackCount > 0) {
    return node.knownTrackCount;
  }
  return node.trackCount || node.listenCount || 0;
}

function graphNodeScoreLabel(node: GraphResponse["nodes"][number]) {
  const score = graphNodeScore(node);
  const parts = [`${score} знакомых`];
  if (typeof node.waveTrackCount === "number" && node.waveTrackCount > 0) {
    parts.push(`${node.waveTrackCount} из волны`);
  }
  if (typeof node.collectionTrackCount === "number" && node.collectionTrackCount > 0) {
    parts.push(`${node.collectionTrackCount} в коллекции`);
  }
  if (node.trackCount > 0 && node.trackCount !== score) {
    parts.push(`${node.trackCount} в графе`);
  }
  return parts.join(", ");
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
}

function clampText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function shareCardDimensions() {
  return { width: 1080, height: 1350 };
}

function topGraphArtists(graph: GraphResponse, count: number) {
  return [...graph.nodes]
    .filter((node) => graphNodeScore(node) > 0)
    .sort((left, right) => graphNodeScore(right) - graphNodeScore(left) || left.name.localeCompare(right.name, "ru"))
    .slice(0, count);
}

function shareEdgeTypePriority(type: string): number {
  if (type === "catalog_collab") return 0;
  if (type === "collab") return 1;
  return 2;
}

function shareCardColor(index: number, clusterColor?: string) {
  return clusterColor ?? ["#0d7f69", "#cf4b3f", "#2f6fbd", "#d79b28", "#7b61ff", "#e26d3d"][index % 6];
}

function artistInitials(name: string) {
  const letters = name
    .split(/\s+/)
    .map((part) => part.trim()[0])
    .filter(Boolean)
    .join("");
  return (letters || name.slice(0, 2)).slice(0, 2).toUpperCase();
}

type ShareCardFrameNode = {
  id: string;
  name: string;
  image?: string | null;
  clusterId?: string | null;
  score: number;
  color: string;
  x: number;
  y: number;
  radius: number;
};

type ShareCardFrameEdge = {
  source: string;
  target: string;
  type: string;
  weight: number;
};

type ShareCardFrameScene = {
  nodes: ShareCardFrameNode[];
  edges: ShareCardFrameEdge[];
  title: string;
  subtitle: string;
  color: string;
};

type ShareCardIslandShape = {
  id: string;
  color: string;
  centerX: number;
  centerY: number;
  points: [number, number][];
  path: string;
};

const shareCardFrameLayout = [
  { x: 540, y: 600, radius: 76 },
  { x: 312, y: 492, radius: 56 },
  { x: 772, y: 498, radius: 56 },
  { x: 330, y: 735, radius: 50 },
  { x: 760, y: 724, radius: 50 },
  { x: 540, y: 378, radius: 46 },
  { x: 545, y: 842, radius: 46 },
  { x: 180, y: 620, radius: 38 },
  { x: 906, y: 616, radius: 38 },
  { x: 430, y: 430, radius: 36 },
  { x: 652, y: 430, radius: 36 },
  { x: 430, y: 818, radius: 34 },
  { x: 655, y: 812, radius: 34 }
];

function shareCardIslandStory(graph: GraphResponse) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const collabEdges = graph.edges.filter((edge) => edge.type === "collab");
  const stories = graph.clusters
    .map((cluster) => {
      const clusterNodeIds = new Set(cluster.nodeIds.filter((id) => nodeById.has(id)));
      const nodes = [...clusterNodeIds]
        .map((id) => nodeById.get(id))
        .filter((node): node is GraphResponse["nodes"][number] => Boolean(node));
      const edges = collabEdges.filter((edge) => clusterNodeIds.has(edge.source) && clusterNodeIds.has(edge.target));
      const weight = edges.reduce((sum, edge) => sum + edge.weight, 0);
      const known = nodes.reduce((sum, node) => sum + graphNodeScore(node), 0);
      return {
        cluster,
        nodes,
        edges,
        score: edges.length * 1000 + weight * 20 + known + nodes.length
      };
    })
    .filter((story) => story.nodes.length > 1 && story.edges.length > 0)
    .sort((left, right) => right.score - left.score || right.nodes.length - left.nodes.length);

  const story = stories[0];
  if (!story) return null;

  const degreeById = new Map<string, number>();
  for (const edge of story.edges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + edge.weight);
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + edge.weight);
  }

  const orderedNodes = [...story.nodes].sort(
    (left, right) =>
      (degreeById.get(right.id) ?? 0) - (degreeById.get(left.id) ?? 0) ||
      graphNodeScore(right) - graphNodeScore(left) ||
      left.name.localeCompare(right.name, "ru")
  );
  const selectedIds: string[] = [];
  const selectedSet = new Set<string>();
  const addNode = (nodeId: string) => {
    if (selectedSet.has(nodeId) || !nodeById.has(nodeId) || selectedIds.length >= 10) return;
    selectedSet.add(nodeId);
    selectedIds.push(nodeId);
  };

  if (orderedNodes[0]) addNode(orderedNodes[0].id);
  while (selectedIds.length < Math.min(10, orderedNodes.length)) {
    const neighbors = story.edges
      .flatMap((edge) => {
        const sourceSelected = selectedSet.has(edge.source);
        const targetSelected = selectedSet.has(edge.target);
        if (sourceSelected && !targetSelected) return [edge.target];
        if (targetSelected && !sourceSelected) return [edge.source];
        return [];
      })
      .filter((id, index, list) => !selectedSet.has(id) && list.indexOf(id) === index)
      .sort(
        (left, right) =>
          (degreeById.get(right) ?? 0) - (degreeById.get(left) ?? 0) ||
          graphNodeScore(nodeById.get(right)!) - graphNodeScore(nodeById.get(left)!)
      );
    const nextId = neighbors[0] ?? orderedNodes.find((node) => !selectedSet.has(node.id))?.id;
    if (!nextId) break;
    addNode(nextId);
  }

  const selectedNodes = selectedIds
    .map((id) => nodeById.get(id))
    .filter((node): node is GraphResponse["nodes"][number] => Boolean(node));
  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
  return {
    cluster: story.cluster,
    nodes: selectedNodes,
    edges: story.edges.filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target))
  };
}

function shareCardFrameScene(graph: GraphResponse): ShareCardFrameScene {
  const clusterById = new Map((graph.clusters ?? []).map((cluster) => [cluster.id, cluster]));
  const selectedNodes = topGraphArtists(graph, 10);
  const nodes: ShareCardFrameNode[] = selectedNodes.map((node, index) => {
    const layout = shareCardFrameLayout[index] ?? shareCardFrameLayout[shareCardFrameLayout.length - 1];
    const scoreRadius = 34 + Math.sqrt(Math.max(graphNodeScore(node), 1)) * 2.4;
    const clusterColor = node.clusterId ? clusterById.get(node.clusterId)?.color : undefined;
    return {
      id: node.id,
      name: node.name,
      image: node.image,
      clusterId: node.clusterId,
      score: graphNodeScore(node),
      color: shareCardColor(index, clusterColor),
      x: layout.x,
      y: layout.y,
      radius: Math.max(32, Math.min(layout.radius, scoreRadius))
    };
  });

  const selectedIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .sort((left, right) => shareEdgeTypePriority(left.type) - shareEdgeTypePriority(right.type) || right.weight - left.weight)
    .slice(0, 22)
    .map((edge) => ({ source: edge.source, target: edge.target, type: edge.type, weight: edge.weight }));

  if (edges.length === 0 && nodes.length > 1) {
    edges.push(
      ...nodes.slice(1).map((node) => ({
        source: nodes[0].id,
        target: node.id,
        type: "preview",
        weight: 1
      }))
    );
  }

  return {
    nodes,
    edges: edges as ShareCardFrameEdge[],
    title: "Острова и связи",
    subtitle: "Артисты и связи между ними",
    color: nodes[0]?.color ?? "#0d7f69"
  };
}

function islandBlobPoints(centerX: number, centerY: number, radiusX: number, radiusY: number, seed: number, vertices = 18): [number, number][] {
  const points: [number, number][] = [];
  for (let index = 0; index < vertices; index += 1) {
    const angle = (Math.PI * 2 * index) / vertices;
    const wobble = 0.86 + (((Math.sin(seed * 1.91 + index * 2.17) + Math.cos(seed * 0.73 + index * 1.31)) / 2 + 1) / 2) * 0.22;
    const x = centerX + Math.cos(angle) * radiusX * wobble;
    const y = centerY + Math.sin(angle) * radiusY * (0.9 + (wobble - 0.86) * 0.65);
    points.push([Math.max(82, Math.min(998, x)), Math.max(284, Math.min(908, y))]);
  }
  return points;
}

function polygonFromPoints(points: [number, number][]) {
  const hull = d3.polygonHull(points);
  const polygon = (hull ?? points) as [number, number][];
  const smoothPath =
    d3
      .line<[number, number]>()
      .x((point) => point[0])
      .y((point) => point[1])
      .curve(d3.curveBasisClosed)(polygon) ?? "";
  return {
    points: polygon,
    path: smoothPath
  };
}

function shareCardIslandShapes(graph: GraphResponse, nodes: ShareCardFrameNode[]): ShareCardIslandShape[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const clusterById = new Map((graph.clusters ?? []).map((cluster) => [cluster.id, cluster]));
  const nodesByCluster = new Map<string, ShareCardFrameNode[]>();
  nodes.forEach((node) => {
    const id = node.clusterId ?? `artist-${node.id}`;
    nodesByCluster.set(id, [...(nodesByCluster.get(id) ?? []), node]);
  });

  const shapes: ShareCardIslandShape[] = [...nodesByCluster.entries()].map(([id, clusterNodes], index) => {
    const cluster = clusterById.get(id);
    const centerX = d3.mean(clusterNodes, (node) => node.x) ?? 540;
    const centerY = d3.mean(clusterNodes, (node) => node.y) ?? 600;
    const maxDistance = d3.max(clusterNodes, (node) => Math.hypot(node.x - centerX, node.y - centerY) + node.radius) ?? 88;
    const radiusX = Math.max(104, Math.min(420, maxDistance + 88 + clusterNodes.length * 18));
    const radiusY = Math.max(82, Math.min(300, maxDistance * 0.72 + 72 + clusterNodes.length * 12));
    const rawPoints =
      clusterNodes.length > 1
        ? clusterNodes.flatMap((node, nodeIndex) => islandBlobPoints(node.x, node.y, node.radius + 62, node.radius + 48, index * 19 + nodeIndex, 10))
        : islandBlobPoints(centerX, centerY, radiusX, radiusY, index * 17 + 3, 18);
    const polygon = polygonFromPoints(rawPoints);

    return {
      id,
      color: cluster?.color ?? clusterNodes[0]?.color ?? shareCardColor(index),
      centerX,
      centerY,
      points: polygon.points,
      path: polygon.path
    };
  });

  const usedClusterIds = new Set(nodes.map((node) => node.clusterId).filter(Boolean));
  const ambientLayouts = [
    { x: 238, y: 348, rx: 210, ry: 94 },
    { x: 878, y: 376, rx: 180, ry: 86 },
    { x: 198, y: 842, rx: 174, ry: 82 },
    { x: 862, y: 828, rx: 190, ry: 92 }
  ];
  const ambientClusters = [...(graph.clusters ?? [])]
    .filter((cluster) => !usedClusterIds.has(cluster.id))
    .map((cluster) => ({
      cluster,
      score: cluster.nodeIds.reduce((sum, id) => {
        const node = nodeById.get(id);
        return sum + (node ? graphNodeScore(node) : 0);
      }, 0)
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, 5 - shapes.length));

  ambientClusters.forEach(({ cluster }, index) => {
    const layout = ambientLayouts[index % ambientLayouts.length];
    const polygon = polygonFromPoints(islandBlobPoints(layout.x, layout.y, layout.rx, layout.ry, index * 23 + 11, 18));
    shapes.push({
      id: cluster.id,
      color: cluster.color,
      centerX: layout.x,
      centerY: layout.y,
      points: polygon.points,
      path: polygon.path
    });
  });

  return shapes;
}

function edgeColor(type: string) {
  return "#0d7f69";
}

function renderShareCardFrame(svg: SVGSVGElement, graph: GraphResponse) {
  const { width, height } = shareCardDimensions();
  const scene = shareCardFrameScene(graph);
  const bottomArtists = topGraphArtists(graph, 10);
  const clusterById = new Map((graph.clusters ?? []).map((cluster) => [cluster.id, cluster]));
  const nodeById = new Map(scene.nodes.map((node) => [node.id, node]));
  const root = d3.select(svg);
  const fontFamily = "Manrope, Aptos, Segoe UI, Arial, sans-serif";

  root.selectAll("*").remove();
  root.attr("viewBox", `0 0 ${width} ${height}`).attr("width", width).attr("height", height).attr("overflow", "hidden");

  const defs = root.append("defs");
  defs.append("clipPath").attr("id", "share-card-graph-content").append("rect").attr("x", 72).attr("y", 210).attr("width", 936).attr("height", 720).attr("rx", 54);
  defs.append("clipPath").attr("id", "share-card-bottom-content").append("rect").attr("x", 90).attr("y", 1096).attr("width", 900).attr("height", 176).attr("rx", 18);
  defs
    .append("linearGradient")
    .attr("id", "share-bg")
    .attr("x1", "0")
    .attr("y1", "0")
    .attr("x2", "1")
    .attr("y2", "1")
    .call((gradient) => {
      gradient.append("stop").attr("offset", "0").attr("stop-color", "#fffdf7");
      gradient.append("stop").attr("offset", "0.58").attr("stop-color", "#f4f1ea");
      gradient.append("stop").attr("offset", "1").attr("stop-color", "#e8f2ef");
    });

  root.append("rect").attr("width", width).attr("height", height).attr("fill", "url(#share-bg)");
  root.append("circle").attr("cx", width - 90).attr("cy", 92).attr("r", 230).attr("fill", "#2f6fbd").attr("opacity", 0.08);
  root.append("circle").attr("cx", 38).attr("cy", height - 76).attr("r", 255).attr("fill", "#d79b28").attr("opacity", 0.13);

  const dots = Array.from({ length: 34 }, (_, index) => ({
    x: 58 + ((index * 149) % (width - 116)),
    y: 230 + ((index * 97) % 900),
    r: 7 + (index % 5) * 4,
    color: ["#1f8a70", "#cf4b3f", "#2f6fbd", "#d79b28"][index % 4]
  }));
  root
    .append("g")
    .selectAll("circle")
    .data(dots)
    .enter()
    .append("circle")
    .attr("cx", (dot) => dot.x)
    .attr("cy", (dot) => dot.y)
    .attr("r", (dot) => dot.r)
    .attr("fill", (dot) => dot.color)
    .attr("opacity", 0.06);

  const text = (value: string, x: number, y: number, size: number, weight = 800, fill = "#121416") =>
    root
      .append("text")
      .attr("x", x)
      .attr("y", y)
      .attr("fill", fill)
      .attr("font-family", fontFamily)
      .attr("font-size", size)
      .attr("font-weight", weight)
      .attr("letter-spacing", 0)
      .text(value);

  text("Моя музыкальная карта", 90, 118, 52, 950, "#121416");
  text(scene.title, 92, 162, 24, 950, "#0d5f50");

  const graphGroup = root.append("g").attr("class", "share-d3-frame");
  graphGroup
    .append("rect")
    .attr("x", 72)
    .attr("y", 210)
    .attr("width", 936)
    .attr("height", 720)
    .attr("rx", 54)
    .attr("fill", "#fffdf7")
    .attr("opacity", 0.58)
    .attr("stroke", "#d9e0df");

  graphGroup
    .append("text")
    .attr("x", 110)
    .attr("y", 258)
    .attr("fill", "#364040")
    .attr("font-family", fontFamily)
    .attr("font-size", 23)
    .attr("font-weight", 850)
    .text(scene.subtitle);

  const centerX = d3.mean(scene.nodes, (node) => node.x) ?? 540;
  const centerY = d3.mean(scene.nodes, (node) => node.y) ?? 620;
  const graphContent = graphGroup.append("g").attr("clip-path", "url(#share-card-graph-content)");
  const islandShapes = shareCardIslandShapes(graph, scene.nodes);

  islandShapes.forEach((shape, shapeIndex) => {
    graphContent
      .append("path")
      .attr("d", shape.path)
      .attr("fill", shape.color)
      .attr("opacity", shapeIndex === 0 ? 0.18 : 0.12);

    graphContent
      .append("path")
      .attr("d", shape.path)
      .attr("fill", "none")
      .attr("stroke", shape.color)
      .attr("stroke-width", shapeIndex === 0 ? 4 : 2.5)
      .attr("stroke-linejoin", "round")
      .attr("stroke-linecap", "round")
      .attr("stroke-opacity", shapeIndex === 0 ? 0.34 : 0.22);
  });

  graphContent
    .append("g")
    .selectAll("line")
    .data(scene.edges)
    .enter()
    .append("line")
    .attr("x1", (edge) => nodeById.get(edge.source)?.x ?? 0)
    .attr("y1", (edge) => nodeById.get(edge.source)?.y ?? 0)
    .attr("x2", (edge) => nodeById.get(edge.target)?.x ?? 0)
    .attr("y2", (edge) => nodeById.get(edge.target)?.y ?? 0)
    .attr("stroke", (edge) => edgeColor(edge.type))
    .attr("stroke-width", (edge) => Math.max(4, Math.min(13, edge.weight * 2.5)))
    .attr("stroke-linecap", "round")
    .attr("opacity", (edge) => (edge.type === "preview" ? 0.28 : 0.52));

  const nodeGroups = graphGroup
    .append("g")
    .attr("clip-path", "url(#share-card-graph-content)")
    .selectAll<SVGGElement, ShareCardFrameNode>("g")
    .data(scene.nodes)
    .enter()
    .append("g")
    .attr("transform", (node) => `translate(${node.x},${node.y})`);

  nodeGroups
    .append("circle")
    .attr("r", (node) => node.radius + 12)
    .attr("fill", (node) => node.color)
    .attr("opacity", 0.16);
  nodeGroups.append("circle").attr("r", (node) => node.radius).attr("fill", (node) => node.color);

  nodeGroups.each(function addAvatar(node, index) {
    const group = d3.select(this);
    const clipId = `share-card-avatar-${index}-${node.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    defs.append("clipPath").attr("id", clipId).append("circle").attr("r", node.radius - 7);
    if (node.image) {
      group
        .append("image")
        .attr("href", node.image)
        .attr("xlink:href", node.image)
        .attr("x", -node.radius + 7)
        .attr("y", -node.radius + 7)
        .attr("width", (node.radius - 7) * 2)
        .attr("height", (node.radius - 7) * 2)
        .attr("clip-path", `url(#${clipId})`)
        .attr("preserveAspectRatio", "xMidYMid slice");
    } else {
      group
        .append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.34em")
        .attr("fill", "#fffdf7")
        .attr("font-family", fontFamily)
        .attr("font-size", Math.max(24, node.radius * 0.52))
        .attr("font-weight", 950)
        .text(artistInitials(node.name));
    }
  });

  nodeGroups
    .append("circle")
    .attr("r", (node) => node.radius)
    .attr("fill", "none")
    .attr("stroke", "#fffdf7")
    .attr("stroke-width", 8);

  nodeGroups
    .append("text")
    .attr("x", 0)
    .attr("y", (node) => (node.y < centerY || node.y > 790 ? -node.radius - 18 : node.radius + 34))
    .attr("fill", "#121416")
    .attr("font-family", fontFamily)
    .attr("font-size", (node, index) => (index === 0 ? 25 : 20))
    .attr("font-weight", 950)
    .attr("text-anchor", (node) => (node.x < 220 ? "start" : node.x > 860 ? "end" : "middle"))
    .text((node, index) => clampText(node.name, index === 0 ? 15 : 11));

  const metricGroup = root.append("g").attr("transform", "translate(90 985)");
  metricGroup.append("rect").attr("x", 0).attr("y", -70).attr("width", 900).attr("height", 126).attr("rx", 36).attr("fill", "#121416").attr("opacity", 0.94);
  [
    [42, graph.nodes.length, "Артистов в карте"],
    [340, graph.edges.length, "Музыкальных связей"],
    [660, graph.clusters?.length ?? 0, "Островов"]
  ].forEach(([x, value, label]) => {
    metricGroup.append("text").attr("x", x).attr("y", -10).attr("fill", "#fffdf7").attr("font-family", fontFamily).attr("font-size", 50).attr("font-weight", 950).text(formatCompactNumber(value as number));
    metricGroup.append("text").attr("x", x).attr("y", 29).attr("fill", "#d9e0df").attr("font-family", fontFamily).attr("font-size", 23).attr("font-weight", 850).text(label as string);
  });

  text("Топ-10 по количеству знакомых треков", 96, 1080, 30, 950, "#0d5f50");

  const artistGroup = root
    .append("g")
    .attr("clip-path", "url(#share-card-bottom-content)")
    .append("g")
    .attr("transform", "translate(92 1130)");
  bottomArtists.forEach((artist, index) => {
    const x = (index % 5) * 178;
    const y = Math.floor(index / 5) * 64;
    const color = shareCardColor(index, artist.clusterId ? clusterById.get(artist.clusterId)?.color : undefined);
    const row = artistGroup.append("g").attr("transform", `translate(${x} ${y})`);
    const clipId = `share-card-bottom-avatar-${index}-${artist.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const textClipId = `share-card-bottom-text-${index}-${artist.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    row.append("rect").attr("x", 0).attr("y", -28).attr("width", 168).attr("height", 56).attr("rx", 18).attr("fill", color).attr("opacity", 0.12);
    row.append("text").attr("x", 18).attr("y", 7).attr("text-anchor", "middle").attr("fill", color).attr("font-family", fontFamily).attr("font-size", 16).attr("font-weight", 950).text(index + 1);
    row.append("circle").attr("cx", 50).attr("cy", 0).attr("r", 24).attr("fill", color).attr("opacity", 0.22);
    defs.append("clipPath").attr("id", clipId).append("circle").attr("cx", 50).attr("cy", 0).attr("r", 20);
    defs.append("clipPath").attr("id", textClipId).append("rect").attr("x", 78).attr("y", -24).attr("width", 82).attr("height", 48).attr("rx", 4);
    if (artist.image) {
      row
        .append("image")
        .attr("href", artist.image)
        .attr("xlink:href", artist.image)
        .attr("x", 30)
        .attr("y", -20)
        .attr("width", 40)
        .attr("height", 40)
        .attr("clip-path", `url(#${clipId})`)
        .attr("preserveAspectRatio", "xMidYMid slice");
    } else {
      row
        .append("text")
        .attr("x", 50)
        .attr("y", 8)
        .attr("text-anchor", "middle")
        .attr("fill", "#fffdf7")
        .attr("font-family", fontFamily)
        .attr("font-size", 16)
        .attr("font-weight", 950)
        .text(artistInitials(artist.name));
    }
    row.append("circle").attr("cx", 50).attr("cy", 0).attr("r", 21).attr("fill", "none").attr("stroke", "#fffdf7").attr("stroke-width", 4);
    const labelGroup = row.append("g").attr("clip-path", `url(#${textClipId})`);
    labelGroup.append("text").attr("x", 78).attr("y", -4).attr("fill", "#121416").attr("font-family", fontFamily).attr("font-size", 15).attr("font-weight", 950).text(clampText(artist.name, 9));
    labelGroup.append("text").attr("x", 78).attr("y", 18).attr("fill", "#68707a").attr("font-family", fontFamily).attr("font-size", 13).attr("font-weight", 850).text(`${formatCompactNumber(graphNodeScore(artist))} треков`);
  });

  const footerTitle = root
    .append("text")
    .attr("x", width / 2)
    .attr("y", height - 62)
    .attr("fill", "#0d5f50")
    .attr("font-family", fontFamily)
    .attr("font-size", 26)
    .attr("font-weight", 950)
    .attr("text-anchor", "middle")
    .attr("letter-spacing", 0);
  footerTitle.append("tspan").text("Пересечение с друзьями");
  footerTitle.append("tspan").text(" • ");
  footerTitle.append("tspan").text("Карта музыки");
  footerTitle.append("tspan").text(" • ");
  footerTitle.append("tspan").text("Острова");
  footerTitle.append("tspan").text(" • ");
  footerTitle.append("tspan").text("Топ артистов");
  text("Music Graph • Неофициальный эксперимент поверх Яндекс Музыки", width / 2, height - 34, 18, 750, "#8a8f93").attr("text-anchor", "middle");
}

function sharePostCaption(graph: GraphResponse) {
  const topArtists = topGraphArtists(graph, 10).map((node) => node.name).join(", ");
  return [
    `Моя музыкальная карта: ${formatCompactNumber(graph.nodes.length)} артистов, ${formatCompactNumber(graph.edges.length)} связей, ${formatCompactNumber(graph.clusters?.length ?? 0)} островов.`,
    topArtists ? `Топ-10 по знакомым трекам: ${topArtists}.` : null
  ]
    .filter(Boolean)
    .join("\n");
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать изображение"));
    reader.readAsDataURL(blob);
  });
}

async function imageBlobToPngDataUrl(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image decode failed"));
      image.src = url;
    });

    const maxSize = 512;
    const naturalWidth = image.naturalWidth || maxSize;
    const naturalHeight = image.naturalHeight || maxSize;
    const scale = Math.min(1, maxSize / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas недоступен");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fetchShareImageBlob(href: string) {
  try {
    const response = await fetch(href, { mode: "cors" });
    if (response.ok) return await response.blob();
  } catch {
    // Fall back to the local API proxy below.
  }

  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const proxyResponse = await fetch(`${API_BASE_URL}/media/image?url=${encodeURIComponent(href)}`, { headers });
  if (!proxyResponse.ok) throw new Error("image fetch failed");
  return await proxyResponse.blob();
}

async function cloneSvgWithInlineImages(svg: SVGSVGElement) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  const images = Array.from(clone.querySelectorAll("image"));
  await Promise.all(
    images.map(async (image) => {
      const href = image.getAttribute("href") ?? image.getAttribute("xlink:href");
      if (!href || href.startsWith("data:")) return;
      try {
        const blob = await fetchShareImageBlob(href);
        const dataUrl = await imageBlobToPngDataUrl(blob).catch(() => blobToDataUrl(blob));
        image.setAttribute("href", dataUrl);
        image.setAttribute("xlink:href", dataUrl);
      } catch {
        image.remove();
      }
    })
  );
  return clone;
}

function svgSourceToDataUrl(source: string) {
  const bytes = new TextEncoder().encode(source);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return `data:image/svg+xml;base64,${window.btoa(binary)}`;
}

async function loadShareSvgImage(source: string) {
  const image = new Image();
  image.decoding = "async";
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("blob svg load failed"));
      image.src = blobUrl;
    });
    return image;
  } catch {
    URL.revokeObjectURL(blobUrl);
  }

  const fallbackImage = new Image();
  fallbackImage.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    fallbackImage.onload = () => resolve();
    fallbackImage.onerror = () => reject(new Error("Не удалось собрать PNG"));
    fallbackImage.src = svgSourceToDataUrl(source);
  });
  return fallbackImage;
}

async function shareFramePngBlob(svg: SVGSVGElement) {
  const { width, height } = shareCardDimensions();
  const clone = await cloneSvgWithInlineImages(svg);
  const source = new XMLSerializer().serializeToString(clone);
  const image = await loadShareSvgImage(source);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas недоступен");
  context.drawImage(image, 0, 0, width, height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) {
        reject(new Error("Не удалось сохранить PNG"));
        return;
      }
      resolve(pngBlob);
    }, "image/png");
  });
}

async function downloadShareFramePng(svg: SVGSVGElement, user: User) {
  const pngBlob = await shareFramePngBlob(svg);
  const pngUrl = URL.createObjectURL(pngBlob);
  const link = document.createElement("a");
  const safeLogin = user.display_login.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "_");
  link.href = pngUrl;
  link.download = `music-graph-share-${safeLogin}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(pngUrl), 1200);
}

async function copyShareFramePng(svg: SVGSVGElement) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Браузер не поддерживает копирование изображения");
  }
  const pngBlob = await shareFramePngBlob(svg);
  await navigator.clipboard.write([new ClipboardItem({ [pngBlob.type]: pngBlob })]);
}

async function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) {
        reject(new Error("Не удалось сохранить PNG"));
        return;
      }
      resolve(pngBlob);
    }, "image/png");
  });
}

async function downloadShareCanvasPng(canvas: HTMLCanvasElement, user: User) {
  const pngBlob = await canvasToPngBlob(canvas);
  const pngUrl = URL.createObjectURL(pngBlob);
  const link = document.createElement("a");
  const safeLogin = user.display_login.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g, "_");
  link.href = pngUrl;
  link.download = `music-graph-share-${safeLogin}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(pngUrl), 1200);
}

async function copyShareCanvasPng(canvas: HTMLCanvasElement) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Браузер не поддерживает копирование изображения");
  }
  const pngBlob = await canvasToPngBlob(canvas);
  await navigator.clipboard.write([new ClipboardItem({ [pngBlob.type]: pngBlob })]);
}

function canvasFont(size: number, weight: number, family: string) {
  return `${weight} ${size}px ${family}`;
}

function drawRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function drawCanvasText(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  weight: number,
  fill: string,
  fontFamily: string,
  align: CanvasTextAlign = "left"
) {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.font = canvasFont(size, weight, fontFamily);
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, y);
  ctx.restore();
}

async function loadShareCanvasImage(src?: string | null) {
  if (!src) return null;
  try {
    const blob = await fetchShareImageBlob(src);
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image load failed"));
      image.src = url;
    });
    return { image, url };
  } catch {
    return null;
  }
}

function drawImageCircle(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  radius: number
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(image, x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

async function renderShareCardCanvas(canvas: HTMLCanvasElement, graph: GraphResponse) {
  const { width, height } = shareCardDimensions();
  const scene = shareCardFrameScene(graph);
  const bottomArtists = topGraphArtists(graph, 10);
  const clusterById = new Map((graph.clusters ?? []).map((cluster) => [cluster.id, cluster]));
  const nodeById = new Map(scene.nodes.map((node) => [node.id, node]));
  const fontFamily = "Manrope, Aptos, Segoe UI, Arial, sans-serif";
  const imageUrls: string[] = [];

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas недоступен");
  ctx.clearRect(0, 0, width, height);

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#fffdf7");
  bg.addColorStop(0.58, "#f4f1ea");
  bg.addColorStop(1, "#e8f2ef");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = "#2f6fbd";
  ctx.beginPath();
  ctx.arc(width - 90, 92, 230, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = "#d79b28";
  ctx.beginPath();
  ctx.arc(38, height - 76, 255, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  Array.from({ length: 34 }, (_, index) => ({
    x: 58 + ((index * 149) % (width - 116)),
    y: 230 + ((index * 97) % 900),
    r: 7 + (index % 5) * 4,
    color: ["#1f8a70", "#cf4b3f", "#2f6fbd", "#d79b28"][index % 4]
  })).forEach((dot) => {
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = dot.color;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  drawCanvasText(ctx, "Моя музыкальная карта", 90, 118, 52, 950, "#121416", fontFamily);
  drawCanvasText(ctx, scene.title, 92, 162, 24, 950, "#0d5f50", fontFamily);

  drawRoundRect(ctx, 72, 210, 936, 720, 54);
  ctx.fillStyle = "rgba(255, 253, 247, 0.58)";
  ctx.fill();
  ctx.strokeStyle = "#d9e0df";
  ctx.lineWidth = 1;
  ctx.stroke();
  drawCanvasText(ctx, scene.subtitle, 110, 258, 23, 850, "#364040", fontFamily);

  ctx.save();
  drawRoundRect(ctx, 72, 210, 936, 720, 54);
  ctx.clip();
  shareCardIslandShapes(graph, scene.nodes).forEach((shape, shapeIndex) => {
    const path = new Path2D(shape.path);
    ctx.save();
    ctx.globalAlpha = shapeIndex === 0 ? 0.18 : 0.12;
    ctx.fillStyle = shape.color;
    ctx.fill(path);
    ctx.globalAlpha = shapeIndex === 0 ? 0.34 : 0.22;
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shapeIndex === 0 ? 4 : 2.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(path);
    ctx.restore();
  });

  scene.edges.forEach((edge) => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) return;
    ctx.save();
    ctx.globalAlpha = edge.type === "preview" ? 0.28 : 0.52;
    ctx.strokeStyle = edgeColor(edge.type);
    ctx.lineWidth = Math.max(4, Math.min(13, edge.weight * 2.5));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.restore();
  });

  const centerY = d3.mean(scene.nodes, (node) => node.y) ?? 620;
  for (const [index, node] of scene.nodes.entries()) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius + 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = node.color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.fill();

    const loaded = await loadShareCanvasImage(node.image);
    if (loaded) {
      imageUrls.push(loaded.url);
      drawImageCircle(ctx, loaded.image, node.x, node.y, node.radius - 7);
    } else {
      drawCanvasText(ctx, artistInitials(node.name), node.x, node.y + node.radius * 0.18, Math.max(24, node.radius * 0.52), 950, "#fffdf7", fontFamily, "center");
    }

    ctx.strokeStyle = "#fffdf7";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.stroke();

    const labelY = node.y < centerY || node.y > 790 ? node.y - node.radius - 18 : node.y + node.radius + 34;
    const align: CanvasTextAlign = node.x < 220 ? "left" : node.x > 860 ? "right" : "center";
    drawCanvasText(ctx, clampText(node.name, index === 0 ? 15 : 11), node.x, labelY, index === 0 ? 25 : 20, 950, "#121416", fontFamily, align);
  }
  ctx.restore();

  drawRoundRect(ctx, 90, 915, 900, 126, 36);
  ctx.fillStyle = "rgba(18, 20, 22, 0.94)";
  ctx.fill();
  [
    [132, graph.nodes.length, "Артистов в карте"],
    [430, graph.edges.length, "Музыкальных связей"],
    [750, graph.clusters?.length ?? 0, "Островов"]
  ].forEach(([x, value, label]) => {
    drawCanvasText(ctx, formatCompactNumber(value as number), x as number, 975, 50, 950, "#fffdf7", fontFamily);
    drawCanvasText(ctx, label as string, x as number, 1014, 23, 850, "#d9e0df", fontFamily);
  });

  drawCanvasText(ctx, "Топ-10 по количеству знакомых треков", 96, 1080, 30, 950, "#0d5f50", fontFamily);

  ctx.save();
  ctx.beginPath();
  ctx.rect(90, 1096, 900, 176);
  ctx.clip();
  for (const [index, artist] of bottomArtists.entries()) {
    const x = 92 + (index % 5) * 178;
    const y = 1130 + Math.floor(index / 5) * 64;
    const color = shareCardColor(index, artist.clusterId ? clusterById.get(artist.clusterId)?.color : undefined);
    ctx.save();
    ctx.globalAlpha = 0.12;
    drawRoundRect(ctx, x, y - 28, 168, 56, 18);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    drawCanvasText(ctx, String(index + 1), x + 18, y + 7, 16, 950, color, fontFamily, "center");
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 50, y, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const loaded = await loadShareCanvasImage(artist.image);
    if (loaded) {
      imageUrls.push(loaded.url);
      drawImageCircle(ctx, loaded.image, x + 50, y, 20);
    } else {
      drawCanvasText(ctx, artistInitials(artist.name), x + 50, y + 8, 16, 950, "#fffdf7", fontFamily, "center");
    }
    ctx.strokeStyle = "#fffdf7";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x + 50, y, 21, 0, Math.PI * 2);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 78, y - 24, 82, 48);
    ctx.clip();
    drawCanvasText(ctx, clampText(artist.name, 9), x + 78, y - 4, 15, 950, "#121416", fontFamily);
    drawCanvasText(ctx, `${formatCompactNumber(graphNodeScore(artist))} треков`, x + 78, y + 18, 13, 850, "#68707a", fontFamily);
    ctx.restore();
  }
  ctx.restore();

  ctx.save();
  ctx.textAlign = "center";
  drawCanvasText(ctx, "Пересечение с друзьями • Карта музыки • Острова • Топ артистов", width / 2, height - 62, 26, 950, "#0d5f50", fontFamily, "center");
  drawCanvasText(ctx, "Music Graph • Неофициальный эксперимент поверх Яндекс Музыки", width / 2, height - 34, 18, 750, "#8a8f93", fontFamily, "center");
  ctx.restore();
  imageUrls.forEach((url) => URL.revokeObjectURL(url));
}

function ShareCardModal({
  graph,
  user,
  onClose
}: {
  graph: GraphResponse;
  user: User;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [caption, setCaption] = useState(() => sharePostCaption(graph));
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setCaption(sharePostCaption(graph));
  }, [graph]);

  useEffect(() => {
    if (!canvasRef.current) return;
    let cancelled = false;
    renderShareCardCanvas(canvasRef.current, graph).catch((error) => {
      if (!cancelled) {
        setStatus(error instanceof Error ? error.message : "Не удалось отрисовать карточку");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [graph]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleDownload() {
    if (!canvasRef.current) return;
    setStatus("Собираю PNG...");
    try {
      await downloadShareCanvasPng(canvasRef.current, user);
      setStatus("PNG готов");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось скачать PNG");
    }
  }

  async function handleCopyImage() {
    if (!canvasRef.current) return;
    setStatus("Копирую изображение...");
    try {
      await copyShareCanvasPng(canvasRef.current);
      setStatus("Изображение скопировано");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Не удалось скопировать изображение");
    }
  }

  async function handleCopyText() {
    try {
      await navigator.clipboard.writeText(caption);
      setStatus("Текст скопирован");
    } catch {
      setStatus("Не удалось скопировать текст");
    }
  }

  return (
    <div className="share-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label="Поделиться результатом"
        aria-modal="true"
        className="share-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="share-modal-header">
          <div>
            <p className="eyebrow">Шаринг</p>
            <h2>Поделиться своим результатом</h2>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        <div className="share-modal-grid">
          <div className="share-frame-shell">
            <canvas ref={canvasRef} role="img" aria-label="share card preview" />
          </div>
          <aside className="share-post-editor">
            <label>
              <span>Текст поста</span>
              <textarea value={caption} onChange={(event) => setCaption(event.target.value)} />
            </label>
            <div className="share-modal-actions">
              <button className="primary-action" onClick={() => void handleDownload()} type="button">
                <Download size={18} />
                Скачать кадр PNG
              </button>
              <button className="secondary-action" onClick={() => void handleCopyImage()} type="button">
                <Copy size={18} />
                Скопировать изображение
              </button>
              <button className="secondary-action" onClick={() => void handleCopyText()} type="button">
                <Share2 size={18} />
                Скопировать текст
              </button>
            </div>
            {status && <p className="muted small">{status}</p>}
          </aside>
        </div>
      </section>
    </div>
  );
}

function ClusterIslandsPanel({
  graph,
  enabled,
  activeClusterId,
  onHoverCluster,
  onSelectCluster
}: ClusterIslandsPanelProps) {
  const clusters = useMemo(() => {
    return [...(graph?.clusters ?? [])]
      .sort(
        (left, right) =>
          right.totalListenCount - left.totalListenCount ||
          right.size - left.size ||
          left.label.localeCompare(right.label, "ru")
      )
      .slice(0, 10);
  }, [graph]);

  if (clusters.length === 0) return null;

  return (
    <section className={`cluster-islands-panel ${enabled ? "" : "is-disabled"}`}>
      <div className="stats-heading">
        <div>
          <p className="eyebrow">Музыкальные острова(beta)</p>
          <h2>Группы по прослушанным коллабам</h2>
        </div>
        <span className="cluster-islands-note">
          {enabled ? "Наведи на остров, чтобы подсветить артистов" : "Включи чекбокс «Острова» и «Мои коллабы»"}
        </span>
      </div>
      <div className="cluster-islands-list">
        {clusters.map((cluster) => (
          <button
            className={`cluster-island-card ${activeClusterId === cluster.id ? "active" : ""}`}
            disabled={!enabled}
            key={cluster.id}
            onClick={() => onSelectCluster(activeClusterId === cluster.id ? null : cluster.id)}
            onMouseEnter={() => onHoverCluster(cluster.id)}
            onMouseLeave={() => onHoverCluster(null)}
            style={{ "--cluster-color": cluster.color } as CSSProperties}
            type="button"
          >
            <i />
            <strong>{cluster.label}</strong>
            <span>{cluster.size} артистов, {cluster.totalListenCount} прослушиваний</span>
            <em>{cluster.topArtists.join(", ")}</em>
          </button>
        ))}
      </div>
    </section>
  );
}

function GraphStatsPanel({ graph }: { graph: GraphResponse | null }) {
  const stats = useMemo(() => {
    if (!graph) return null;
    const topArtists = [...graph.nodes]
      .filter((node) => graphNodeScore(node) > 0)
      .sort((left, right) => graphNodeScore(right) - graphNodeScore(left) || left.name.localeCompare(right.name))
      .slice(0, 10);
    const maxScore = Math.max(...topArtists.map(graphNodeScore), 1);
    const collabEdges = graph.edges.filter((edge) => edge.type === "collab").length;
    const catalogEdges = graph.edges.filter((edge) => edge.type === "catalog_collab").length;
    const similarEdges = graph.edges.filter((edge) => edge.type === "similar").length;
    const likedArtists = graph.nodes.filter((node) => node.isLikedArtist).length;

    return {
      topArtists,
      maxScore,
      collabEdges,
      catalogEdges,
      similarEdges,
      likedArtists
    };
  }, [graph]);

  if (!graph || !stats || stats.topArtists.length === 0) {
    return null;
  }

  return (
    <section className="graph-stats-panel">
      <div className="stats-heading">
        <div>
          <p className="eyebrow">Статистика</p>
          <h2>Топ-10 артистов по знакомым трекам</h2>
        </div>
        <div className="stats-summary">
          <span>
            <strong>{graph.nodes.length}</strong>
            артистов
          </span>
          <span>
            <strong>{graph.edges.length}</strong>
            связей
          </span>
          <span>
            <strong>{stats.likedArtists}</strong>
            лайкнутых
          </span>
        </div>
      </div>

      <div className="stats-grid">
        <div className="top-artists-list">
          {stats.topArtists.map((artist, index) => {
            const score = graphNodeScore(artist);
            return (
              <article className="top-artist-row" key={artist.id}>
                <span className="top-artist-rank">{index + 1}</span>
                {artist.image ? <img src={artist.image} alt="" /> : <span className="artist-fallback">{artist.name[0]}</span>}
                <div>
                  <strong>{artist.name}</strong>
                  <p>{graphNodeScoreLabel(artist)}</p>
                  <span className="top-artist-bar">
                    <i style={{ width: `${Math.max(8, (score / stats.maxScore) * 100)}%` }} />
                  </span>
                </div>
              </article>
            );
          })}
        </div>

        <div className="connection-breakdown">
          <article>
            <strong>{stats.collabEdges}</strong>
            <span>зеленых коллабов, которые ты слышал</span>
          </article>
          <article>
            <strong>{stats.catalogEdges}</strong>
            <span>коллабов из дискографии для исследования</span>
          </article>
          <article>
            <strong>{stats.similarEdges}</strong>
            <span>похожих связей от Яндекса</span>
          </article>
        </div>
      </div>
    </section>
  );
}

function SharedArtistsPanel({
  graph,
  overlayMatches
}: {
  graph: GraphResponse | null;
  overlayMatches: Record<string, GraphOverlayMatch[]>;
}) {
  const rows = useMemo(() => {
    if (!graph) return [];
    return graph.nodes
      .map((artist) => {
        const matches = overlayMatches[artist.id] ?? [];
        if (matches.length === 0) return null;
        const commonTracks = [...new Set(matches.flatMap((match) => match.commonTracks))];
        const friendScore = matches.reduce((sum, match) => sum + match.friendScore, 0);
        const myScore = graphNodeScore(artist);
        return {
          artist,
          matches,
          commonTracks,
          myScore,
          friendScore,
          totalScore: myScore + friendScore
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .sort(
        (left, right) =>
          right.totalScore - left.totalScore ||
          right.commonTracks.length - left.commonTracks.length ||
          left.artist.name.localeCompare(right.artist.name)
      )
      .slice(0, 12);
  }, [graph, overlayMatches]);

  if (!graph || rows.length === 0) return null;

  return (
    <section className="shared-artists-panel">
      <div className="stats-heading">
        <div>
          <p className="eyebrow">Пересечения</p>
          <h2>Самые пересеченные артисты по количеству знакомых песен</h2>
        </div>
        <div className="stats-summary">
          <span>
            <strong>{rows.length}</strong>
            в топе
          </span>
          <span>
            <strong>{rows.reduce((sum, row) => sum + row.commonTracks.length, 0)}</strong>
            общих треков
          </span>
        </div>
      </div>

      <div className="shared-artists-list">
        {rows.map((row, index) => (
          <article className="shared-artist-row" key={row.artist.id}>
            <span className="top-artist-rank">{index + 1}</span>
            {row.artist.image ? (
              <img src={row.artist.image} alt="" />
            ) : (
              <span className="artist-fallback">{row.artist.name[0]}</span>
            )}
            <div className="shared-artist-main">
              <div className="shared-artist-title">
                <strong>{row.artist.name}</strong>
                <span>{row.totalScore} знакомых вместе</span>
              </div>
              <p>
                у тебя {row.myScore}, у добавленных пользователей {row.friendScore}
              </p>
              <div className="shared-friend-dots">
                {row.matches.map((match) => (
                  <span style={{ "--overlay-color": match.color } as CSSProperties} key={match.userId}>
                    <i />
                    {match.label}
                  </span>
                ))}
              </div>
              {row.commonTracks.length > 0 ? (
                <div className="common-track-chips">
                  {row.commonTracks.slice(0, 5).map((track) => (
                    <span key={track}>{track}</span>
                  ))}
                  {row.commonTracks.length > 5 && <span>+{row.commonTracks.length - 5}</span>}
                </div>
              ) : (
                <em className="common-track-empty">Общие треки в синхронизированных данных пока не найдены</em>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [friendOverlays, setFriendOverlays] = useState<FriendGraphOverlay[]>([]);
  const friendOverlaysRef = useRef<FriendGraphOverlay[]>([]);
  const graphRequestSeqRef = useRef(0);
  const overlayRefreshSeqRef = useRef(0);
  const [loadingOverlayIds, setLoadingOverlayIds] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(100);
  const [minListens, setMinListens] = useState(1);
  const [draftLimit, setDraftLimit] = useState(100);
  const [draftMinListens, setDraftMinListens] = useState(1);
  const [search, setSearch] = useState("");
  const [graphDepth, setGraphDepth] = useState(1);
  const [draftGraphDepth, setDraftGraphDepth] = useState(1);
  const [repulsionStrength, setRepulsionStrength] = useState(760);
  const [showCollabs, setShowCollabs] = useState(true);
  const [showCatalogCollabs, setShowCatalogCollabs] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);
  const [showIslands, setShowIslands] = useState(false);
  const [hoveredClusterId, setHoveredClusterId] = useState<string | null>(null);
  const [activeClusterId, setActiveClusterId] = useState<string | null>(null);
  const [highlightIntersections, setHighlightIntersections] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [shareGraph, setShareGraph] = useState<GraphResponse | null>(null);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [loadingShareGraph, setLoadingShareGraph] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(() => {
    return readInviteCodeFromUrl() ?? readStoredInviteCode();
  });

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((response) => {
        if (
          response.user.terms_version !== LEGAL_VERSION ||
          response.user.privacy_version !== LEGAL_VERSION
        ) {
          clearToken();
          return;
        }
        setUser(response.user);
      })
      .catch(() => clearToken());
  }, []);

  useEffect(() => {
    friendOverlaysRef.current = friendOverlays;
  }, [friendOverlays]);

  const graphParamsString = useMemo(() => {
    const edgeTypes = ["collab", "catalog_collab", "similar"];
    return new URLSearchParams({
      limit: String(limit),
      min_listens: String(minListens),
      depth: String(graphDepth),
      edge_types: edgeTypes.join(",")
    }).toString();
  }, [graphDepth, limit, minListens]);

  const commitLimit = useCallback((nextValue: number) => {
    const normalized = Math.max(25, Math.min(5000, Math.round(nextValue / 50) * 50));
    setDraftLimit(normalized);
    setLimit(normalized);
  }, []);

  const commitMinListens = useCallback((nextValue: number) => {
    const normalized = Math.max(1, Number.isFinite(nextValue) ? Math.floor(nextValue) : 1);
    setDraftMinListens(normalized);
    setMinListens(normalized);
  }, []);

  const commitGraphDepth = useCallback((nextValue: number) => {
    const normalized = Math.max(1, Math.min(3, Math.round(nextValue)));
    setDraftGraphDepth(normalized);
    setGraphDepth(normalized);
  }, []);

  const commitGraphControls = useCallback(() => {
    commitLimit(draftLimit);
    commitMinListens(draftMinListens);
    commitGraphDepth(draftGraphDepth);
  }, [commitGraphDepth, commitLimit, commitMinListens, draftGraphDepth, draftLimit, draftMinListens]);

  const graphControlsChanged =
    draftLimit !== limit ||
    draftMinListens !== minListens ||
    draftGraphDepth !== graphDepth;

  const loadGraph = useCallback(async () => {
    if (!user) return;
    const requestSeq = graphRequestSeqRef.current + 1;
    graphRequestSeqRef.current = requestSeq;
    setLoadingGraph(true);
    setError(null);
    try {
      const nextGraph = await api.graphMe(new URLSearchParams(graphParamsString));
      if (graphRequestSeqRef.current !== requestSeq) return;
      setGraph(nextGraph);
    } catch (graphError) {
      if (graphRequestSeqRef.current !== requestSeq) return;
      setError(graphError instanceof Error ? graphError.message : "Граф не загрузился");
    } finally {
      if (graphRequestSeqRef.current === requestSeq) {
        setLoadingGraph(false);
      }
    }
  }, [graphParamsString, user]);

  const handleRefreshGraph = useCallback(() => {
    commitGraphControls();
    if (!graphControlsChanged) {
      void loadGraph();
    }
  }, [commitGraphControls, graphControlsChanged, loadGraph]);

  useEffect(() => {
    if (!user) return;

    const timer = window.setTimeout(() => {
      void loadGraph();
    }, 320);

    return () => window.clearTimeout(timer);
  }, [loadGraph, user]);

  const islandsAvailable = showCollabs && (graph?.clusters?.length ?? 0) > 0;
  const islandsEnabled = showIslands && islandsAvailable;

  useEffect(() => {
    if (islandsAvailable) return;
    setShowIslands(false);
    setHoveredClusterId(null);
    setActiveClusterId(null);
  }, [islandsAvailable]);

  const shareGraphReady = Boolean(
    graph &&
      graph.nodes.length > 0 &&
      !loadingShareGraph
  );
  const shareLaunchHint = !graph
    ? "Сначала загрузи граф."
    : loadingShareGraph
      ? "Собираю максимум известных данных..."
      : "Соберет карточку по максимуму известных данных.";

  const openShareModal = useCallback(async () => {
    if (!graph || graph.nodes.length === 0 || loadingShareGraph) return;
    setLoadingShareGraph(true);
    setError(null);
    try {
      const maxGraph = await api.graphMe(new URLSearchParams(SHARE_MAX_GRAPH_PARAMS));
      if (maxGraph.nodes.length === 0) {
        throw new Error("Нет данных для карточки");
      }
      setShareGraph(maxGraph);
      setShareModalOpen(true);
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : "Не удалось собрать карточку");
    } finally {
      setLoadingShareGraph(false);
    }
  }, [graph, loadingShareGraph]);

  const setOverlayLoading = useCallback((friendId: string, isLoading: boolean) => {
    setLoadingOverlayIds((current) => {
      const next = new Set(current);
      if (isLoading) {
        next.add(friendId);
      } else {
        next.delete(friendId);
      }
      return next;
    });
  }, []);

  const toggleFriendOverlay = useCallback(
    async (friend: Friend) => {
      const friendId = friend.friend.id;
      if (friendOverlaysRef.current.some((overlay) => overlay.userId === friendId)) {
        setFriendOverlays((current) => current.filter((overlay) => overlay.userId !== friendId));
        return;
      }

      setOverlayLoading(friendId, true);
      setError(null);
      try {
        const friendGraph = await api.graphUser(friendId, new URLSearchParams(graphParamsString));
        const overlay: FriendGraphOverlay = {
          userId: friendId,
          label: friend.friend.display_login,
          color: overlayColorFor(friendId),
          graph: friendGraph
        };
        setFriendOverlays((current) =>
          current.some((item) => item.userId === friendId) ? current : [...current, overlay]
        );
      } catch (overlayError) {
        setError(
          overlayError instanceof Error
            ? overlayError.message
            : "Не получилось добавить друга на визуализацию"
        );
      } finally {
        setOverlayLoading(friendId, false);
      }
    },
    [graphParamsString, setOverlayLoading]
  );

  const handleFriendRemoved = useCallback((friendId: string) => {
    setFriendOverlays((current) => current.filter((overlay) => overlay.userId !== friendId));
    setLoadingOverlayIds((current) => {
      const next = new Set(current);
      next.delete(friendId);
      return next;
    });
  }, []);

  const handleInviteAccepted = useCallback(() => {
    clearPendingInviteCode();
    setPendingInviteCode(null);
  }, []);

  useEffect(() => {
    if (!user || friendOverlaysRef.current.length === 0) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const requestSeq = overlayRefreshSeqRef.current + 1;
      overlayRefreshSeqRef.current = requestSeq;
      const overlaysToRefresh = friendOverlaysRef.current.map(({ userId, label, color }) => ({
        userId,
        label,
        color
      }));

      overlaysToRefresh.forEach((overlay) => setOverlayLoading(overlay.userId, true));
      void Promise.all(
        overlaysToRefresh.map(async (overlay) => ({
          ...overlay,
          graph: await api.graphUser(overlay.userId, new URLSearchParams(graphParamsString))
        }))
      )
        .then((nextOverlays) => {
          if (cancelled || overlayRefreshSeqRef.current !== requestSeq) return;
          setFriendOverlays((current) =>
            nextOverlays.filter((overlay) => current.some((item) => item.userId === overlay.userId))
          );
        })
        .catch((overlayError) => {
          if (cancelled || overlayRefreshSeqRef.current !== requestSeq) return;
          setError(
            overlayError instanceof Error
              ? overlayError.message
              : "Не получилось обновить пересечения друзей"
          );
        })
        .finally(() => {
          if (overlayRefreshSeqRef.current !== requestSeq) return;
          overlaysToRefresh.forEach((overlay) => setOverlayLoading(overlay.userId, false));
        });
    }, 320);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [graphParamsString, setOverlayLoading, user]);

  useEffect(() => {
    if (friendOverlays.length === 0) {
      setHighlightIntersections(false);
    }
  }, [friendOverlays.length]);

  const overlayFriendIds = useMemo(
    () => friendOverlays.map((overlay) => overlay.userId),
    [friendOverlays]
  );

  const loadingOverlayIdList = useMemo(
    () => [...loadingOverlayIds],
    [loadingOverlayIds]
  );

  const overlayStats = useMemo(() => {
    if (!graph) return [];
    return friendOverlays.map((overlay) => {
      const friendIds = new Set(overlay.graph.nodes.map((node) => node.id));
      const friendNames = new Set(
        overlay.graph.nodes.map((node) => normalizeArtistName(node.name)).filter(Boolean)
      );
      const sharedCount = graph.nodes.filter((node) => {
        const normalizedName = normalizeArtistName(node.name);
        return friendIds.has(node.id) || (normalizedName && friendNames.has(normalizedName));
      }).length;
      const overlapPercent = graph.nodes.length > 0 ? Math.round((sharedCount / graph.nodes.length) * 1000) / 10 : 0;
      return {
        userId: overlay.userId,
        label: overlay.label,
        color: overlay.color,
        sharedCount,
        overlapPercent,
        friendArtistCount: friendIds.size
      };
    });
  }, [friendOverlays, graph]);

  const overlayMatches = useMemo<Record<string, GraphOverlayMatch[]>>(() => {
    if (!graph || friendOverlays.length === 0) return {};

    const matches: Record<string, GraphOverlayMatch[]> = {};
    for (const overlay of friendOverlays) {
      const friendIds = new Set(overlay.graph.nodes.map((node) => node.id));
      const friendNodesById = new Map(overlay.graph.nodes.map((node) => [node.id, node]));
      const friendNodesByName = new Map(
        overlay.graph.nodes.map((node) => [normalizeArtistName(node.name), node])
      );
      const friendNames = new Set(
        overlay.graph.nodes.map((node) => normalizeArtistName(node.name)).filter(Boolean)
      );
      for (const artist of graph.nodes) {
        const artistName = normalizeArtistName(artist.name);
        if (!friendIds.has(artist.id) && (!artistName || !friendNames.has(artistName))) continue;
        const friendNode = friendNodesById.get(artist.id) ?? friendNodesByName.get(artistName);
        matches[artist.id] = [
          ...(matches[artist.id] ?? []),
          {
            userId: overlay.userId,
            label: overlay.label,
            color: overlay.color,
            myScore: graphNodeScore(artist),
            friendScore: friendNode ? graphNodeScore(friendNode) : 0,
            commonTracks: commonTrackTitles(artist.listenedTracks, friendNode?.listenedTracks ?? [])
          }
        ];
      }
    }
    return matches;
  }, [friendOverlays, graph]);

  function logout() {
    clearToken();
    setUser(null);
    setGraph(null);
    setShareGraph(null);
    setShareModalOpen(false);
    setFriendOverlays([]);
  }

  async function deleteAccount() {
    const confirmed = window.confirm(
      "Удалить аккаунт Music Graph и сохраненные данные: токены Яндекса, историю, статистику, граф, друзей и приглашения? Это действие нельзя отменить."
    );
    if (!confirmed) return;

    try {
      await api.deleteMe();
      clearToken();
      setUser(null);
      setGraph(null);
      setShareGraph(null);
      setShareModalOpen(false);
      setFriendOverlays([]);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Не удалось удалить данные");
    }
  }

  if (!user) {
    return <LoginScreen onLogin={setUser} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Music Graph</p>
          <h1>{user.display_login}</h1>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button danger"
            onClick={() => void deleteAccount()}
            aria-label="delete account data"
            title="Удалить аккаунт Music Graph и все сохраненные данные"
          >
            <Trash2 size={18} />
          </button>
          <button className="icon-button" onClick={logout} aria-label="logout" title="Выйти только на этом устройстве">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="dashboard-guide" aria-label="Как читать Music Graph">
        <div>
          <p className="eyebrow">Как читать граф</p>
          <h2>Это карта твоих артистов: коллабы, похожие исполнители и музыкальные острова</h2>
        </div>
        <div className="dashboard-guide-grid">
          {dashboardGuide.map((item) => (
            <article key={item.title}>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="layout">
        <aside className="left-rail">
          <FriendsPanel
            initialInviteCode={pendingInviteCode}
            onInviteAccepted={handleInviteAccepted}
            overlayFriendIds={overlayFriendIds}
            loadingOverlayIds={loadingOverlayIdList}
            onToggleOverlayFriend={(friend) => void toggleFriendOverlay(friend)}
            onFriendRemoved={handleFriendRemoved}
          />
          <section className="share-launch-panel">
            <button
              className="primary-action share-result-button"
              disabled={!shareGraphReady}
              onClick={() => void openShareModal()}
              type="button"
            >
              <Share2 size={18} />
              {loadingShareGraph ? "Собираю карточку" : "Поделиться результатом"}
            </button>
            <span>{shareLaunchHint}</span>
          </section>
        </aside>

        <section className="workspace">
          <SyncPanel
            onComplete={loadGraph}
          />

          <section className="toolbar-section controls">
            <div className="search-box" title="Фильтрует граф по имени артиста и оставляет связанные с ним узлы">
              <Search size={17} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти артиста" />
            </div>
            <label className="slider-control" title="Сколько основных артистов брать в граф по твоей статистике">
              <SlidersHorizontal size={17} />
              <span>Top {draftLimit}</span>
              <input
                type="range"
                min="25"
                max="5000"
                step="50"
                value={draftLimit}
                onBlur={(event) => commitLimit(Number(event.currentTarget.value))}
                onChange={(event) => setDraftLimit(Number(event.target.value))}
                onKeyDown={(event) => {
                  if (shouldCommitRangeKey(event)) {
                    commitLimit(Number(event.currentTarget.value));
                  }
                }}
                onPointerCancel={(event) => {
                  releaseRangePointer(event);
                  commitLimit(Number(event.currentTarget.value));
                }}
                onPointerDown={captureRangePointer}
                onPointerUp={(event) => {
                  releaseRangePointer(event);
                  commitLimit(Number(event.currentTarget.value));
                }}
              />
            </label>
            <label className="number-control" title="Минимум синхронизированных прослушиваний, чтобы артист попал в основу графа">
              Min
              <input
                type="number"
                min="1"
                value={draftMinListens}
                onBlur={(event) => commitMinListens(Number(event.currentTarget.value))}
                onChange={(event) => setDraftMinListens(Math.max(1, Number(event.target.value)))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitMinListens(Number(event.currentTarget.value));
                  }
                }}
              />
            </label>
            <label className="slider-control" title="Сколько слоёв связей показывать: 1 — от твоих артистов, 2 — от найденных артистов дальше, 3 — ещё глубже">
              <SlidersHorizontal size={17} />
              <span>Глубина {draftGraphDepth}</span>
              <input
                type="range"
                min="1"
                max="3"
                step="1"
                value={draftGraphDepth}
                onBlur={(event) => commitGraphDepth(Number(event.currentTarget.value))}
                onChange={(event) => setDraftGraphDepth(Number(event.target.value))}
                onKeyDown={(event) => {
                  if (shouldCommitRangeKey(event)) {
                    commitGraphDepth(Number(event.currentTarget.value));
                  }
                }}
                onPointerCancel={(event) => {
                  releaseRangePointer(event);
                  commitGraphDepth(Number(event.currentTarget.value));
                }}
                onPointerDown={captureRangePointer}
                onPointerUp={(event) => {
                  releaseRangePointer(event);
                  commitGraphDepth(Number(event.currentTarget.value));
                }}
              />
            </label>
            <label className="slider-control force-control" title="Сила отталкивания пузырей: больше значение — артисты сильнее разъезжаются, меньше — граф плотнее">
              <SlidersHorizontal size={17} />
              <span>Отталкивание {repulsionStrength}</span>
              <input
                type="range"
                min="120"
                max="2200"
                step="20"
                value={repulsionStrength}
                onChange={(event) => setRepulsionStrength(Number(event.target.value))}
              />
            </label>
            <label className="toggle-chip" title="Коллабы из твоих лайков, истории и волны: артисты на одном прослушанном треке">
              <input
                type="checkbox"
                checked={showCollabs}
                onChange={(event) => setShowCollabs(event.target.checked)}
              />
              <Filter size={15} />
              Мои коллабы
            </label>
            <label className="toggle-chip" title="Показывает синие связи из дискографии: найденные коллабы, которые не совпадают с уже прослушанными треками">
              <input
                type="checkbox"
                checked={showCatalogCollabs}
                onChange={(event) => setShowCatalogCollabs(event.target.checked)}
              />
              Дискография
            </label>
            <label className="toggle-chip" title="Похожие артисты Яндекса. Показываются только артисты, у которых знакомых треков больше 0">
              <input
                type="checkbox"
                checked={showSimilar}
                onChange={(event) => setShowSimilar(event.target.checked)}
              />
              Похожие
            </label>
            <label
              className="toggle-chip islands-toggle"
              title={
                islandsAvailable
                  ? "Подсветить музыкальные острова: группы артистов, связанных твоими прослушанными коллабами"
                  : "Острова появятся, когда в графе есть прослушанные коллабы"
              }
            >
              <input
                type="checkbox"
                checked={islandsEnabled}
                disabled={!islandsAvailable}
                onChange={(event) => setShowIslands(event.target.checked)}
              />
              Острова(beta)
            </label>
            <label
              className="toggle-chip intersection-toggle"
              title={
                friendOverlays.length === 0
                  ? "Сначала добавь друга кнопкой + в панели друзей"
                  : "Приглушить все не-общие вершины и оставить яркими пересечения с добавленными пользователями"
              }
            >
              <input
                type="checkbox"
                checked={highlightIntersections}
                disabled={friendOverlays.length === 0}
                onChange={(event) => setHighlightIntersections(event.target.checked)}
              />
              Пересечения
            </label>
            <button
              className="icon-button wide"
              disabled={loadingGraph}
              onClick={handleRefreshGraph}
              title="Перезагрузить граф с текущими фильтрами"
            >
              Обновить граф
            </button>
          </section>
          {overlayStats.length > 0 && (
            <section className="comparison-strip overlay-strip">
              <span>Пересечения на графе</span>
              {overlayStats.map((item) => (
                <button
                  className="overlay-stat-chip"
                  key={item.userId}
                  onClick={() =>
                    setFriendOverlays((current) =>
                      current.filter((overlay) => overlay.userId !== item.userId)
                    )
                  }
                  style={{ "--overlay-color": item.color } as CSSProperties}
                  title="Убрать пользователя с визуализации"
                  type="button"
                >
                  <i />
                  <strong>{item.sharedCount}</strong>
                  <span>{item.label}, {item.overlapPercent}%</span>
                </button>
              ))}
            </section>
          )}

          {error && <p className="error-text">{error}</p>}
          <GraphCanvas
            graph={graph}
            search={search}
            repulsionStrength={repulsionStrength}
            showCollabEdges={showCollabs}
            showCatalogCollabEdges={showCatalogCollabs}
            showSimilarEdges={showSimilar}
            overlayMatches={overlayMatches}
            highlightIntersections={highlightIntersections}
            showIslands={islandsEnabled}
            hoveredClusterId={hoveredClusterId}
            activeClusterId={activeClusterId}
            onHoverCluster={setHoveredClusterId}
            onSelectCluster={setActiveClusterId}
          />
          <ClusterIslandsPanel
            activeClusterId={activeClusterId}
            enabled={islandsEnabled}
            graph={graph}
            onHoverCluster={setHoveredClusterId}
            onSelectCluster={setActiveClusterId}
          />
          <SharedArtistsPanel graph={graph} overlayMatches={overlayMatches} />
          <GraphStatsPanel graph={graph} />
          <PlaylistPanel disabled={!graph || graph.nodes.length === 0} />
        </section>
      </section>

      <footer className="app-footer">
        <strong>Music Graph</strong>
        <span>Неофициальный эксперимент поверх Яндекс Музыки: данные хранятся локально в этом проекте и удаляются кнопкой с корзиной вверху.</span>
        <span>Плейлисты создаются только после твоего подтверждения и приватными по умолчанию.</span>
      </footer>
      {shareModalOpen && shareGraph && (
        <ShareCardModal graph={shareGraph} user={user} onClose={() => setShareModalOpen(false)} />
      )}
    </main>
  );
}
