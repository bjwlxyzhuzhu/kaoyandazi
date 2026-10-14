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
# 部署默认值（部署平台上设置同名环境变量会覆盖这里）。
# 教师密码只存 scrypt 哈希，明文不进仓库。
ENV DEFAULT_INVITE_CODE=R5k2Wp8M \
    SITE_URL=https://kaoyandazi.app.tokenone.work \
    TEACHER_ACCOUNTS=teacher:scrypt:a749bf84865fe0f4aef15f24924c210a:d92c234aa02731a5d479671a2a6efa28150db83360a1224078a09b88721cf97ac017cc9b5f345858db1e55eddf76f9b31dd722d7823d5de5fb1805237be2fe4b
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
