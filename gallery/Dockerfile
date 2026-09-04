FROM node:20-slim

WORKDIR /app

# Unlike client-ns-photobooth, gallery doesn't vendor a yarn binary
# (.yarnrc.yml has no yarnPath) - it relies on Corepack to fetch whichever
# version package.json's "packageManager" pins, but Corepack ships disabled
# by default even though it's bundled with Node 16.9+. Without this, `yarn`
# resolves to the base image's ancient global 1.22.22 instead, which refuses
# to run at all once it sees a "packageManager" field it doesn't understand.
RUN corepack enable

# .yarnrc.yml (nodeLinker: node-modules) has to be present BEFORE install
# runs, not just copied in afterward with everything else - without it here,
# Yarn Berry has no linker config yet and defaults to PnP, producing
# .pnp.cjs instead of node_modules. The real .yarnrc.yml then lands from the
# COPY below saying "use node_modules", but by then nothing ever created
# it - `yarn dev` fails at startup looking for a node_modules state file
# that was never written. Same ordering client-ns-photobooth/Dockerfile
# already uses, for the same reason.
COPY .yarnrc.yml package.json yarn.lock* ./
COPY .yarn .yarn
RUN yarn install --frozen-lockfile

COPY . .

EXPOSE 5173

CMD ["yarn", "dev", "--host"]
