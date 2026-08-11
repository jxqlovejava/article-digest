FROM tweet-base:latest

ARG HTTPS_PROXY
ARG HTTP_PROXY
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV HTTP_PROXY=${HTTP_PROXY}
ENV http_proxy=${HTTPS_PROXY}
ENV https_proxy=${HTTPS_PROXY}

COPY tsconfig.json ./
ARG CACHEBUST=0
COPY src ./src
COPY scripts ./scripts
COPY public ./public
COPY prompts ./prompts
RUN mkdir -p data/public data/articles data/images data/videos data/avatars
RUN npm run build

CMD ["npm", "start"]
