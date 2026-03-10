FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV NODE_ENV=production

CMD ["npm", "run", "start:api"]
