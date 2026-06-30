# ── Build stage ──────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
# Only build the frontend — data files are bind-mounted at runtime
RUN npx vite build

# ── Production stage ────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Copy built frontend
COPY --from=build /app/dist ./dist

# Copy server code
COPY server/ ./server/

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

EXPOSE 3001

CMD ["node", "server/index.cjs"]
