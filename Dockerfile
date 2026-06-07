# A Dockerfile is the recipe Docker follows to build your image.
# Each line is a step; Docker caches steps so rebuilds are fast.

# 1. Start FROM an existing image: official Node.js 20, the small "slim" variant.
#    This gives us a Linux machine with Node already installed.
FROM node:20-slim

# 2. Set the working directory inside the container. Everything after this
#    runs relative to /app. Docker creates the folder if it doesn't exist.
WORKDIR /app

# 3. Copy your project files from your Mac into the image (the "." on the left
#    is the build folder, the "." on the right is /app inside the image).
#    .dockerignore controls what gets skipped (node_modules, .git, etc.).
COPY . .

# 4. The server needs no dependencies (zero npm packages), so there's no
#    "npm install" step. It listens on 4040 by default — document that here.
#    EXPOSE is informational; it doesn't actually open the port (we do that at run time).
EXPOSE 4040

# 5. The command Docker runs when the container starts.
#    Same as running `node server/pi-server.js` on your machine.
CMD ["node", "server/pi-server.js"]
