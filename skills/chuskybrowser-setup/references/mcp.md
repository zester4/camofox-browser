# Using MCP

The package `chuskybrowser-mcp` exposes the REST API as MCP tools. It proxies to a running Chusky server, so it still needs the base URL and the access key.

- Use it for quick agent work in MCP-capable clients (for example Claude Code, Cursor, Codex).
- Do not make it your only integration. Apps and backend jobs that are not agents should call the REST API directly.
- The same userId rule applies: the client must pass the end user's ID from the authenticated session.

## Tools

35 tools in four groups. The full list with descriptions is in `mcp/README.md`.

- **Browse:** `chusky_create_tab`, `chusky_snapshot`, `chusky_navigate`, `chusky_click`, `chusky_type`, `chusky_scroll`, `chusky_screenshot`, `chusky_evaluate`, `chusky_list_tabs`, `chusky_close_tab`, `chusky_import_cookies`, `chusky_wait`, `chusky_viewport`, `chusky_select`, `chusky_upload`, `chusky_dismiss_overlays`, `chusky_page_state`, `chusky_list_downloads`, `chusky_extract`.
- **People in the loop:** `chusky_viewer_link` (watch or control a tab), `chusky_handoff_start` and `chusky_handoff_release`, `chusky_checkpoint` (hands over only when a person is needed).
- **Payments:** `chusky_pay_arm`, `chusky_pay_status`, `chusky_pay_disarm`.
- **AgentCard and debugging:** the `agentcard_*` tools, and `chusky_list_traces`.

Send any `url` or `controlUrl` the tools return to the user unchanged. Never open or act on a link yourself.
