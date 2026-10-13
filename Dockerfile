# 山海问知：前端构建 + Node 22 后端单进程运行
#
# 版本必须 ≥ 22.16：平台依赖 SQLite 的 FTS5（三字分词）做知识库检索，
# 而 Node 内置的 node:sqlite 在 22.13 及更早的版本里没有编译 FTS5，
# 容器启动时会直接报 “no such module: fts5” 并退出。
# 这里钉到具体版本，避免基础镜像变动导致构出来的镜像跑不起来。
FROM node:22.20-alpine AS web
WORKDIR /app
COPY shared ./shared
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci || npm install
COPY web ./web
RUN cd web && npm run build

FROM node:22.20-alpine
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && (npm ci --omit=dev || npm install --omit=dev)
COPY server ./server
COPY shared ./shared
COPY --from=web /app/web/dist ./web/dist
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/src/index.js"]
