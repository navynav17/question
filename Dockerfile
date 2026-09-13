FROM apify/actor-node-playwright:22

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

CMD ["npm", "start"]
