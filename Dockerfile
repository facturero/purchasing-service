FROM node:20-bookworm-slim AS builder
ARG NODE_AUTH_TOKEN
WORKDIR /app
COPY package*.json ./
RUN printf '@facturero:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" > .npmrc \
    && npm ci \
    && rm -f .npmrc
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Debian y no Alpine a propósito: el portal del SRI usa reCAPTCHA Enterprise y
# Chromium (el único navegador que existe para musl) se identifica como «Chromium»,
# no como «Google Chrome». Se instala el binario oficial de Google, que es lo que
# ve un contribuyente real.
FROM node:20-bookworm-slim
ARG NODE_AUTH_TOKEN
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Dependencias de Chrome (las que declara su .deb) + Xvfb para el modo headful +
# fuentes, que también entran en la huella que evalúa el captcha.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget xvfb dbus-x11 xdg-utils \
      fonts-liberation fonts-dejavu-core \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
      libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxrender1 libxss1 \
    && wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && rm -f /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system app \
    && adduser --system --ingroup app --home /home/app --no-create-home app \
    # Perfil de Chrome persistente del portal SRI: el volumen nombrado hereda este
    # dueño al crearse vacío, y el usuario app necesita escribir (cookies, historial).
    && mkdir -p /var/lib/sri-portal-profiles /home/app/Downloads \
    && chown -R app:app /var/lib/sri-portal-profiles /home/app

COPY package*.json ./
RUN printf '@facturero:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$NODE_AUTH_TOKEN" > .npmrc \
    && npm ci --omit=dev && npm cache clean --force \
    && rm -f .npmrc
COPY --from=builder /app/dist/ dist/
COPY migrations/ migrations/
COPY .sequelizerc .sequelizerc
COPY sequelize.config.cjs sequelize.config.cjs
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
# Chrome escribe en $HOME (crashpad, preferencias); con el usuario app sin home escribible
# el navegador arranca a medias.
ENV HOME=/home/app
USER app
EXPOSE 3017
CMD ["node", "dist/main.js"]
