FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && install -d -m 700 -o node -g node /app/data
COPY *.mjs ./
COPY public/ public/
USER node
ENV DATABASE_PATH=/app/data/inbox.sqlite PORT=8787 BIND_ADDRESS=0.0.0.0
EXPOSE 8787
CMD ["node", "server.mjs"]
