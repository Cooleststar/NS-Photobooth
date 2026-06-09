FROM node:18-slim

WORKDIR /app

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn .yarn

RUN yarn install --immutable

COPY . .

EXPOSE 5173

CMD ["yarn", "dev", "--host"]
