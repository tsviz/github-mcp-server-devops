# 🚀 Quick Start Guide - ActionsPulse MCP Server

**Get started with ActionsPulse in 5 minutes!**

---

## Prerequisites

- Docker installed and running
- GitHub Personal Access Token (PAT) with appropriate scopes
- VS Code with GitHub Copilot extension (for MCP integration)

## Step 1: Create GitHub Token

Create a fine-grained PAT with the following permissions:

| Permission | Access Level | Required For |
|------------|--------------|--------------|
| `repo` | Read | Repository access and commits |
| `actions` | Read | Workflow runs and metrics |
| `issues` | Read/Write | Issue and PR metrics |
| `pull_requests` | Read | PR analysis |

> **Tip**: For organization-level metrics, you'll also need:
> - `admin:org` → Read for org-level Actions data
> - `organization_self_hosted_runners` → Read for runner metrics
> - `Administration` (org) → Read for accurate larger runner cost detection (see [Enhanced Runner Cost Detection](CONFIGURATION.md#enhanced-runner-cost-detection))

## Step 2: Configure MCP Server

Add to your VS Code `mcp.json` (usually at `~/.config/Code/User/mcp.json` or `~/Library/Application Support/Code/User/mcp.json`):

> **Important**: `GITHUB_ORG` is required. There is no "default" organization in GitHub - you must specify which organization to monitor.

<details>
<summary>📄 mcp.json configuration</summary>

```jsonc
{
  "servers": {
    "actions-pulse": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_TOKEN=ghp_your_token_here",
        "-e", "GITHUB_ORG=your-organization",  // Required: specify your GitHub org
        "-e", "DEVOPS_CONFIG_PATH=/app/config",
        "-v", "/path/to/your/config:/app/config:ro",
        "ghcr.io/tsviz/actions-pulse:latest"
      ],
      "type": "stdio"
    }
  }
}
```

</details>

## Step 3: Create Configuration Directory

Create a config directory with your repository inventory:

```bash
mkdir -p ~/actions-pulse-config
```

<details>
<summary>📄 repositories/inventory.yaml</summary>

Create `~/actions-pulse-config/repositories/inventory.yaml`:

```yaml
apiVersion: actions-pulse/v1
kind: RepositoryInventory
metadata:
  name: my-org-inventory
  version: "1.0.0"

spec:
  repositories:
    - name: my-app
      team: backend
      tier: tier-1
      compliance:
        - SOC2
      tags:
        - production
        - java

    - name: my-frontend
      team: frontend
      tier: tier-2
      tags:
        - react
        - staging
```

</details>

## Step 4: Start Using ActionsPulse

Open VS Code and start a Copilot Chat. Try these prompts:

<details>
<summary>💬 Example prompts</summary>

### Check CI/CD Health
```
What's the current status of my GitHub Actions workflows?
```

### Get Performance Metrics
```
Show me detailed performance metrics for the last 7 days
```

### Generate DORA Metrics
```
Give me DORA metrics for my organization
```

### Check Deployment Status
```
What are my recent deployments and their status?
```

### Compliance Report
```
Generate a compliance audit report for SOC2
```

</details>

---

## What's Next?

- 📖 [Configuration Guide](CONFIGURATION.md) - Deep dive into configuration options
- 🏗️ [Architecture](ARCHITECTURE.md) - Understand how ActionsPulse works
- 📊 [Examples](../examples/) - Sample configurations for common scenarios

---

## Troubleshooting

<details>
<summary>🔐 Token Permission Errors</summary>

If you see `404` errors when accessing repositories:

1. Check your token has the required scopes
2. Verify you have access to the organization
3. Use the token permissions check:
   ```
   Check my GitHub token permissions
   ```

</details>

<details>
<summary>🐳 Container Not Starting</summary>

Verify Docker is running:
```bash
docker ps
```

Check container logs:
```bash
docker logs actions-pulse
```

</details>

<details>
<summary>⚙️ Configuration Not Loading</summary>

Ensure the volume mount path is correct and the files exist:
```bash
ls -la /path/to/your/config/repositories/
```

</details>

---

## Quick Reference

| Command | Description |
|---------|-------------|
| `Show Actions performance metrics` | CI/CD health overview |
| `Get DORA metrics` | Deployment frequency, lead time, etc. |
| `Check token permissions` | Verify your PAT scopes |
| `Generate compliance report` | SOC2, HIPAA, ISO27001 audits |
| `Get deployment metrics` | Deployment success rates |
| `Show workflow insights` | Per-workflow analysis |
