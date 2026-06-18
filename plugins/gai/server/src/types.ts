export interface SearchArgs {
  query: string;
  wait_for_complete?: boolean;
  save_to_file?: string;
  return_text?: boolean;
}

export interface SearchResults {
  answer: string;
  url: string;
}

// Minimal MCP-style result envelope. The CLI parses content[0].text as JSON.
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}
