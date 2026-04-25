import { useEffect, useState } from "react";
import {
  fetchConversationGraph,
  type ChatGraphNode,
  type ChatGraphEdge,
} from "../../services/api";

const FONT = "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif";

interface ChatGraphViewProps {
  conversationId: number;
}

interface Tree {
  node: ChatGraphNode;
  children: Tree[];
}

// Build a parent→children tree from the flat node/edge lists. Nodes without
// any incoming edge become roots (they're the conversation's "topic seeds").
function buildTrees(nodes: ChatGraphNode[], edges: ChatGraphEdge[]): Tree[] {
  const byId = new Map<number, Tree>();
  nodes.forEach((n) => byId.set(n.id, { node: n, children: [] }));
  const childIds = new Set(edges.map((e) => e.to));
  edges.forEach((e) => {
    const parent = byId.get(e.from);
    const child = byId.get(e.to);
    if (parent && child) parent.children.push(child);
  });
  // Roots — nodes never on the receiving end of an edge. Sorted by id so
  // the visual order matches conversation chronology.
  return nodes
    .filter((n) => !childIds.has(n.id))
    .map((n) => byId.get(n.id)!)
    .sort((a, b) => a.node.id - b.node.id);
}

function TreeNode({ tree, depth }: { tree: Tree; depth: number }) {
  const isUser = tree.node.role === "user";
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        paddingLeft: depth * 18,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase",
          color: isUser ? "#4338CA" : "#16A34A",
          background: isUser ? "rgba(99, 102, 241, 0.1)" : "rgba(74, 222, 128, 0.12)",
          padding: "1px 5px", borderRadius: 4, fontFamily: FONT,
        }}>
          {isUser ? "you" : "gooni"}
        </span>
        <span style={{
          fontSize: 13, color: "#1C1C1E", fontFamily: FONT, lineHeight: 1.3,
        }}>
          {tree.node.label || "(no topic)"}
        </span>
      </div>
      {tree.children.map((c) => (
        <TreeNode key={c.node.id} tree={c} depth={depth + 1} />
      ))}
    </div>
  );
}

export function ChatGraphView({ conversationId }: ChatGraphViewProps) {
  const [nodes, setNodes] = useState<ChatGraphNode[]>([]);
  const [edges, setEdges] = useState<ChatGraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    fetchConversationGraph(conversationId)
      .then((g) => {
        setNodes(g.nodes);
        setEdges(g.edges);
      })
      .catch((e) => setErr(e?.message || "graph unavailable"))
      .finally(() => setLoading(false));
  }, [conversationId]);

  if (loading) {
    return (
      <div style={{ padding: 24, color: "#AEAEB2", fontSize: 12, fontFamily: FONT, textAlign: "center" }}>
        Building topic graph…
      </div>
    );
  }
  if (err) {
    return (
      <div style={{ padding: 24, color: "#C76B6B", fontSize: 12, fontFamily: FONT, textAlign: "center" }}>
        {err}
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div style={{ padding: 24, color: "#AEAEB2", fontSize: 12, fontFamily: FONT, textAlign: "center" }}>
        Not enough topic shifts to graph yet.
      </div>
    );
  }

  const trees = buildTrees(nodes, edges);
  return (
    <div style={{ padding: "12px 16px", fontFamily: FONT }}>
      {trees.map((t) => (
        <TreeNode key={t.node.id} tree={t} depth={0} />
      ))}
    </div>
  );
}
