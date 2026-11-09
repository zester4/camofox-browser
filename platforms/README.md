# Using chuskybrowser from your AI tool

chuskybrowser runs as a local server (`npx chuskybrowser`) and exposes its tools to AI tools through the
`chuskybrowser-mcp` package. Each tool needs a small config entry that starts that package.

| Tool | Where the config goes | File in this folder |
|------|----------------------|---------------------|
| Claude Code | `.mcp.json` in the project, or install this repo as a plugin (already at the repo root) | `../.mcp.json` |
| Cursor | `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json`) | `cursor/mcp.json` |
| Codex | `~/.codex/config.toml` | `codex/config.toml` |
| Hermes | `mcp_servers` in `~/.hermes/config.yaml` | `hermes/config.yaml` |
| Grok | `~/.grok/config.toml` | `grok/config.toml` |

## Steps (every tool)

1. Set up the server once:
   ```
   npx chuskybrowser doctor    # checks Node, the browser engine, the port and the access key
   npx chuskybrowser           # starts the server on http://localhost:9377
   ```
2. Set `CHUSKY_ACCESS_KEY` in your shell or `.env` if the server will be reachable by anyone else. The MCP
   entry forwards it; never paste it into a file you commit.
3. Copy the matching config above into your tool's config file, then restart the tool.
4. Ask the tool to open a page with chuskybrowser. If it can't see the tools, check that the server is running
   and that `CHUSKY_PORT` matches the port you started it on.

The MCP entry talks to the server on `localhost` only. To use a remote server, run the MCP package on the same
machine as the tool and point it at the server with the REST API instead (see `../skills/chuskybrowser-setup`).
