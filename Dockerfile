FROM ubuntu:24.04

WORKDIR /app

RUN apt-get update && apt-get install -y curl ca-certificates python3 python3-pip python3-venv make g++ && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    python3 -m venv /opt/markitdown && \
    /opt/markitdown/bin/pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
      --trusted-host pypi.tuna.tsinghua.edu.cn 'markitdown==0.1.6' && \
    rm -rf /var/lib/apt/lists/* /root/.cache/pip
ENV MARKITDOWN_PYTHON=/opt/markitdown/bin/python

ARG HTTPS_PROXY
ARG HTTP_PROXY
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV HTTP_PROXY=${HTTP_PROXY}
ENV http_proxy=${HTTPS_PROXY}
ENV https_proxy=${HTTPS_PROXY}
ENV npm_config_proxy=${HTTPS_PROXY}
ENV npm_config_https_proxy=${HTTPS_PROXY}

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
ARG CACHEBUST=0
COPY src ./src
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p data/public data/articles data/images data/videos data/avatars
RUN npm run build

ENV PORT=3000
ENV TZ=Asia/Shanghai
EXPOSE 3000

CMD ["npm", "start"]
