import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { apiRoutes } from "../../src/shared/api";

/**
 * An MCP client on squad's endpoint, connected exactly as a claude-code session
 * would be. Nothing here reaches inside the server: the tools are called over
 * the wire, so a test sees the same contract an agent sees.
 */
export interface McpConnection {
  /** Returns the parsed JSON a tool answered with, and fails on a tool error. */
  call(tool: string, input: unknown): Promise<unknown>;
  /** Returns the tool's raw outcome, so a refusal can be inspected. */
  attempt(tool: string, input: unknown): Promise<ToolOutcome>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

export interface ToolOutcome {
  refused: boolean;
  text: string;
}

export async function connectToSquadTools(baseUrl: string): Promise<McpConnection> {
  const client = new Client({ name: "squad-seam-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(apiRoutes.mcp, baseUrl)));

  async function attempt(tool: string, input: unknown): Promise<ToolOutcome> {
    const result = await client.callTool({ name: tool, arguments: input as Record<string, unknown> });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return { refused: result.isError === true, text };
  }

  return {
    attempt,
    async call(tool, input) {
      const outcome = await attempt(tool, input);
      if (outcome.refused) throw new Error(`${tool} refused the call: ${outcome.text}`);
      return JSON.parse(outcome.text) as unknown;
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name).sort();
    },
    async close() {
      await client.close();
    },
  };
}
