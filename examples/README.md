# Example Configuration Files

This directory contains example configuration files for ActionsPulse MCP Server.

## Files

| File | Description |
|------|-------------|
| [mcp-docker.json](mcp-docker.json) | VS Code MCP config using Docker |
| [mcp-local.json](mcp-local.json) | VS Code MCP config for local development |
| [mcp-envfile.json](mcp-envfile.json) | VS Code MCP config using environment file |
| [.env.example](.env.example) | Environment variables template |
| [inventory.yaml](inventory.yaml) | Repository inventory example |
| [devops-config.yaml](devops-config.yaml) | DevOps observer configuration |
| [docker-compose.yml](docker-compose.yml) | Docker Compose deployment |

## Quick Start

1. Copy the appropriate `mcp-*.json` to your VS Code configuration:
   - macOS: `~/Library/Application Support/Code/User/mcp.json`
   - Linux: `~/.config/Code/User/mcp.json`
   - Windows: `%APPDATA%\Code\User\mcp.json`

2. Copy `.env.example` to `.env` and fill in your values

3. Create a config directory and copy `inventory.yaml`:
   ```bash
   mkdir -p ~/devops-observer/repositories
   cp inventory.yaml ~/devops-observer/repositories/
   ```

4. Update the volume mount path in your MCP configuration

## See Also

- [Quick Start Guide](../docs/QUICKSTART.md)
- [Configuration Guide](../docs/CONFIGURATION.md)
- [Architecture](../docs/ARCHITECTURE.md)
