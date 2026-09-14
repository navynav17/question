FROM apify/actor-node-puppeteer-chrome:24

COPY package*.json ./
RUN npm install --omit=dev

COPY . ./

CMD ["node", "src/actor.js"]
