# Chusky in each agent

One MCP server serves every agent that speaks MCP. Each agent only needs its own config
or plugin file. The server is `chuskybrowser-mcp`, which reads three variables:

| Variable | Meaning |
|---|---|
| `CHUSKY_BASE_URL` | Your Chusky server, e.g. `https://your-app.up.railway.app` |
| `CHUSKY_ACCESS_KEY` | The server's access key (sent as a bearer token) |
| `CHUSKY_USER_ID` | The one user this agent acts for. Every call uses it. The model never supplies it |

Keep the key out of shared files. Put the three values in the agent's environment.

**Publishing:** the npm package must be published from this repo's `mcp/` folder
(version with the 23 tools) before `npx -y chuskybrowser-mcp` serves the new
tools. Until then, point the command at the repo copy:
`node /path/to/chuskybrowser/mcp/server.mjs` (run `npm install` in `mcp/` first).

## Status by platform

| Platform | How it loads | Status |
|---|---|---|
| Claude Code | Plugin: `.claude-plugin/plugin.json` and `.mcp.json` at the repo root, with `skills/` | Plugin files written. Install: `/plugin marketplace add <this repo>`, then `/plugin install chuskybrowser@<marketplace>`. The `${VAR}` expansion in `.mcp.json` is not confirmed in the docs I read; if it doesn't expand, set the values in the shell that starts Claude Code |
| Cursor | Plugin: `.cursor-plugin/plugin.json` and `mcp.json` at the repo root, with `skills/` | Plugin files written. Install from Customize → Plugins, or copy to `~/.cursor/plugins/local/` and reload. Cursor's `${env:NAME}` form is used in `mcp.json` |
| Codex | MCP in `~/.codex/config.toml` | Config below. Plugin packaging not confirmed (the docs page I read did not give the manifest) |
| Hermes Agent | MCP in `~/.hermes/config.yaml` under `mcp_servers` | Config below. Plugin packaging not confirmed |
| Grok Build (xAI) | Supports MCP servers per xAI's announcement | How to add an MCP server was not in the page I read. Needs the xAI docs |
| OpenClaw | `openclaw.plugin.json` in this repo | Exists; tool list updated to 23 tools |

## Codex

```toml
# ~/.codex/config.toml
[mcp_servers.chuskybrowser]
command = "npx"
args = ["-y", "chuskybrowser-mcp"]
env_vars = ["CHUSKY_BASE_URL", "CHUSKY_ACCESS_KEY", "CHUSKY_USER_ID"]
```

`env_vars` passes the values from the shell that starts Codex, so the key is not written
into the file.

## Hermes Agent

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  chuskybrowser:
    command: "npx"
    args: ["-y", "chuskybrowser-mcp"]
    env:
      CHUSKY_BASE_URL: "https://your-app.up.railway.app"
      CHUSKY_ACCESS_KEY: "<set in your environment, not in this file>"
      CHUSKY_USER_ID: "user-42"
```

Run `/reload-mcp` in a session after editing. Tools are named `mcp_chuskybrowser_<tool>`.
Hermes docs say `env` is supported for stdio servers; check that the key is not
written in plain text on a shared machine.

## What the 23 tools cover

- Browser: the 11 existing tools, plus `chusky_handoff_start` and `chusky_handoff_release`.
- Payments: `chusky_pay_arm`, `chusky_pay_status`, `chusky_pay_disarm`.
- AgentCard: `agentcard_enrol`, `agentcard_cards`, `agentcard_placeholder`, `agentcard_buy`, `agentcard_merchants`,
  `agentcard_presets_list`, `agentcard_preset_set`, `agentcard_preset_attach`.

Not exposed as tools, on purpose: the raw purchase request (it needs the processor's own
request, which the model should not build) and the webhook routes.
