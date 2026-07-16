GitHub upload notes

Files included:
- index.html: the web app
- server.js: required for BoldSign eSign sending/status proxy
- package.json: Node start script

Important:
GitHub Pages can host index.html as a static page, but GitHub Pages cannot run server.js.
The eSign/BoldSign send feature requires server.js or another backend/serverless proxy.

If you only upload index.html to GitHub Pages, the app UI will load, but eSign sending will fail because browsers cannot reliably call BoldSign directly and API keys should not be exposed in browser HTML.
