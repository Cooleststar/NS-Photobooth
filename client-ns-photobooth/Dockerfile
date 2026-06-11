FROM node:18-slim

WORKDIR /app

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn .yarn

RUN yarn install --immutable

COPY . .

EXPOSE 3000

CMD ["yarn", "dev", "--host", "--port", "3000"]
