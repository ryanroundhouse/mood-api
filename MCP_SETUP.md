# SQLite MCP Setup for Mood API

This project includes a Model Context Protocol (MCP) server configuration for SQLite that allows AI assistants like Cursor to directly query and analyze the database.

## Prerequisites

1. **Cursor Pro** subscription (required for MCP support)
2. **mcp-sqlite** package installed globally

## Installation

1. Install the SQLite MCP server:
   ```bash
   pipx install mcp-sqlite
   ```

2. Restart Cursor completely to pick up the project-specific MCP configuration

3. Verify installation:
   - Go to **Cursor Settings → MCP**
   - You should see a "sqlite" server listed with green status
   - The 🔧 tool icon should appear in your chat window

## Configuration Files

- **`.cursor/mcp.json`** - Project-specific MCP configuration (not committed to git)
- **`database-metadata.yml`** - Database schema documentation and custom queries

## Available Tools

The MCP provides these pre-built tools for database analysis:

### Basic Tools
- **sqlite_get_catalog()** - Get complete database structure
- **sqlite_execute(sql)** - Run any custom SQL query

### Custom Analytics Tools
- **user_stats()** - Total users, verified users, subscription breakdown
- **recent_moods()** - Latest 10 mood entries with user info
- **mood_trends(user_id)** - Mood statistics for a specific user
- **subscription_status()** - Overview of all subscription statuses

## Usage Examples

Ask Cursor questions like:

**Basic Database Queries:**
- "What tables are in my database?"
- "Show me the schema of the users table"
- "How many users do I have?"

**Analytics:**
- "Show me user statistics"
- "Get recent mood entries"
- "What's the subscription status breakdown?"
- "Which users have pro subscriptions?"

**Custom Analysis:**
- "What's the average mood score across all users?"
- "Show me unverified users"
- "Find users who haven't logged moods recently"

## Security Notes

- The MCP runs locally and only accesses your local database
- No data is sent to external services
- The `.cursor/` directory is gitignored to prevent committing dev-specific configs

## Troubleshooting

1. **Server not showing up:**
   - Restart Cursor completely
   - Check that `mcp-sqlite` is installed: `which mcp-sqlite`

2. **Database queries failing:**
   - Ensure `database.sqlite` exists in project root
   - Verify database permissions

3. **Custom queries not working:**
   - Check `database-metadata.yml` syntax
   - Restart Cursor after metadata changes

## Customization

To add new custom queries, edit `database-metadata.yml` and add them under the `queries` section. Each query becomes a callable MCP tool. 