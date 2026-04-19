# memento-mcp source/deploy workflow

Canonical source clone:

- `/Users/kunkun/memento-mcp`

Live runtime service:

- `/Users/kunkun/.adk/release/services/memento-mcp`
- launchd label: `com.agentdesk.memento-mcp`
- health URL: `http://127.0.0.1:57332/health`

Bootstrap or repair the source clone:

```bash
/Users/kunkun/memento-mcp/scripts/bootstrap-memento-mcp-source.sh
```

Preview a deploy without touching the live runtime:

```bash
/Users/kunkun/memento-mcp/scripts/deploy-memento-mcp.sh --dry-run
```

Deploy source clone changes into the live runtime and restart the service:

```bash
/Users/kunkun/memento-mcp/scripts/deploy-memento-mcp.sh
```

Notes:

- The deploy script syncs tracked files from the canonical clone into the live runtime.
- The deploy defaults are derived from the repo location, so moving the clone does not require editing the script.
- The deploy script runs `npm ci` from the synced lockfile before restart, so dependency resolution stays deterministic.
- `config/memory.js` is preserved by default as a live-local override.
- If the live runtime has tracked edits that differ from the source clone, deploy aborts unless `--allow-dirty-live` is passed.
