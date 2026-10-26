# Official MCP "everything" reference server, pinned, run in Streamable HTTP mode.
# Third upstream: proves the gateway works with an implementation we didn't write.
FROM node:24.22.1-alpine
RUN npm install -g @modelcontextprotocol/server-everything@2.0.0 && npm cache clean --force
ENV PORT=3001 NODE_ENV=production
EXPOSE 3001
USER node
CMD ["mcp-server-everything", "streamableHttp"]
