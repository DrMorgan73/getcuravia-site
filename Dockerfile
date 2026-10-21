# Static-site image for the Anthropic OSS Scanner offline audit.
# Serve the FULL site: every page/asset at repo root (portal.html and privacy.html were missing -> 404 on the Medical Team project, 2026-10-21).
FROM nginx:alpine
COPY *.html *.jpg *.mp4 /usr/share/nginx/html/
EXPOSE 80
