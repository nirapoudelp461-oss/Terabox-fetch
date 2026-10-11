TERABOX FETCHER — NODE.JS HOSTING PACKAGE

WHY YOU SEE HTTP 405
HTTP 405 here means the website is being served by a static host or the wrong service. The /api/fetch route exists in server.js and only works when the Node.js server is running. Opening index.html directly will not start the backend.

DEPLOY THE BACKEND (EASIEST HOSTED OPTION)
1. Extract this ZIP. The files are directly inside the extracted location.
2. Upload the extracted project to a Git repository (GitHub is commonly supported).
3. Create a new Web Service on Render and connect that repository.
4. Build command: npm install
5. Start command: npm start
6. Add environment variable:
   XAPIVERSE_API_KEY = your xAPIverse API key
7. Deploy and wait until the service is live.
8. Open the service's HTTPS URL (not the static index.html URL). The homepage should open from that URL and /health should return {"status":"ok"}.
9. Paste a supported TeraBox link and press Fetch Link.

LOCAL RUN (COMPUTER WITH NODE.JS 20+)
1. Copy .env.example to .env.
2. Put your xAPIverse API key in .env as XAPIVERSE_API_KEY=your_key.
3. In a terminal opened in this folder, run:
   npm install
   npm start
4. Open http://127.0.0.1:3000.

FILES
- index.html: website interface
- server.js: Express backend and /api/fetch route
- package.json: dependencies and start command
- render.yaml: Render deployment blueprint
- .env.example: local configuration template

SECURITY
Keep your API key in the .env file or the hosting provider's environment settings. Do not put it in index.html. If a real key was shared publicly, rotate it.

LIMITATIONS
The resolver follows ordinary redirects and a few common HTML redirect patterns. It cannot bypass CAPTCHA, login pages, or arbitrary JavaScript challenges. Successful fetching also depends on xAPIverse and the supplied link.
