# Paperless-NGX MCP Server

A fork of [baruchiro/paperless-mcp](https://github.com/baruchiro/paperless-mcp) with added **OAuth 2.0 / OIDC authentication** for use with [Claude.ai](https://claude.ai) remote MCP connectors and self-hosted identity providers like [Authelia](https://www.authelia.com/).

## What's different from upstream

- Bearer token validation (`MCP_API_KEY`) for Claude Desktop / direct clients
- JWT validation via OIDC Token Introspection for Claude.ai OAuth flow
- OAuth 2.0 Authorization Server discovery endpoint (`/.well-known/oauth-authorization-server`) so Claude.ai can auto-discover your identity provider
- Docker image published to `ghcr.io/marco2901/paperless-mcp-server:latest`

## Quick Start

### Docker Compose (with Traefik + Authelia)

```yaml
services:
  paperless-mcp:
    image: ghcr.io/marco2901/paperless-mcp-server:latest
    container_name: paperless-mcp
    restart: unless-stopped
    environment:
      PAPERLESS_URL: "http://webserver:8000"
      PAPERLESS_API_KEY: "your-paperless-api-token"
      PAPERLESS_PUBLIC_URL: "https://docs.example.com"
      # Auth
      MCP_API_KEY: "your-static-token-for-claude-desktop"
      OIDC_INTROSPECTION_URL: "http://authelia:9091/api/oidc/introspection"
      OIDC_CLIENT_ID: "paperless-mcp"
      OIDC_CLIENT_SECRET: "your-oidc-client-secret"
      OAUTH_ISSUER: "https://authelia.example.com"
      MCP_SERVER_URL: "https://mcp.example.com"
    expose:
      - "3000"
    depends_on:
      - webserver
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.paperless-mcp.rule=Host(`mcp.example.com`)
      - traefik.http.routers.paperless-mcp.entrypoints=websecure
      - traefik.http.services.paperless-mcp.loadbalancer.server.port=3000
      - traefik.http.routers.paperless-mcp.tls.certresolver=mydnschallenge
      - traefik.http.routers.paperless-mcp.tls=true
      - traefik.http.routers.paperless-mcp.middlewares=middlewares-rate-limit@file,middlewares-secure-headers@file
    networks:
      - default
      - traefik

networks:
  traefik:
    external: true
```

> **Note:** Do not add `middlewares-authelia@file` to the Traefik labels — auth is handled directly inside the server via OIDC introspection.

### Claude Desktop (stdio)

```json
"paperless": {
  "command": "npx",
  "args": ["-y", "@baruchiro/paperless-mcp@latest"],
  "env": {
    "PAPERLESS_URL": "http://your-paperless-instance:8000",
    "PAPERLESS_API_KEY": "your-api-token"
  }
}
```

## Authentication

The server supports two authentication modes simultaneously:

| Mode | How it works | Use case |
|------|-------------|----------|
| **Static Bearer token** | `Authorization: Bearer <MCP_API_KEY>` | Claude Desktop, direct API clients |
| **OIDC JWT introspection** | Bearer JWT validated via Authelia introspection endpoint | Claude.ai OAuth flow |

If `MCP_API_KEY` is not set, the server accepts all requests (useful for local/trusted network setups).

### Connecting Claude.ai

1. Open Claude.ai → Settings → Connectors → Add custom connector
2. **Remote MCP Server URL**: `https://mcp.example.com/sse`
3. **OAuth Client ID**: your Authelia OIDC client ID (e.g. `paperless-mcp`)
4. **OAuth Client Secret**: your plaintext OIDC client secret

Claude.ai first fetches `/.well-known/oauth-protected-resource` (RFC 9728) to find out which authorization server protects this resource, then fetches `/.well-known/oauth-authorization-server` (RFC 8414) from Authelia to get all OAuth endpoints, and finally redirects through the standard OAuth PKCE flow.

### Authelia OIDC Client

Add a client entry to your Authelia configuration:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: paperless-mcp
        client_name: Paperless MCP
        client_secret: "$pbkdf2-sha512$..."  # bcrypt/pbkdf2 hash
        authorization_policy: one_factor
        token_endpoint_auth_method: client_secret_basic
        redirect_uris:
          - https://claude.ai/oauth/callback
        scopes: [openid, profile, email]
        grant_types: [authorization_code, refresh_token]
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PAPERLESS_URL` | ✓ | Internal URL of your Paperless-NGX instance |
| `PAPERLESS_API_KEY` | ✓ | Paperless-NGX API token |
| `PAPERLESS_PUBLIC_URL` | | Public URL for document links (falls back to `PAPERLESS_URL`) |
| `MCP_API_KEY` | | Static Bearer token for Claude Desktop |
| `OIDC_INTROSPECTION_URL` | | Authelia introspection endpoint (internal URL) |
| `OIDC_CLIENT_ID` | | OIDC client ID registered in Authelia |
| `OIDC_CLIENT_SECRET` | | OIDC client secret (plaintext) |
| `OAUTH_ISSUER` | | Public base URL of your Authelia instance |
| `MCP_SERVER_URL` | | Public URL of this MCP server (e.g. `https://mcp.example.com`) — required for RFC 9728 Protected Resource Metadata |

## Available Tools

### Documents
- `list_documents` — paginated document list
- `get_document` — document by ID
- `search_documents` — full-text search
- `get_document_content` — extracted text content
- `get_document_thumbnail` — thumbnail as base64 WebP
- `download_document` — download original or archived file
- `post_document` — upload a new document
- `update_document` — update document metadata
- `bulk_edit_documents` — bulk operations (tag, correspondent, merge, split, rotate, delete…)

### Tags
- `list_tags`, `create_tag`, `update_tag`, `delete_tag`, `bulk_edit_tags`

### Correspondents
- `list_correspondents`, `get_correspondent`, `create_correspondent`, `update_correspondent`, `delete_correspondent`, `bulk_edit_correspondents`

### Document Types
- `list_document_types`, `get_document_type`, `create_document_type`, `update_document_type`, `delete_document_type`, `bulk_edit_document_types`

### Custom Fields
- `list_custom_fields`, `get_custom_field`, `create_custom_field`, `update_custom_field`, `delete_custom_field`, `bulk_edit_custom_fields`

## Development

```bash
git clone https://github.com/marco2901/paperless-mcp-server.git
cd paperless-mcp-server
npm install
npm run start -- --baseUrl http://localhost:8000 --token your-token --http --port 3000
```

## Credits

- [baruchiro/paperless-mcp](https://github.com/baruchiro/paperless-mcp) — upstream project
- [nloui/paperless-mcp](https://github.com/nloui/paperless-mcp) — original author
