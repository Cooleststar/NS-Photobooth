FROM node:18-slim

WORKDIR /app

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn .yarn

RUN yarn install --immutable

COPY . .

# .env is gitignored, so a fresh clone has none - and without it every
# VITE_ANIM_* value parses as NaN, which does not error: it leaves every
# animation permanently stuck mid-fade, half-transparent. Falling back to
# .env.example gives the real animation timings (they are ordinary config,
# not secrets) and only leaves VITE_IMGBB_API_KEY blank, which the booth
# already handles - photos save locally with no upload.
RUN [ -f .env ] || cp .env.example .env

EXPOSE 3000

CMD ["yarn", "dev", "--host", "--port", "3000"]
