# Static-site image for the Anthropic OSS Scanner offline audit.
# Serve the FULL site: every page/asset at repo root (portal.html and privacy.html were missing -> 404 on the Medical Team project, 2026-10-21).
FROM nginx:alpine
COPY *.html *.jpg *.mp4 /usr/share/nginx/html/
# Subdirectories that are part of the public site must be copied explicitly —
# the glob above only matches root-level files (demo/ 404'd on 2026-11-05,
# same root cause as the 2026-10-21 portal/privacy miss).
COPY demo /usr/share/nginx/html/demo/
EXPOSE 80
