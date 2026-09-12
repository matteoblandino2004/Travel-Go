# Travel-Go has no dependencies and no build step, so this is about as simple
# as a Node image gets. Alpine keeps it small; nothing is compiled.
FROM node:22-alpine

WORKDIR /app

# package.json first so the layer caches, even though there's nothing to install.
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Run unprivileged - the node image ships a suitable user.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/reference').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/server.js"]
