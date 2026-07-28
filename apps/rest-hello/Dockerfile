# No deps, so no npm install step — just copy the source into a slim node image.
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
EXPOSE 3000
CMD ["node", "server.js"]
