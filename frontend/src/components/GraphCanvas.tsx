import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { GraphCluster, GraphEdge, GraphNode, GraphOverlayMatch, GraphResponse } from "../types/api";

type Props = {
  graph: GraphResponse | null;
  search: string;
  repulsionStrength: number;
  showCollabEdges: boolean;
  showCatalogCollabEdges: boolean;
  showSimilarEdges: boolean;
  overlayMatches?: Record<string, GraphOverlayMatch[]>;
  highlightIntersections?: boolean;
  showIslands?: boolean;
  hoveredClusterId?: string | null;
  activeClusterId?: string | null;
  onHoverCluster?: (clusterId: string | null) => void;
  onSelectCluster?: (clusterId: string | null) => void;
};

type SimNode = GraphNode & d3.SimulationNodeDatum;
type SimEdge = Omit<GraphEdge, "source" | "target"> & {
  source: SimNode | string;
  target: SimNode | string;
};

type VisibleCluster = GraphCluster & {
  visibleNodeIds: string[];
};

function nodeWeight(node: GraphNode): number {
  if (typeof node.knownTrackCount === "number" && node.knownTrackCount > 0) {
    return node.knownTrackCount;
  }
  return node.trackCount || node.listenCount;
}

function nodeRadius(node: GraphNode): number {
  const radius = 24 + Math.sqrt(Math.max(nodeWeight(node), 1)) * 6.8;
  if (node.isSimilarOnly && node.isCatalogOnly) return Math.max(34, Math.min(92, radius));
  if (node.isCatalogOnly || node.isSimilarOnly) return Math.max(32, Math.min(88, radius));
  return Math.max(34, Math.min(96, radius));
}

function hasUserEvidence(node: GraphNode): boolean {
  return (
    (node.knownTrackCount ?? 0) > 0 ||
    node.listenCount > 0 ||
    node.trackCount > 0 ||
    (node.waveTrackCount ?? 0) > 0 ||
    (node.collectionTrackCount ?? 0) > 0
  );
}

