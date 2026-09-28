FROM node:24.21.0-alpine3.24

# The release workflow passes the git tag's version (e.g. 1.0.1); shown in the page footer.
ARG VERSION=dev

ENV CRATE_VERSION=$VERSION \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5178 \
    DATA_DIR=/data

WORKDIR /app

# No npm install: Crate has no dependencies.
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# /data holds collection.json. It's owned by the unprivileged `node` user (uid 1000),
# which a fresh named volume inherits on first mount.
RUN mkdir /data && chown node:node /data
USER node

EXPOSE 5178
CMD ["node", "server.js"]
