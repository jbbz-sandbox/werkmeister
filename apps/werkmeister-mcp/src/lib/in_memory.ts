import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A client linked in-process to *server*. It advertises no UI capability, so
 * tools take their non-UI path and return `structuredContent` — what the
 * dashboard's browser page and the daemon's `/api/tool` both hand back.
 */
export async function connectInMemoryClient(server: McpServer, name: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}
