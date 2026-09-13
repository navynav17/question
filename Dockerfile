FROM apify/actor-node-playwright-chrome:latest

COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

CMD ["node", "src/actor.js"]
