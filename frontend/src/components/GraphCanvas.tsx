import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { GraphEdge, GraphNode, GraphResponse } from "../types/api";

type Props = {
  graph: GraphResponse | null;
  search: string;
  repulsionStrength: number;
  showCollabEdges: boolean;
  showCatalogCollabEdges: boolean;
  showSimilarEdges: boolean;
};

type SimNode = GraphNode & d3.SimulationNodeDatum;
type SimEdge = Omit<GraphEdge, "source" | "target"> & {
  source: SimNode | string;
  target: SimNode | string;
};

function nodeWeight(node: GraphNode): number {
  return typeof node.knownTrackCount === "number" ? node.knownTrackCount : node.listenCount;
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

export function GraphCanvas({
  graph,
  search,
  repulsionStrength,
  showCollabEdges,
  showCatalogCollabEdges,
  showSimilarEdges
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<GraphNode | null>(null);
  const normalizedSearch = search.trim().toLowerCase();

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

  const visibleGraph = useMemo(() => {
    if (!filteredGraph || !normalizedSearch) return filteredGraph;
    const matching = new Set(
      filteredGraph.nodes
        .filter((node) => node.name.toLowerCase().includes(normalizedSearch))
        .map((node) => node.id)
    );
    const connected = new Set(matching);
    filteredGraph.edges.forEach((edge) => {
      if (matching.has(edge.source)) connected.add(edge.target);
      if (matching.has(edge.target)) connected.add(edge.source);
    });
    return {
      ...filteredGraph,
      nodes: filteredGraph.nodes.filter((node) => connected.has(node.id)),
      edges: filteredGraph.edges.filter((edge) => connected.has(edge.source) && connected.has(edge.target))
    };
  }, [filteredGraph, normalizedSearch]);

  const nodeNames = useMemo(() => {
    return new Map((visibleGraph?.nodes ?? []).map((node) => [node.id, node.name]));
  }, [visibleGraph]);

  const hoveredEdges = useMemo(() => {
    if (!visibleGraph || !hovered) return [];
    return visibleGraph.edges
      .filter((edge) => edge.source === hovered.id || edge.target === hovered.id)
      .sort((left, right) => edgeTypePriority(left.type) - edgeTypePriority(right.type) || right.weight - left.weight)
      .slice(0, 5);
  }, [hovered, visibleGraph]);

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

    const root = d3.select(svg);
    root.selectAll("*").remove();
    root.attr("viewBox", `0 0 ${width} ${height}`);

    const defs = root.append("defs");
    const zoomLayer = root.append("g");
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

    const link = linkLayer
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("class", (edge) => `graph-edge ${edge.type}`)
      .attr("stroke-width", (edge) => Math.max(1.4, Math.min(9, Math.sqrt(edge.weight) * 1.35)));

    const node = nodeLayer
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr(
        "class",
        (item) =>
          `graph-node ${item.isShared ? "shared" : ""} ${item.isSimilarOnly ? "similar" : ""}`
      );

    function focusNode(focused: SimNode | null) {
      if (!focused) {
        link.classed("is-highlighted", false).classed("is-dimmed", false);
        node.classed("is-highlighted", false).classed("is-neighbor", false).classed("is-dimmed", false);
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
        .classed("is-dimmed", (item) => !connectedIds.has(item.id));
    }

    node.on("mouseenter", (_, item) => {
      setHovered(item);
      focusNode(item);
    });
    node.on("mouseleave", () => {
      setHovered(null);
      focusNode(null);
    });

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
          .distance(edgeDistance)
          .strength(edgeStrength)
      )
      .force("charge", d3.forceManyBody().strength(-repulsionStrength))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide<SimNode>().radius((item) => radiusOf(item) + 34));

    node.call(
      d3
        .drag<SVGGElement, SimNode>()
        .on("start", (event, item) => {
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

    const renderTick = () => {
      tickCount += 1;
      const shouldRenderLinks = linksVisible || tickCount % 8 === 0 || simulation.alpha() < 0.22;
      if (shouldRenderLinks) {
        renderLinks();
      }
      if (deferLinks && !linksVisible && simulation.alpha() < 0.22) {
        linksVisible = true;
        linkLayer.transition().duration(180).attr("opacity", "1");
      }
      node.attr("transform", (item) => `translate(${item.x ?? 0},${item.y ?? 0})`);
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
  }, [repulsionStrength, visibleGraph]);

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
      <svg ref={svgRef} role="img" aria-label="music artist graph" />
      {hovered && (
        <div className="graph-tooltip">
          <strong>{hovered.name}</strong>
          {typeof hovered.knownTrackCount === "number" ? (
            <span>{hovered.knownTrackCount} знакомых треков в Яндексе</span>
          ) : hovered.isSimilarOnly || hovered.isCatalogOnly ? (
            <span>Яндекс не отдал личную статистику для этого артиста</span>
          ) : (
            <span>{hovered.listenCount} синхронизированных прослушиваний</span>
          )}
          {typeof hovered.waveTrackCount === "number" && <span>{hovered.waveTrackCount} из волны/прослушиваний</span>}
          {typeof hovered.collectionTrackCount === "number" && <span>{hovered.collectionTrackCount} в коллекции</span>}
          {shouldShowLocalTrackCount(hovered) && <span>{hovered.trackCount} треков в локальном графе</span>}
          {hovered.isLikedArtist && <span>Лайкнутый артист</span>}
          {hovered.isSimilarOnly && <span>Похожий артист</span>}
          {hovered.isShared && <span className="shared-pill">Общий артист</span>}
          {hoveredEdges.length > 0 && (
            <div className="tooltip-links">
              <span className="tooltip-links-title">Связи на графе</span>
              {hoveredEdges.map((edge) => {
                const otherId = edge.source === hovered.id ? edge.target : edge.source;
                const tracks = edge.tracks.filter((track) => track.trim()).slice(0, 3);
                return (
                  <span className="tooltip-link" key={graphEdgeKey(edge)}>
                    <b>
                      {edgeTypeLabel(edge.type)} с {nodeNames.get(otherId) ?? otherId}
                    </b>
                    {tracks.length > 0 && <em>{tracks.join(", ")}</em>}
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
