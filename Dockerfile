FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p data/public data/articles data/images data/videos
RUN npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
