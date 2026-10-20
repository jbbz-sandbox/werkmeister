# SW-62: Electron (the VS Code test host) exits 127 on stock node:22 for lack of
# its shared libraries and a display. Built into the image so a recreated
# container keeps them; tests run under `xvfb-run -a` (which needs xauth), as in CI.
FROM node:22
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    xvfb xauth libgtk-3-0 libnss3 libgbm1 libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libxss1 libxshmfence1 libx11-xcb1 libsecret-1-0 \
 && rm -rf /var/lib/apt/lists/*
