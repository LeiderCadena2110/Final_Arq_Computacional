# Imagen de la API para el entorno "contenedor con límites estrictos".
# Etapa 1: compilar TypeScript.
FROM node:20-alpine AS compilacion
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Etapa 2: solo lo necesario para ejecutar.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=compilacion /app/node_modules ./node_modules
COPY --from=compilacion /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