function nodeClipId(node: GraphNode): string {
  return `artist-avatar-${node.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function edgeDistance(edge: SimEdge): number {
  if (edge.type === "catalog_collab") return 188;
  if (edge.type === "similar") return 174;
  return 132;
}

function edgeStrength(edge: SimEdge): number {
  if (edge.type === "catalog_collab") return 0.2;
  if (edge.type === "similar") return 0.14;
  return 0.28;
}

function endpointId(endpoint: SimNode | string): string {
  return typeof endpoint === "string" ? endpoint : endpoint.id;
}

function artistPairKey(left: string, right: string): string {
  return [left, right].sort().join("::");
}

function edgePairKey(edge: Pick<GraphEdge, "source" | "target">): string {
  return artistPairKey(edge.source, edge.target);
}

function simEdgePairKey(edge: SimEdge): string {
  return artistPairKey(endpointId(edge.source), endpointId(edge.target));
}

function shouldShowLocalTrackCount(node: GraphNode): boolean {
  if (node.isSimilarOnly || node.trackCount <= 0) return false;
  return node.trackCount !== node.collectionTrackCount && node.trackCount !== node.knownTrackCount;
}

function edgeTypeLabel(type: string): string {
  if (type === "catalog_collab") return "Неслушанный коллаб";
  if (type === "similar") return "Похожий";
  return "Прослушанный трек";
}

function edgeTypePriority(type: string): number {
  if (type === "catalog_collab") return 0;
  if (type === "collab") return 1;
  return 2;
}

function graphEdgeKey(edge: GraphEdge): string {
  return `${edge.type}:${edge.source}:${edge.target}`;
}

function clusterHullPath(clusterNodes: SimNode[], radiusOf: (item: GraphNode) => number): string | null {
  const points: [number, number][] = [];
  for (const node of clusterNodes) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const radius = radiusOf(node) + 34;
    for (let index = 0; index < 6; index += 1) {
      const angle = (Math.PI * 2 * index) / 6;
      points.push([x + Math.cos(angle) * radius, y + Math.sin(angle) * radius]);
    }
  }
  const hull = d3.polygonHull(points);
  if (!hull) return null;
  return `M${hull.map(([x, y]) => `${x},${y}`).join("L")}Z`;
}

export function GraphCanvas({
  graph,
  search,
  repulsionStrength,
  showCollabEdges,
  showCatalogCollabEdges,
  showSimilarEdges,
  overlayMatches = {},
  highlightIntersections = false,
  showIslands = false,
  hoveredClusterId = null,
  activeClusterId = null,
  onHoverCluster,
  onSelectCluster
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const activeClusterIdRef = useRef<string | null>(activeClusterId);
  const hoveredClusterIdRef = useRef<string | null>(hoveredClusterId);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const normalizedSearch = search.trim().toLowerCase();

  useEffect(() => {
    activeClusterIdRef.current = activeClusterId;
    hoveredClusterIdRef.current = hoveredClusterId;
  }, [activeClusterId, hoveredClusterId]);

  const visibleEdgeTypes = useMemo(() => {
    const types = new Set<string>();
    if (showCollabEdges) types.add("collab");
    if (showCatalogCollabEdges) types.add("catalog_collab");
    if (showSimilarEdges) types.add("similar");
    return types;
  }, [showCatalogCollabEdges, showCollabEdges, showSimilarEdges]);

  const filteredGraph = useMemo(() => {
    if (!graph) return graph;

    const edges = graph.edges.filter((edge) => visibleEdgeTypes.has(edge.type));
    const connectedIds = new Set<string>();
    for (const edge of edges) {
      connectedIds.add(edge.source);
      connectedIds.add(edge.target);
    }

    for (const node of graph.nodes) {
      if (!node.isSimilarOnly && !node.isCatalogOnly) {
        connectedIds.add(node.id);
      } else if (node.isCatalogOnly && hasUserEvidence(node)) {
        connectedIds.add(node.id);
      }
    }

    return {
      ...graph,
      nodes: graph.nodes.filter((node) => connectedIds.has(node.id)),
      edges
    };
  }, [graph, visibleEdgeTypes]);

  const graphContext = useMemo(() => {
    const tiers = new Map<string, "primary" | "neighbor" | "context">();
    if (!filteredGraph) {
      return { graph: filteredGraph, tiers };
    }

    const existingIds = new Set(filteredGraph.nodes.map((node) => node.id));
    const primaryIds = new Set<string>();
    if (focusedNodeId && existingIds.has(focusedNodeId)) {
      primaryIds.add(focusedNodeId);
    } else if (normalizedSearch) {
      filteredGraph.nodes
        .filter((node) => node.name.toLowerCase().includes(normalizedSearch))
        .forEach((node) => primaryIds.add(node.id));
    }

    if (primaryIds.size === 0) {
      return { graph: filteredGraph, tiers };
    }

    const firstHopIds = new Set(primaryIds);
    for (const edge of filteredGraph.edges) {
      if (primaryIds.has(edge.source) || primaryIds.has(edge.target)) {
        firstHopIds.add(edge.source);
        firstHopIds.add(edge.target);
      }
    }

    const secondHopIds = new Set(firstHopIds);
    for (const edge of filteredGraph.edges) {
      if (firstHopIds.has(edge.source) || firstHopIds.has(edge.target)) {
        secondHopIds.add(edge.source);
        secondHopIds.add(edge.target);
      }
    }

    primaryIds.forEach((id) => tiers.set(id, "primary"));
    firstHopIds.forEach((id) => {
      if (!tiers.has(id)) tiers.set(id, "neighbor");
    });
    secondHopIds.forEach((id) => {
      if (!tiers.has(id)) tiers.set(id, "context");
    });

    return {
      graph: {
        ...filteredGraph,
        nodes: filteredGraph.nodes.filter((node) => secondHopIds.has(node.id)),
        edges: filteredGraph.edges.filter((edge) => secondHopIds.has(edge.source) && secondHopIds.has(edge.target))
      },
      tiers
    };
  }, [filteredGraph, focusedNodeId, normalizedSearch]);

  const visibleGraph = graphContext.graph;
  const contextTiers = graphContext.tiers;
  const visibleClusters = useMemo<VisibleCluster[]>(() => {
    if (!visibleGraph?.clusters?.length) return [];
    const visibleNodeIds = new Set(visibleGraph.nodes.map((node) => node.id));
    return visibleGraph.clusters
      .map((cluster) => ({
        ...cluster,
        visibleNodeIds: cluster.nodeIds.filter((nodeId) => visibleNodeIds.has(nodeId))
      }))
      .filter((cluster) => cluster.visibleNodeIds.length > 1);
  }, [visibleGraph]);
  const clusterById = useMemo(() => {
    return new Map(visibleClusters.map((cluster) => [cluster.id, cluster]));
  }, [visibleClusters]);
  const highlightedClusterId = activeClusterId ?? hoveredClusterId;
  const highlightedCluster = highlightedClusterId ? clusterById.get(highlightedClusterId) ?? null : null;
  const highlightedClusterNodeIds = useMemo(() => {
    return new Set(highlightedCluster?.visibleNodeIds ?? []);
  }, [highlightedCluster]);

  useEffect(() => {
    if (!focusedNodeId || !filteredGraph) return;
    if (!filteredGraph.nodes.some((node) => node.id === focusedNodeId)) {
      setFocusedNodeId(null);
    }
  }, [filteredGraph, focusedNodeId]);

  const nodeNames = useMemo(() => {
    return new Map((visibleGraph?.nodes ?? []).map((node) => [node.id, node.name]));
  }, [visibleGraph]);

  const focusedNode = useMemo(() => {
    if (!focusedNodeId) return null;
    return visibleGraph?.nodes.find((node) => node.id === focusedNodeId) ?? null;
  }, [focusedNodeId, visibleGraph]);

  const tooltipNode = hovered ?? focusedNode;
  const tooltipOverlayMatches = tooltipNode ? overlayMatches[tooltipNode.id] ?? [] : [];
  const intersectionNodeIds = useMemo(() => {
    return new Set(
      Object.entries(overlayMatches)
        .filter(([, matches]) => matches.length > 0)
        .map(([artistId]) => artistId)
    );
  }, [overlayMatches]);
  const hasIntersectionHighlight = highlightIntersections && intersectionNodeIds.size > 0;
  const listenedPairKeys = useMemo(() => {
    return new Set((graph?.edges ?? []).filter((edge) => edge.type === "collab").map(edgePairKey));
  }, [graph]);
  const unheardKnownCollabNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of visibleGraph?.edges ?? []) {
      if (edge.type !== "catalog_collab" || !listenedPairKeys.has(edgePairKey(edge))) continue;
      ids.add(edge.source);
      ids.add(edge.target);
    }
    return ids;
  }, [listenedPairKeys, visibleGraph]);
  const tooltipHasUnheardKnownCollabs = tooltipNode ? unheardKnownCollabNodeIds.has(tooltipNode.id) : false;

  const hoveredEdges = useMemo(() => {
    if (!visibleGraph || !tooltipNode) return [];
    return visibleGraph.edges
      .filter((edge) => edge.source === tooltipNode.id || edge.target === tooltipNode.id)
      .sort((left, right) => edgeTypePriority(left.type) - edgeTypePriority(right.type) || right.weight - left.weight)
      .slice(0, 8);
  }, [tooltipNode, visibleGraph]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !visibleGraph) return;

    const width = svg.clientWidth || 960;
    const height = svg.clientHeight || 640;
    const nodes: SimNode[] = visibleGraph.nodes.map((node) => ({ ...node }));
    const nodeMap = new Map(nodes.map((node) => [node.id, node]));
    const links: SimEdge[] = visibleGraph.edges
      .filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target))
      .map((edge) => ({ ...edge }));
    const radiusById = new Map(nodes.map((item) => [item.id, nodeRadius(item)]));
    const radiusOf = (item: GraphNode) => radiusById.get(item.id) ?? nodeRadius(item);
    const activeIslandClusters = showIslands
      ? visibleClusters.filter((cluster) => cluster.visibleNodeIds.some((nodeId) => nodeMap.has(nodeId)))
      : [];
    const islandCenterById = new Map<string, { x: number; y: number }>();
    const islandRadiusX = Math.max(120, Math.min(width * 0.32, width / 2 - 96));
    const islandRadiusY = Math.max(110, Math.min(height * 0.28, height / 2 - 86));
    activeIslandClusters.forEach((cluster, index) => {
      if (activeIslandClusters.length === 1) {
        islandCenterById.set(cluster.id, { x: width / 2, y: height / 2 });
        return;
      }

      const angle = -Math.PI / 2 + (index * Math.PI * 2) / activeIslandClusters.length;
      islandCenterById.set(cluster.id, {
        x: width / 2 + Math.cos(angle) * islandRadiusX,
        y: height / 2 + Math.sin(angle) * islandRadiusY
      });
    });
    const islandCenterFor = (item: SimNode) => (item.clusterId ? islandCenterById.get(item.clusterId) : undefined);
    const islandNodesById = new Map(
      activeIslandClusters.map((cluster) => [
        cluster.id,
        cluster.visibleNodeIds
          .map((nodeId) => nodeMap.get(nodeId))
          .filter((item): item is SimNode => Boolean(item))
      ])
    );
    const clusterNodesFor = (cluster: VisibleCluster) => islandNodesById.get(cluster.id) ?? [];

    const root = d3.select(svg);
    root.selectAll("*").remove();
    root
      .attr("viewBox", `0 0 ${width} ${height}`)
      .classed("intersection-highlight-mode", hasIntersectionHighlight)
      .classed("island-mode", showIslands);

    const defs = root.append("defs");
    const zoomLayer = root.append("g");
    const islandLayer = zoomLayer.append("g").attr("class", "cluster-islands");
    const linkLayer = zoomLayer.append("g").attr("class", "links");
    const nodeLayer = zoomLayer.append("g").attr("class", "nodes");

    root.call(
      d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.03, 4.2])
        .on("zoom", (event) => {
          zoomLayer.attr("transform", event.transform.toString());
        })
    );
    root.on("click", () => {
      setFocusedNodeId(null);
      setHovered(null);
      onHoverCluster?.(null);
      onSelectCluster?.(null);
    });

    const islandHull = islandLayer
      .selectAll<SVGPathElement, VisibleCluster>("path")
      .data(activeIslandClusters, (cluster) => cluster.id)
      .enter()
      .append("path")
      .attr("class", "cluster-island-hull")
      .attr("fill", (cluster) => cluster.color)
      .attr("stroke", (cluster) => cluster.color)
      .on("mouseenter", (event, cluster) => {
        event.stopPropagation();
        onHoverCluster?.(cluster.id);
      })
      .on("mouseleave", () => onHoverCluster?.(null))
      .on("click", (event, cluster) => {
        event.stopPropagation();
        onSelectCluster?.(activeClusterIdRef.current === cluster.id ? null : cluster.id);
      });

    const link = linkLayer
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("class", (edge) => `graph-edge ${edge.type}`)
      .attr("stroke-width", (edge) => Math.max(1.4, Math.min(9, Math.sqrt(edge.weight) * 1.35)))
      .classed(
        "is-intersection-link",
        (edge) =>
          hasIntersectionHighlight &&
          (intersectionNodeIds.has(endpointId(edge.source)) || intersectionNodeIds.has(endpointId(edge.target)))
      )
      .classed(
        "is-intersection-dimmed",
        (edge) =>
          hasIntersectionHighlight &&
          !intersectionNodeIds.has(endpointId(edge.source)) &&
          !intersectionNodeIds.has(endpointId(edge.target))
      )
      .classed(
        "has-listened-collab",
        (edge) => edge.type === "catalog_collab" && listenedPairKeys.has(simEdgePairKey(edge))
      );

    const node = nodeLayer
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr(
        "class",
        (item) =>
          `graph-node ${item.isShared ? "shared" : ""} ${overlayMatches[item.id]?.length ? "has-overlay-match" : ""} ${item.isSimilarOnly ? "similar" : ""} ${item.isCatalogOnly ? "catalog" : ""}`
      )
      .classed("is-intersection", (item) => intersectionNodeIds.has(item.id))
      .classed("is-intersection-dimmed", (item) => hasIntersectionHighlight && !intersectionNodeIds.has(item.id))
      .classed("has-unheard-known-collab", (item) => unheardKnownCollabNodeIds.has(item.id));

    if (showIslands) {
      link.style("--cluster-color", (edge) => {
        const sourceNode = nodeMap.get(endpointId(edge.source));
        const targetNode = nodeMap.get(endpointId(edge.target));
        if (sourceNode?.clusterId && sourceNode.clusterId === targetNode?.clusterId) {
          return clusterById.get(sourceNode.clusterId)?.color ?? "var(--green)";
        }
        return "var(--green)";
      });
      node
        .style("--cluster-color", (item) =>
          item.clusterId ? clusterById.get(item.clusterId)?.color ?? "var(--green)" : "var(--green)"
        )
        .classed("island-member", (item) => Boolean(item.clusterId && clusterById.has(item.clusterId)));
    }

    function applyContext() {
      if (contextTiers.size === 0) {
        link.classed("is-highlighted", false).classed("is-context", false).classed("is-dimmed", false);
        node
          .classed("is-highlighted", false)
          .classed("is-neighbor", false)
          .classed("is-context", false)
          .classed("is-dimmed", false);
        return;
      }

      link
        .classed("is-highlighted", (edge) => {
          const sourceTier = contextTiers.get(endpointId(edge.source));
          const targetTier = contextTiers.get(endpointId(edge.target));
          return sourceTier === "primary" || targetTier === "primary";
        })
        .classed("is-context", (edge) => {
          const sourceTier = contextTiers.get(endpointId(edge.source));
          const targetTier = contextTiers.get(endpointId(edge.target));
          return Boolean(sourceTier && targetTier && sourceTier !== "primary" && targetTier !== "primary");
        })
        .classed("is-dimmed", false);

      node
        .classed("is-highlighted", (item) => contextTiers.get(item.id) === "primary")
        .classed("is-neighbor", (item) => contextTiers.get(item.id) === "neighbor")
        .classed("is-context", (item) => contextTiers.get(item.id) === "context")
        .classed("is-dimmed", false);
    }

    function focusNode(focused: SimNode | null) {
      if (!focused) {
        applyContext();
        return;
      }

      const connectedIds = new Set<string>([focused.id]);
      link
        .classed("is-highlighted", (edge) => {
          const source = endpointId(edge.source);
          const target = endpointId(edge.target);
          const connected = source === focused.id || target === focused.id;
          if (connected) {
            connectedIds.add(source);
            connectedIds.add(target);
          }
          return connected;
        })
        .classed("is-dimmed", (edge) => endpointId(edge.source) !== focused.id && endpointId(edge.target) !== focused.id);

      node
        .classed("is-highlighted", (item) => item.id === focused.id)
        .classed("is-neighbor", (item) => item.id !== focused.id && connectedIds.has(item.id))
        .classed("is-context", false)
        .classed("is-dimmed", (item) => !connectedIds.has(item.id));
    }

    function applyIslandState() {
      const activeId = activeClusterIdRef.current;
      const hoverId = hoveredClusterIdRef.current;
      const highlightedId = showIslands ? activeId ?? hoverId : null;
      const activeNodeIds = new Set(highlightedId ? clusterById.get(highlightedId)?.visibleNodeIds ?? [] : []);

      islandHull
        .classed("is-active", (cluster) => cluster.id === activeId)
        .classed("is-hovered", (cluster) => cluster.id === hoverId)
        .classed("is-dimmed", (cluster) => Boolean(highlightedId && cluster.id !== highlightedId));

      node
        .classed("island-active-node", (item) => Boolean(highlightedId && activeNodeIds.has(item.id)))
        .classed("island-dimmed", (item) => Boolean(highlightedId && !activeNodeIds.has(item.id)));

      link
        .classed("island-active-link", (edge) => {
          if (!highlightedId) return false;
          return activeNodeIds.has(endpointId(edge.source)) && activeNodeIds.has(endpointId(edge.target));
        })
        .classed("island-dimmed", (edge) => {
          if (!highlightedId) return false;
          return !activeNodeIds.has(endpointId(edge.source)) || !activeNodeIds.has(endpointId(edge.target));
        });
    }

    node.on("mouseenter", (_, item) => {
      setHovered(item);
      focusNode(item);
      if (showIslands && item.clusterId) {
        onHoverCluster?.(item.clusterId);
      }
    });
    node.on("mouseleave", () => {
      setHovered(null);
      focusNode(null);
      if (showIslands) {
        onHoverCluster?.(null);
      }
    });
    node.on("click", (event, item) => {
      event.stopPropagation();
      setFocusedNodeId((current) => (current === item.id ? null : item.id));
      setHovered(item);
      if (showIslands && item.clusterId) {
        onSelectCluster?.(activeClusterIdRef.current === item.clusterId ? null : item.clusterId);
      }
    });

    applyContext();
    applyIslandState();

    const avatarNodes = nodes.filter((item) => Boolean(item.image));
    const clips = defs
      .selectAll("clipPath")
      .data(avatarNodes)
      .enter()
      .append("clipPath")
      .attr("id", nodeClipId);

    clips.append("circle").attr("r", radiusOf);

    node
      .append("circle")
      .attr("r", radiusOf)
      .attr("class", (item) =>
        item.isSimilarOnly ? "avatar-base similar-only" : "avatar-base listened"
      );

    node
      .filter((item) => Boolean(item.image))
      .append("image")
      .attr("href", (item) => item.image ?? "")
      .attr("xlink:href", (item) => item.image ?? "")
      .attr("x", (item) => -radiusOf(item))
      .attr("y", (item) => -radiusOf(item))
      .attr("width", (item) => radiusOf(item) * 2)
      .attr("height", (item) => radiusOf(item) * 2)
      .attr("preserveAspectRatio", "xMidYMid slice")
      .attr("clip-path", (item) => `url(#${nodeClipId(item)})`);

    node.append("circle").attr("r", radiusOf).attr("class", "node-ring");

    node.each(function renderOverlayRings(item) {
      const matches = overlayMatches[item.id] ?? [];
      if (matches.length === 0) return;
      const overlayGroup = d3.select(this).append("g").attr("class", "overlay-match-rings");
      matches.slice(0, 5).forEach((match, index) => {
        overlayGroup
          .append("circle")
          .attr("r", radiusOf(item) + 6 + index * 5)
          .attr("class", "overlay-match-ring")
          .attr("stroke", match.color);
      });
    });

    const unheardBadge = node
      .filter((item) => unheardKnownCollabNodeIds.has(item.id))
      .append("g")
      .attr("class", "unheard-collab-badge");

    unheardBadge
      .append("circle")
      .attr("r", (item) => Math.max(7, radiusOf(item) * 0.18))
      .attr("cx", (item) => -radiusOf(item) * 0.56)
      .attr("cy", (item) => -radiusOf(item) * 0.52);

    unheardBadge
      .append("text")
      .text("+")
      .attr("x", (item) => -radiusOf(item) * 0.56)
      .attr("y", (item) => -radiusOf(item) * 0.52)
      .attr("dy", "0.34em")
      .attr("text-anchor", "middle");

    const likedBadge = node.filter((item) => item.isLikedArtist).append("g").attr("class", "liked-badge");

    likedBadge
      .append("circle")
      .attr("r", (item) => Math.max(8, radiusOf(item) * 0.22))
      .attr("cx", (item) => radiusOf(item) * 0.52)
      .attr("cy", (item) => -radiusOf(item) * 0.52);

    likedBadge
      .append("text")
      .attr("class", "liked-heart")
      .text("♥")
      .attr("x", (item) => radiusOf(item) * 0.52)
      .attr("y", (item) => -radiusOf(item) * 0.52)
      .attr("dy", "0.34em")
      .attr("text-anchor", "middle");

    node
      .append("text")
      .text((item) => item.name)
      .attr("dy", (item) => radiusOf(item) + 18)
      .attr("text-anchor", "middle");

    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink<SimNode, SimEdge>(links)
          .id((item) => item.id)
          .distance((edge) => (showIslands && edge.type === "collab" ? Math.max(92, edgeDistance(edge) - 30) : edgeDistance(edge)))
          .strength(edgeStrength)
      )
      .force("charge", d3.forceManyBody().strength(-repulsionStrength))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force(
        "collision",
        d3.forceCollide<SimNode>().radius((item) => radiusOf(item) + 34)
      );

    if (showIslands) {
      simulation
        .force(
          "x",
          d3
            .forceX<SimNode>((item) => islandCenterFor(item)?.x ?? width / 2)
            .strength((item) => (islandCenterFor(item) ? 0.045 : 0.012))
        )
        .force(
          "y",
          d3
            .forceY<SimNode>((item) => islandCenterFor(item)?.y ?? height / 2)
            .strength((item) => (islandCenterFor(item) ? 0.045 : 0.012))
        );
    }

    let islandSimulationSettled = false;
    const islandHullTickInterval = nodes.length > 500 ? 12 : nodes.length > 250 ? 6 : 3;

    node.call(
      d3
        .drag<SVGGElement, SimNode>()
        .on("start", (event, item) => {
          islandSimulationSettled = false;
          if (!event.active) simulation.alphaTarget(0.12).restart();
          item.fx = item.x;
          item.fy = item.y;
        })
        .on("drag", (event, item) => {
          item.fx = event.x;
          item.fy = event.y;
        })
        .on("end", (event, item) => {
          if (!event.active) simulation.alphaTarget(0);
          item.fx = null;
          item.fy = null;
        })
    );

    const deferLinks = links.length > 700 || nodes.length > 300;
    let linksVisible = !deferLinks;
    let frameId: number | null = null;
    let tickCount = 0;
    if (deferLinks) {
      linkLayer.attr("opacity", "0");
    }

    const renderLinks = () => {
      link
        .attr("x1", (edge) => (edge.source as SimNode).x ?? 0)
        .attr("y1", (edge) => (edge.source as SimNode).y ?? 0)
        .attr("x2", (edge) => (edge.target as SimNode).x ?? 0)
        .attr("y2", (edge) => (edge.target as SimNode).y ?? 0);
    };

    const renderIslandHulls = () => {
      islandHull.each(function renderIslandHull(cluster) {
        const clusterNodes = clusterNodesFor(cluster);
        d3.select(this)
          .attr("d", clusterHullPath(clusterNodes, radiusOf) ?? "")
          .attr("display", clusterNodes.length > 1 ? null : "none");
      });
    };

    const renderTick = () => {
      tickCount += 1;
      const shouldRenderLinks = linksVisible || tickCount % 8 === 0 || simulation.alpha() < 0.22;
      if (shouldRenderLinks) {
        renderLinks();
      }
      if (
        showIslands &&
        (tickCount === 1 || tickCount % islandHullTickInterval === 0 || simulation.alpha() < 0.08)
      ) {
        renderIslandHulls();
      }
      if (deferLinks && !linksVisible && simulation.alpha() < 0.22) {
        linksVisible = true;
        linkLayer.transition().duration(180).attr("opacity", "1");
      }
      node.attr("transform", (item) => `translate(${item.x ?? 0},${item.y ?? 0})`);
      if (showIslands && !islandSimulationSettled && simulation.alpha() < 0.035) {
        islandSimulationSettled = true;
        renderLinks();
        renderIslandHulls();
        simulation.stop();
      }
      frameId = null;
    };
    const scheduleRender = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(renderTick);
    };

    scheduleRender();
    simulation.on("tick", scheduleRender);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      simulation.stop();
    };
  }, [
    contextTiers,
    hasIntersectionHighlight,
    intersectionNodeIds,
    listenedPairKeys,
    clusterById,
    onHoverCluster,
    onSelectCluster,
    overlayMatches,
    repulsionStrength,
    showIslands,
    unheardKnownCollabNodeIds,
    visibleClusters,
    visibleGraph
  ]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    if (!showIslands) return;

    const highlightedId = showIslands ? highlightedCluster?.id ?? null : null;
    const activeNodeIds = showIslands ? highlightedClusterNodeIds : new Set<string>();

    d3.select(svg)
      .selectAll<SVGPathElement, VisibleCluster>(".cluster-island-hull")
      .classed("is-active", (cluster) => cluster.id === activeClusterId)
      .classed("is-hovered", (cluster) => cluster.id === hoveredClusterId)
      .classed("is-dimmed", (cluster) => Boolean(highlightedId && cluster.id !== highlightedId));

    d3.select(svg)
      .selectAll<SVGGElement, SimNode>(".graph-node")
      .classed("island-active-node", (item) => Boolean(highlightedId && activeNodeIds.has(item.id)))
      .classed("island-dimmed", (item) => Boolean(highlightedId && !activeNodeIds.has(item.id)));

    d3.select(svg)
      .selectAll<SVGLineElement, SimEdge>(".graph-edge")
      .classed("island-active-link", (edge) => {
        if (!highlightedId) return false;
        return activeNodeIds.has(endpointId(edge.source)) && activeNodeIds.has(endpointId(edge.target));
      })
      .classed("island-dimmed", (edge) => {
        if (!highlightedId) return false;
        return !activeNodeIds.has(endpointId(edge.source)) || !activeNodeIds.has(endpointId(edge.target));
      });
  }, [
    activeClusterId,
    highlightedCluster?.id,
    highlightedClusterNodeIds,
    hoveredClusterId,
    showIslands,
    visibleClusters
  ]);

  if (!graph) {
    return (
      <section className="graph-empty">
        <h2>Граф пока пустой</h2>
        <p>Запусти синхронизацию, и здесь появятся артисты, коллабы и похожие связи.</p>
      </section>
    );
  }

  if (visibleGraph?.nodes.length === 0) {
    return (
      <section className="graph-empty">
        <h2>Данных для графа пока нет</h2>
        <p>
          Синхронизация запустится автоматически. Граф появится, когда придут лайкнутые треки или история
          прослушиваний.
        </p>
      </section>
    );
  }

  return (
    <section className="graph-stage">
      {(normalizedSearch || focusedNodeId) && (
        <div className="graph-focus-hint">
          <strong>{focusedNodeId ? "Фокус на артисте" : "Режим поиска"}</strong>
          <span>Видны ближайшие связи и следующий слой. Клик по артисту раскрывает граф вокруг него.</span>
          {focusedNodeId && (
            <button type="button" onClick={() => setFocusedNodeId(null)}>
              Снять фокус
            </button>
          )}
        </div>
      )}
      {hasIntersectionHighlight && (
        <div className="intersection-mode-hint">
          <strong>{intersectionNodeIds.size}</strong>
          <span>общих артистов подсвечено</span>
        </div>
      )}
      <svg ref={svgRef} role="img" aria-label="music artist graph" />
      {tooltipNode && (
        <div className="graph-tooltip">
          <strong>{tooltipNode.name}</strong>
          {typeof tooltipNode.knownTrackCount === "number" ? (
            <span>{tooltipNode.knownTrackCount} знакомых треков в Яндексе</span>
          ) : tooltipNode.isSimilarOnly || tooltipNode.isCatalogOnly ? (
            <span>Яндекс не отдал личную статистику для этого артиста</span>
          ) : (
            <span>{tooltipNode.listenCount} синхронизированных прослушиваний</span>
          )}
          {typeof tooltipNode.waveTrackCount === "number" && <span>{tooltipNode.waveTrackCount} из волны/прослушиваний</span>}
          {typeof tooltipNode.collectionTrackCount === "number" && <span>{tooltipNode.collectionTrackCount} в коллекции</span>}
          {shouldShowLocalTrackCount(tooltipNode) && <span>{tooltipNode.trackCount} треков в локальном графе</span>}
          {tooltipNode.isLikedArtist && <span>Лайкнутый артист</span>}
          {tooltipNode.isSimilarOnly && <span>Похожий артист</span>}
          {tooltipNode.isShared && <span className="shared-pill">Общий артист</span>}
          {focusedNodeId === tooltipNode.id && <span className="shared-pill focus-pill">Фокус графа</span>}
          {tooltipOverlayMatches.length > 0 && (
            <span className="shared-pill overlay-pill">
              Общий с: {tooltipOverlayMatches.map((match) => match.label).join(", ")}
            </span>
          )}
          {tooltipOverlayMatches.some((match) => match.commonTracks.length > 0) && (
            <div className="tooltip-common-tracks">
              <span className="tooltip-links-title">Общие треки</span>
              {tooltipOverlayMatches.map((match) =>
                match.commonTracks.length > 0 ? (
                  <span className="tooltip-link common-track-group" key={match.userId}>
                    <b>{match.label}</b>
                    <em>{match.commonTracks.slice(0, 8).join(", ")}</em>
                  </span>
                ) : null
              )}
            </div>
          )}
          {tooltipHasUnheardKnownCollabs && (
            <span className="shared-pill unheard-pill">
              Есть неслышанные коллабы с уже знакомой связью
            </span>
          )}
          {hoveredEdges.length > 0 && (
            <div className="tooltip-links">
              <span className="tooltip-links-title">Связи на графе</span>
              {hoveredEdges.map((edge) => {
                const otherId = edge.source === tooltipNode.id ? edge.target : edge.source;
                const tracks = edge.tracks.filter((track) => track.trim()).slice(0, 3);
                const isUnheardKnownCollab = edge.type === "catalog_collab" && listenedPairKeys.has(edgePairKey(edge));
                return (
                  <span className="tooltip-link" key={graphEdgeKey(edge)}>
                    <b>
                      {edgeTypeLabel(edge.type)} с {nodeNames.get(otherId) ?? otherId}
                    </b>
                    {tracks.length > 0 && <em>{tracks.join(", ")}</em>}
                    {isUnheardKnownCollab && <em className="unheard-note">у этой пары уже есть прослушанная связь</em>}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
